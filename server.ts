import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const prSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  repo: z.string(),
  author: z.string(),
  authorAvatarUrl: z.string().nullable(),
  isDraft: z.boolean(),
  createdAt: z.string(),
  requestedAt: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  checks: z.enum(["success", "failure", "pending", "none"]),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "NONE"]),
  requestedVia: z.enum(["you", "team"]),
  requestedTeams: z.array(z.string()),
  fromTeammate: z.boolean(),
});
export type PullRequest = z.infer<typeof prSchema>;

const teamSchema = z.object({
  id: z.string(),
  org: z.string(),
  name: z.string(),
  members: z.number(),
});
export type Team = z.infer<typeof teamSchema>;

const teamIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[\w.-]+\/[\w.-]+$/);

const snapshotSchema = z.object({
  login: z.string().nullable(),
  teams: z.array(z.string()),
  availableTeams: z.array(teamSchema),
  teamMaxAgeDays: z.number().nullable(),
  hiddenTeamRequests: z.number(),
  teammateCount: z.number(),
  fetchedAt: z.string().nullable(),
  error: z.string().nullable(),
  refreshing: z.boolean(),
  pullRequests: z.array(prSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  queue_get: { input: z.null(), output: snapshotSchema },
  queue_refresh: { input: z.null(), output: snapshotSchema },
  team_age_set: {
    input: z.object({ days: z.number().int().min(1).max(3650).nullable() }),
    output: snapshotSchema,
  },
  teams_set: {
    input: z.object({ teams: z.array(teamIdSchema).max(20) }),
    output: snapshotSchema,
  },
});

export const QUEUE_CHANGED = "queue-changed";

const SEARCH_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        id number title url isDraft createdAt additions deletions reviewDecision
        repository { nameWithOwner }
        author { login avatarUrl }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewRequests(first: 30) {
          nodes { requestedReviewer {
            __typename
            ... on User { login }
            ... on Team { slug organization { login } }
          } }
        }
        timelineItems(itemTypes: REVIEW_REQUESTED_EVENT, last: 15) {
          nodes { ... on ReviewRequestedEvent {
            createdAt
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug organization { login } }
            }
          } }
        }
      }
    }
  }
}`;

type Reviewer =
  | { __typename: "User"; login: string }
  | { __typename: "Team"; slug: string; organization: { login: string } }
  | { __typename: string };

type RawPr = {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  repository: { nameWithOwner: string };
  author: { login: string; avatarUrl: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  reviewRequests: { nodes: { requestedReviewer: Reviewer | null }[] };
  timelineItems: { nodes: { createdAt?: string; requestedReviewer?: Reviewer | null }[] };
};

function reviewerKey(reviewer: Reviewer | null | undefined): string | null {
  if (!reviewer) return null;
  if ("login" in reviewer) return `user:${reviewer.login.toLowerCase()}`;
  if ("slug" in reviewer)
    return `team:${reviewer.organization.login.toLowerCase()}/${reviewer.slug.toLowerCase()}`;
  return null;
}

function checksState(raw: RawPr): PullRequest["checks"] {
  const state = raw.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (state === undefined || state === null) return "none";
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  return "pending";
}

// The bb server can start without a login shell PATH, so look in the usual
// install locations before falling back to plain "gh".
function resolveGh(): string {
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "gh";
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    includeTeamRequests: {
      type: "boolean",
      label: "Show team requests from teammates",
      description:
        "Also list PRs where review was requested from one of your selected teams, not from you by name.",
      default: true,
    },
    includeDrafts: {
      type: "boolean",
      label: "Include draft PRs",
      default: false,
    },
    refreshMinutes: {
      type: "number",
      label: "Refresh interval (minutes)",
      default: 5,
    },
  });
  const config = await settings.get();
  let teams: string[] = (await bb.storage.kv.get<string[]>("teams")) ?? [];
  const storedAge = await bb.storage.kv.get<number | null>("teamMaxAgeDays");
  let teamMaxAgeDays: number | null = storedAge === undefined ? 30 : storedAge;
  const refreshMs = Math.max(1, Number(config.refreshMinutes) || 5) * 60_000;
  const ghPath = resolveGh();

  function gh(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        ghPath,
        args,
        { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim() || error.message;
            reject(new Error(`gh ${args[0]} failed: ${detail}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  async function searchPrs(query: string): Promise<RawPr[]> {
    const out = await gh(["api", "graphql", "-f", `query=${SEARCH_QUERY}`, "-f", `q=${query}`]);
    const parsed = JSON.parse(out) as { data: { search: { nodes: Partial<RawPr>[] } } };
    return parsed.data.search.nodes.filter((node): node is RawPr => typeof node.id === "string");
  }

  async function teamMembers(team: string): Promise<string[]> {
    const [org, slug] = team.split("/");
    const out = await gh([
      "api",
      "--paginate",
      `orgs/${org}/teams/${slug}/members`,
      "--jq",
      ".[].login",
    ]);
    return out
      .split("\n")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean);
  }

  async function myTeams(): Promise<Team[]> {
    const out = await gh([
      "api",
      "--paginate",
      "user/teams",
      "--jq",
      ".[] | {org: .organization.login, slug, name, members: .members_count}",
    ]);
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const raw = JSON.parse(line) as { org: string; slug: string; name: string; members: number };
        return {
          id: `${raw.org}/${raw.slug}`.toLowerCase(),
          org: raw.org,
          name: raw.name,
          members: raw.members,
        };
      })
      .sort((a, b) => a.members - b.members || a.id.localeCompare(b.id));
  }

  let snapshot: Snapshot = {
    login: null,
    availableTeams: [],
    hiddenTeamRequests: 0,
    teammateCount: 0,
    fetchedAt: null,
    error: null,
    pullRequests: [],
    ...((await bb.storage.kv.get<Snapshot>("snapshot")) ?? {}),
    teams,
    teamMaxAgeDays,
    refreshing: false,
  };

  function publish(next: Snapshot) {
    snapshot = next;
    bb.realtime.publish(QUEUE_CHANGED, { count: next.pullRequests.length });
  }

  async function fetchQueue(): Promise<Snapshot> {
    const login = (await gh(["api", "user", "--jq", ".login"])).trim();
    const me = login.toLowerCase();
    const myKey = `user:${me}`;
    const draft = config.includeDrafts ? "" : " draft:false";
    const base = `is:pr is:open archived:false -author:@me${draft}`;

    const availableTeams = await myTeams().catch((error: unknown) => {
      bb.log.warn(`team list lookup failed: ${String(error)}`);
      return snapshot.availableTeams;
    });
    const memberLists = await Promise.all(
      teams.map((team) =>
        teamMembers(team).catch((error: unknown) => {
          bb.log.warn(`team members lookup failed for ${team}: ${String(error)}`);
          return [] as string[];
        }),
      ),
    );
    const teammates = new Set(memberLists.flat());
    teammates.delete(me);

    // Search per selected team: review-requested:@me also matches every team
    // you belong to (Developers has 66 people) and makes GitHub answer 502.
    const [direct, teamResults] = await Promise.all([
      searchPrs(`${base} user-review-requested:@me`),
      config.includeTeamRequests
        ? Promise.all(teams.map((team) => searchPrs(`${base} team-review-requested:${team} sort:updated-desc`)))
        : Promise.resolve([]),
    ]);

    const directIds = new Set(direct.map((pr) => pr.id));
    const teamKeys = new Set(teams.map((team) => `team:${team}`));
    const anyRequest = [...new Map(teamResults.flat().map((pr) => [pr.id, pr])).values()];

    function toPr(raw: RawPr, requestedVia: "you" | "team"): PullRequest {
      const author = raw.author?.login ?? "ghost";
      const requested = raw.reviewRequests.nodes
        .map((node) => reviewerKey(node.requestedReviewer))
        .filter((key): key is string => key !== null);
      const requestedTeams = [
        ...new Set(
          requested
            .filter((key) => key.startsWith("team:"))
            .map((key) => key.slice("team:".length)),
        ),
      ];
      const relevant =
        requestedVia === "you"
          ? new Set([myKey])
          : teamKeys;
      const events = raw.timelineItems.nodes.filter(
        (event) =>
          event.createdAt !== undefined &&
          relevant.has(reviewerKey(event.requestedReviewer) ?? ""),
      );
      const decision = raw.reviewDecision ?? "NONE";
      return {
        id: raw.id,
        number: raw.number,
        title: raw.title,
        url: raw.url,
        repo: raw.repository.nameWithOwner,
        author,
        authorAvatarUrl: raw.author?.avatarUrl ?? null,
        isDraft: raw.isDraft,
        createdAt: raw.createdAt,
        requestedAt: events.at(-1)?.createdAt ?? null,
        additions: raw.additions,
        deletions: raw.deletions,
        checks: checksState(raw),
        reviewDecision: (["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(decision)
          ? decision
          : "NONE") as PullRequest["reviewDecision"],
        requestedVia,
        requestedTeams,
        fromTeammate: teammates.has(author.toLowerCase()),
      };
    }

    const teamOnly = anyRequest
      .filter((raw) => !directIds.has(raw.id))
      .map((raw) => toPr(raw, "team"))
      .filter((pr) => pr.requestedTeams.some((team) => teamKeys.has(`team:${team}`)));
    const cutoff =
      teamMaxAgeDays === null ? null : Date.now() - teamMaxAgeDays * 24 * 60 * 60 * 1000;
    const recentTeamOnly =
      cutoff === null
        ? teamOnly
        : teamOnly.filter((pr) => new Date(pr.requestedAt ?? pr.createdAt).getTime() >= cutoff);

    return {
      login,
      teams,
      availableTeams,
      teamMaxAgeDays,
      hiddenTeamRequests: teamOnly.length - recentTeamOnly.length,
      teammateCount: teammates.size,
      fetchedAt: new Date().toISOString(),
      error: null,
      refreshing: false,
      pullRequests: [...direct.map((raw) => toPr(raw, "you")), ...recentTeamOnly],
    };
  }

  let inFlight: Promise<Snapshot> | null = null;

  function refresh(): Promise<Snapshot> {
    if (inFlight) return inFlight;
    publish({ ...snapshot, refreshing: true });
    inFlight = fetchQueue()
      .catch((error: unknown): Snapshot => {
        bb.log.error(`refresh failed: ${String(error)}`);
        return {
          ...snapshot,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .then(async (next) => {
        await bb.storage.kv.set("snapshot", next);
        publish(next);
        return next;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function setTeams(next: string[]): Promise<Snapshot> {
    teams = [...new Set(next)];
    await bb.storage.kv.set("teams", teams);
    publish({ ...snapshot, teams });
    if (inFlight) await inFlight;
    return refresh();
  }

  async function setTeamAge(days: number | null): Promise<Snapshot> {
    teamMaxAgeDays = days;
    await bb.storage.kv.set("teamMaxAgeDays", days);
    publish({ ...snapshot, teamMaxAgeDays: days });
    if (inFlight) await inFlight;
    return refresh();
  }

  bb.rpc.register(rpcContract, {
    queue_get: async () => snapshot,
    queue_refresh: () => refresh(),
    teams_set: ({ teams: next }) => setTeams(next),
    team_age_set: ({ days }) => setTeamAge(days),
  });

  bb.background.service("poll", {
    async start(signal) {
      while (!signal.aborted) {
        await refresh();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, refreshMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  const usage = [
    "Usage:",
    "  bb review-queue [list] [--json]   Show open PRs waiting for your review",
    "  bb review-queue refresh [--json]  Fetch from GitHub now, then show the queue",
    "  bb review-queue teams [--json]    List your GitHub teams; [x] marks your team",
    "  bb review-queue teams set <org/slug>[,<org/slug>...]  Choose your team (use \"\" to clear)",
    "  bb review-queue team-age <days|all>  Hide team review requests older than <days>",
  ].join("\n");

  function formatPr(pr: PullRequest): string {
    const via = pr.requestedVia === "team" ? ` (via ${pr.requestedTeams.join(", ")})` : "";
    return `${pr.repo}#${pr.number}  ${pr.title}  by @${pr.author}${via}  ${pr.url}`;
  }

  function formatSnapshot(snap: Snapshot): string {
    const groups: [string, PullRequest[]][] = [
      [
        "From your team",
        snap.pullRequests.filter((pr) => pr.requestedVia === "you" && pr.fromTeammate),
      ],
      [
        "From others",
        snap.pullRequests.filter((pr) => pr.requestedVia === "you" && !pr.fromTeammate),
      ],
      [
        "Team review requests",
        snap.pullRequests.filter((pr) => pr.requestedVia === "team"),
      ],
    ];
    const lines = [`Fetched ${snap.fetchedAt ?? "never"} for @${snap.login ?? "?"}`];
    if (snap.error) lines.push(`Error: ${snap.error}`);
    for (const [title, prs] of groups) {
      lines.push("", `${title} (${prs.length})`);
      for (const pr of prs.slice(0, 50)) lines.push(`  ${formatPr(pr)}`);
    }
    if (snap.hiddenTeamRequests > 0)
      lines.push(
        `  (${snap.hiddenTeamRequests} older than ${snap.teamMaxAgeDays} days hidden; bb review-queue team-age all shows them)`,
      );
    return lines.join("\n");
  }

  bb.cli.register({
    name: "review-queue",
    summary: "List open GitHub PRs waiting for your review",
    commands: [
      {
        name: "list",
        summary: "Show the cached review queue",
        usage: "bb review-queue list [--json]",
      },
      {
        name: "team-age",
        summary: "Hide team review requests waiting longer than <days>, or show all",
        usage: "bb review-queue team-age <days|all> [--json]",
      },
      {
        name: "teams",
        summary: "List your GitHub teams, or choose which count as your team",
        usage: "bb review-queue teams [set <org/slug>[,<org/slug>...]] [--json]",
      },
      {
        name: "refresh",
        summary: "Fetch from GitHub now, then show the queue",
        usage: "bb review-queue refresh [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      if (command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      if (command === "team-age") {
        const value = args[0];
        const days = value === "all" ? null : Number(value);
        if (args.length !== 1 || (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)))
          return { exitCode: 1, stderr: usage };
        const snap = await setTeamAge(days);
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(snap) : formatSnapshot(snap),
        };
      }
      if (command === "teams") {
        let snap = snapshot;
        if (args[0] === "set") {
          const parsed = z
            .array(teamIdSchema)
            .safeParse(args.slice(1).join(",").split(/[\s,]+/).filter(Boolean));
          if (!parsed.success) return { exitCode: 1, stderr: usage };
          snap = await setTeams(parsed.data);
        } else if (args.length > 0) {
          return { exitCode: 1, stderr: usage };
        } else if (snap.availableTeams.length === 0) {
          snap = await refresh();
        }
        const selected = new Set(snap.teams);
        const text = snap.availableTeams
          .map((team) => `[${selected.has(team.id) ? "x" : " "}] ${team.id}  ${team.name} (${team.members})`)
          .join("\n");
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ teams: snap.teams, availableTeams: snap.availableTeams })
            : text || "No GitHub teams found.",
        };
      }
      if (command !== undefined && command !== "list" && command !== "refresh")
        return { exitCode: 1, stderr: usage };
      const snap = command === "refresh" ? await refresh() : snapshot;
      return {
        exitCode: snap.error !== null && snap.fetchedAt === null ? 1 : 0,
        stdout: json ? JSON.stringify(snap) : formatSnapshot(snap),
      };
    },
  });
}
