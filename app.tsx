import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  UrlLink,
  definePluginApp,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
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

function oldestFirst(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => waitingSince(a).localeCompare(waitingSince(b)));
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
      hint: "Your review is requested directly.",
      prs: oldestFirst(prs.filter((pr) => pr.requestedVia === "you" && pr.fromTeammate)),
    },
    {
      id: "others",
      title: "From others",
      hint: "Your review is requested directly.",
      prs: oldestFirst(prs.filter((pr) => pr.requestedVia === "you" && !pr.fromTeammate)),
    },
    {
      id: "team-requests",
      title: "Team review requests",
      hint:
        snapshot.hiddenTeamRequests > 0
          ? `Requested from your selected teams, any author. ${snapshot.hiddenTeamRequests} older hidden.`
          : "Requested from your selected teams, any author.",
      prs: oldestFirst(prs.filter((pr) => pr.requestedVia === "team")),
    },
  ];
}

function ChecksIcon({ checks }: { checks: PullRequest["checks"] }) {
  if (checks === "none") return null;
  const map = {
    success: { name: "CircleCheck", className: "text-emerald-500", label: "Checks passed" },
    failure: { name: "CircleX", className: "text-destructive", label: "Checks failed" },
    pending: { name: "CircleDashed", className: "text-amber-500", label: "Checks running" },
  } as const;
  const { name, className, label } = map[checks];
  return (
    <span title={label} aria-label={label} className="inline-flex">
      <Icon name={name} className={cn("size-3.5", className)} />
    </span>
  );
}

function DecisionTag({ decision }: { decision: PullRequest["reviewDecision"] }) {
  if (decision === "APPROVED")
    return <Tag className="text-emerald-600 dark:text-emerald-400">Approved</Tag>;
  if (decision === "CHANGES_REQUESTED")
    return <Tag className="text-destructive">Changes requested</Tag>;
  return null;
}

function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded border border-border px-1.5 py-px text-[11px] leading-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const since = waitingSince(pr);
  const stale = now - new Date(since).getTime() > DAY_MS;
  return (
    <li className="flex items-start gap-3 py-3">
      {pr.authorAvatarUrl ? (
        <img
          src={pr.authorAvatarUrl}
          alt=""
          className="mt-0.5 size-7 shrink-0 rounded-full border border-border"
        />
      ) : (
        <div className="mt-0.5 size-7 shrink-0 rounded-full bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <UrlLink
          href={pr.url}
          className="line-clamp-2 text-sm font-medium text-foreground hover:underline"
        >
          {pr.title}
        </UrlLink>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">
            {pr.repo.split("/")[1]}#{pr.number}
          </span>
          <span>@{pr.author}</span>
          <span>
            <span className="text-emerald-600 dark:text-emerald-400">+{pr.additions}</span>{" "}
            <span className="text-destructive">−{pr.deletions}</span>
          </span>
          <ChecksIcon checks={pr.checks} />
          <DecisionTag decision={pr.reviewDecision} />
          {pr.isDraft ? <Tag>Draft</Tag> : null}
          {pr.requestedVia === "team" && pr.requestedTeams.length > 0 ? (
            <Tag>via {pr.requestedTeams.map((team) => team.split("/")[1]).join(", ")}</Tag>
          ) : null}
        </div>
      </div>
      <span
        title={`Waiting since ${new Date(since).toLocaleString()}`}
        className={cn(
          "shrink-0 tabular-nums text-xs",
          stale ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        )}
      >
        {age(since, now)}
      </span>
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

function QueuePage() {
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
  const direct = snapshot.pullRequests.filter((pr) => pr.requestedVia === "you");
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
