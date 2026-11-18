import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  UrlLink,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { PrReviewPage, parsePrSubPath } from "./pr-review";
import type { PullRequest, Snapshot, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

function useQueue() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (method: "queue_get" | "queue_refresh") => {
      rpc.call(method).then(
        (next) => {
          setSnapshot(next);
          setError(null);
        },
        (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [rpc],
  );
  useEffect(() => load("queue_get"), [load]);
  useRealtime("queue-changed", () => load("queue_get"));
  const refresh = useCallback(() => load("queue_refresh"), [load]);
  const setTeams = useCallback(
    (teams: string[]) => {
      setSnapshot((current) => (current ? { ...current, teams } : current));
      rpc.call("teams_set", { teams }).then(
        (next) => {
          setSnapshot(next);
          setError(null);
        },
        (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [rpc],
  );
  const setTeamAge = useCallback(
    (days: number | null) => {
      setSnapshot((current) => (current ? { ...current, teamMaxAgeDays: days } : current));
      rpc.call("team_age_set", { days }).then(
        (next) => {
          setSnapshot(next);
          setError(null);
        },
        (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [rpc],
  );
  return { snapshot, error, refresh, setTeams, setTeamAge };
}

function TeamPicker({
  snapshot,
  onChange,
}: {
  snapshot: Snapshot;
  onChange: (teams: string[]) => void;
}) {
  const selected = new Set(snapshot.teams);
  if (snapshot.availableTeams.length === 0) return null;
  const orgCounts = new Map<string, number>();
  for (const team of snapshot.availableTeams)
    orgCounts.set(team.org, (orgCounts.get(team.org) ?? 0) + 1);
  const primaryOrg = [...orgCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">Your team:</span>
      {snapshot.availableTeams.map((team) => {
        const on = selected.has(team.id);
        return (
          <button
            key={team.id}
            type="button"
            aria-pressed={on}
            title={`${team.id}, ${team.members} members`}
            onClick={() =>
              onChange(on ? snapshot.teams.filter((id) => id !== team.id) : [...snapshot.teams, team.id])
            }
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              on
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {team.org !== primaryOrg ? `${team.org}/` : ""}
            {team.name}
            <span className="ml-1 tabular-nums opacity-70">{team.members}</span>
          </button>
        );
      })}
    </div>
  );
}

function waitingSince(pr: PullRequest): string {
  return pr.requestedAt ?? pr.createdAt;
}

function age(iso: string, now: number): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function newestFirst(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => waitingSince(b).localeCompare(waitingSince(a)));
}

const AGE_OPTIONS: { label: string; days: number | null }[] = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: null },
];

function AgeFilter({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (days: number | null) => void;
}) {
  return (
    <div role="group" aria-label="Hide requests older than" className="ml-auto flex gap-0.5">
      {AGE_OPTIONS.map((option) => {
        const on = option.days === value;
        return (
          <button
            key={option.label}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.days)}
            className={cn(
              "rounded px-1.5 py-px text-[11px] transition-colors",
              on
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function sections(snapshot: Snapshot) {
  const prs = snapshot.pullRequests;
  return [
    {
      id: "team",
      title: "From your team",
      hint: "Requested from you by name, or new commits since your review.",
      prs: newestFirst(prs.filter((pr) => pr.requestedVia !== "team" && pr.fromTeammate)),
    },
    {
      id: "others",
      title: "From others",
      hint: "Requested from you by name, or new commits since your review.",
      prs: newestFirst(prs.filter((pr) => pr.requestedVia !== "team" && !pr.fromTeammate)),
    },
    {
      id: "team-requests",
      title: "Team review requests",
      hint:
        snapshot.hiddenTeamRequests > 0
          ? `Requested from your selected teams, any author. ${snapshot.hiddenTeamRequests} older hidden.`
          : "Requested from your selected teams, any author.",
      prs: newestFirst(prs.filter((pr) => pr.requestedVia === "team")),
    },
  ];
}

const STALE_DAYS = 5;

function sizeLabel(pr: PullRequest): string {
  const lines = pr.additions + pr.deletions;
  if (lines < 10) return "XS";
  if (lines < 50) return "S";
  if (lines < 250) return "M";
  if (lines < 1000) return "L";
  return "XL";
}

function compact(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(value);
}

type ChipTone = "neutral" | "good" | "bad" | "warn" | "info";

function Chip({ tone = "neutral", icon, children }: { tone?: ChipTone; icon?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] leading-4",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "good" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "info" && "bg-sky-500/10 text-sky-700 dark:text-sky-400",
      )}
    >
      {icon ? <Icon name={icon} className="size-3" /> : null}
      {children}
    </span>
  );
}

function PrChips({ pr, now }: { pr: PullRequest; now: number }) {
  const staleDays = Math.floor((now - new Date(pr.updatedAt ?? pr.createdAt).getTime()) / DAY_MS);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {pr.requestedVia === "rereview" ? (
        <Chip tone="info" icon="RotateCcw">
          New commits since your {pr.myLastReview === "APPROVED" ? "approval" : "review"}
        </Chip>
      ) : pr.myLastReview ? (
        <Chip tone="info" icon="RotateCcw">
          Re-review
        </Chip>
      ) : null}
      {pr.isDraft ? <Chip>Draft</Chip> : null}
      {pr.conflicts ? (
        <Chip tone="bad" icon="TriangleAlert">
          Conflicts
        </Chip>
      ) : null}
      {pr.checks === "success" ? (
        <Chip tone="good" icon="Check">
          CI
        </Chip>
      ) : pr.checks === "failure" ? (
        <Chip tone="bad" icon="X">
          CI
        </Chip>
      ) : pr.checks === "pending" ? (
        <Chip tone="warn" icon="CircleDashed">
          CI
        </Chip>
      ) : null}
      {pr.reviewDecision === "CHANGES_REQUESTED" ? (
        <Chip tone="bad">Changes requested</Chip>
      ) : (pr.approvals ?? 0) > 0 ? (
        <Chip tone="good" icon="Check">
          {pr.approvals} approved
        </Chip>
      ) : (
        <Chip>No approvals</Chip>
      )}
      {staleDays >= STALE_DAYS ? (
        <Chip icon="Hourglass">Stale {staleDays}d</Chip>
      ) : null}
      {pr.requestedVia === "team" && pr.requestedTeams.length > 0 ? (
        <Chip>via {pr.requestedTeams.map((team) => team.split("/")[1]).join(", ")}</Chip>
      ) : null}
    </div>
  );
}

function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const since = waitingSince(pr);
  const stale = now - new Date(since).getTime() > DAY_MS;
  const navigate = useBbNavigate();
  const openInBb = () => navigate.toPluginPanel("queue", { subPath: `pr/${pr.repo}/${pr.number}` });
  const files = pr.changedFiles ?? 0;
  return (
    <li
      className={cn(
        "py-3",
        pr.requestedVia === "rereview" && "-ml-3 border-l-2 border-sky-500 pl-2.5",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate font-mono">
          {pr.repo.split("/")[1]} #{pr.number}
        </span>
        <span aria-hidden>·</span>
        {pr.authorAvatarUrl ? (
          <img src={pr.authorAvatarUrl} alt="" className="size-4 shrink-0 rounded-full" />
        ) : null}
        <span className="truncate">{pr.author}</span>
        <span aria-hidden>·</span>
        <span
          title={`Waiting since ${new Date(since).toLocaleString()}`}
          className={cn(
            "shrink-0 tabular-nums",
            stale && "font-medium text-amber-600 dark:text-amber-400",
          )}
        >
          {age(since, now)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
          <span className="rounded border border-border px-1 text-[10px] font-medium">
            {sizeLabel(pr)}
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">+{compact(pr.additions)}</span>
          <span className="text-destructive">−{compact(pr.deletions)}</span>
          {files > 0 ? <span>{files === 1 ? "1 file" : `${files} files`}</span> : null}
        </span>
      </div>
      <button
        type="button"
        onClick={openInBb}
        className="mt-0.5 line-clamp-2 text-left text-sm font-medium leading-snug text-foreground hover:underline"
      >
        {pr.title}
      </button>
      {pr.excerpt ? (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{pr.excerpt}</p>
      ) : null}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <PrChips pr={pr} now={now} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={openInBb}
            aria-label={`Review ${pr.repo}#${pr.number} in bb`}
          >
            <Icon name="FileDiff" className="size-3.5" />
            Review
          </Button>
          <UrlLink
            href={pr.url}
            title="Open on GitHub"
            aria-label={`Open ${pr.repo}#${pr.number} on GitHub`}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="ExternalLink" className="size-3.5" />
          </UrlLink>
        </div>
      </div>
    </li>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function RefreshButton() {
  const { snapshot, refresh } = useQueue();
  const busy = snapshot?.refreshing ?? false;
  return (
    <Button variant="ghost" size="sm" onClick={refresh} disabled={busy}>
      <Icon name="RefreshCw" className={cn("size-4", busy && "animate-spin")} />
      Refresh
    </Button>
  );
}

function QueuePage({ subPath }: { subPath: string }) {
  const pr = parsePrSubPath(subPath);
  if (pr) return <PrReviewPage key={`${pr.repo}#${pr.number}`} repo={pr.repo} number={pr.number} />;
  return <QueueList />;
}

function QueueList() {
  const { snapshot, error, setTeams, setTeamAge } = useQueue();
  const now = useNow();
  const shownError = error ?? snapshot?.error ?? null;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-[1600px] space-y-4 p-4 md:p-5">
        <p className="text-xs text-muted-foreground">
          {snapshot?.login ? `@${snapshot.login}` : "Loading…"}
          {snapshot && snapshot.teams.length > 0
            ? ` · ${snapshot.teammateCount} teammates`
            : ""}
          {snapshot?.fetchedAt ? ` · updated ${age(snapshot.fetchedAt, now)} ago` : ""}
        </p>
        {snapshot ? <TeamPicker snapshot={snapshot} onChange={setTeams} /> : null}
        {snapshot && snapshot.availableTeams.length > 0 && snapshot.teams.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Pick one or more teams above to fill the team columns.
          </p>
        ) : null}
        {shownError ? (
          <p role="alert" className="text-sm text-destructive">
            {shownError}
          </p>
        ) : null}
        {snapshot === null || (snapshot.fetchedAt === null && snapshot.refreshing) ? (
          <EmptyState>Fetching pull requests from GitHub…</EmptyState>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            {sections(snapshot).map((section) => (
              <section key={section.id} className="min-w-0">
                <div className="mb-2">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-sm font-semibold">{section.title}</h2>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {section.prs.length}
                    </span>
                    {section.id === "team-requests" ? (
                      <AgeFilter value={snapshot.teamMaxAgeDays} onChange={setTeamAge} />
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{section.hint}</p>
                </div>
                {section.prs.length === 0 ? (
                  <EmptyState>Nothing waiting.</EmptyState>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border bg-card px-3">
                    {section.prs.map((pr) => (
                      <PrRow key={pr.id} pr={pr} now={now} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function useQueueBadge() {
  const { snapshot } = useQueue();
  const now = useNow();
  if (!snapshot) return null;
  const direct = snapshot.pullRequests.filter((pr) => pr.requestedVia !== "team");
  if (direct.length === 0) return null;
  const stale = direct.some((pr) => now - new Date(waitingSince(pr)).getTime() > DAY_MS);
  return {
    count: direct.length,
    tone: stale ? ("warning" as const) : ("neutral" as const),
    label: `${direct.length} PRs waiting for your review`,
  };
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "queue",
    title: "Review queue",
    icon: "GitPullRequest",
    path: "queue",
    component: QueuePage,
    headerContent: RefreshButton,
    experimental_useBadge: useQueueBadge,
  });
});
