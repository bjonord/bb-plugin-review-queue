import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Markdown,
  UrlLink,
  experimental_Diff as Diff,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PrDetail, PrFile, ReviewEvent, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const COLLAPSE_ALL_ABOVE = 25;

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: "You approved",
  CHANGES_REQUESTED: "You requested changes",
  DISMISSED: "Your review was dismissed",
};

function FileDiff({
  file,
  view,
  initiallyOpen,
}: {
  file: PrFile;
  view: "unified" | "split";
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {file.previousPath && file.previousPath !== file.path
            ? `${file.previousPath} → ${file.path}`
            : file.path}
        </span>
        {file.status !== "modified" ? (
          <span className="shrink-0 text-muted-foreground">{file.status}</span>
        ) : null}
        <span className="shrink-0 tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-border">
          {file.patch ? (
            <Diff patch={file.patch} path={file.path} view={view} />
          ) : (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              GitHub shows no diff for this file (binary, or too large).
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ReviewBox({
  detail,
  onDone,
}: {
  detail: PrDetail;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<ReviewEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ state: string; url: string } | null>(null);
  const navigate = useBbNavigate();
  const submit = (event: ReviewEvent) => {
    if (pending) return;
    setPending(event);
    setError(null);
    setSent(null);
    rpc
      .call("pr_review", {
        repo: detail.repo,
        number: detail.number,
        event,
        body,
        headSha: detail.headSha,
      })
      .then(
        (result) => {
          setBody("");
          if (event === "APPROVE") {
            // Inline styles, because the toast renders in bb's portal where this
            // plugin's Tailwind classes do not apply.
            toast.success(`Approved ${detail.repo}#${detail.number}`, {
              richColors: true,
              style: { background: "#15803d", borderColor: "#15803d", color: "#ffffff" },
              actionButtonStyle: { background: "#ffffff", color: "#15803d" },
              action: { label: "View", onClick: () => navigate.openUrl(result.url) },
            });
            navigate.toPluginPanel("queue");
            return;
          }
          setSent(result);
          onDone();
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setPending(null));
  };
  const needsBody = body.trim() === "";
  return (
    <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:px-5">
      <div className="mx-auto max-w-[1600px] space-y-2">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Leave a comment (needed for Request changes and Comment)"
          aria-label="Review comment"
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => submit("APPROVE")}
            disabled={pending !== null || sent?.state === "APPROVED"}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <Icon name="Check" className="size-4" />
            {pending === "APPROVE" ? "Approving…" : sent?.state === "APPROVED" ? "Approved" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => submit("REQUEST_CHANGES")}
            disabled={pending !== null || needsBody}
            className="text-destructive"
          >
            <Icon name="FileX" className="size-4" />
            {pending === "REQUEST_CHANGES" ? "Sending…" : "Request changes"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => submit("COMMENT")}
            disabled={pending !== null || needsBody}
          >
            <Icon name="MessageSquare" className="size-4" />
            {pending === "COMMENT" ? "Sending…" : "Comment"}
          </Button>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            on {detail.headSha.slice(0, 7)}
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {sent ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
          >
            <Icon name="CircleCheck" className="size-4" />
            {sent.state === "APPROVED"
              ? "Approved on GitHub."
              : sent.state === "CHANGES_REQUESTED"
                ? "Changes requested on GitHub."
                : "Comment posted on GitHub."}
            <UrlLink href={sent.url} className="underline">
              View review
            </UrlLink>
            <button
              type="button"
              onClick={() => navigate.toPluginPanel("queue")}
              className="ml-auto text-xs underline"
            >
              Back to queue
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function PrReviewPage({ repo, number }: { repo: string; number: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"unified" | "split">("unified");

  const load = useCallback(() => {
    rpc.call("pr_detail", { repo, number }).then(
      (next) => {
        setDetail(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, repo, number]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  const back = () => navigate.toPluginPanel("queue");

  const additions = detail?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = detail?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const reviewLabel = detail?.myReview ? REVIEW_LABEL[detail.myReview] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-[1600px] space-y-4 p-4 md:p-5">
          <button
            type="button"
            onClick={back}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Icon name="ArrowLeft" className="size-3.5" />
            Review queue
          </button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {detail === null ? (
            error ? null : (
              <p role="status" className="text-sm text-muted-foreground">
                Loading {repo}#{number}…
              </p>
            )
          ) : (
            <>
              <header className="space-y-1">
                <h1 className="text-lg font-semibold leading-snug">{detail.title}</h1>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <span className="font-mono">
                    {detail.repo}#{detail.number}
                  </span>
                  <span>@{detail.author}</span>
                  <span
                    className="max-w-[28rem] truncate rounded bg-muted px-1.5 py-px font-mono text-[11px]"
                    title={`${detail.headRef} → ${detail.baseRef}`}
                  >
                    {detail.headRef} → {detail.baseRef}
                  </span>
                  <span>
                    {detail.files.length} files{" "}
                    <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
                    <span className="text-destructive">−{deletions}</span>
                  </span>
                  {reviewLabel ? (
                    <span className="rounded border border-border px-1.5 py-px text-foreground">
                      {reviewLabel}
                    </span>
                  ) : null}
                  {detail.state !== "open" ? (
                    <span className="rounded border border-border px-1.5 py-px">{detail.state}</span>
                  ) : null}
                  <UrlLink href={detail.url} className="ml-auto flex items-center gap-1 hover:text-foreground">
                    Open on GitHub
                    <Icon name="ExternalLink" className="size-3" />
                  </UrlLink>
                </div>
              </header>
              {detail.body.trim() !== "" ? (
                <details open className="rounded-lg border border-border bg-card px-4 py-3">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                    Description
                  </summary>
                  <Markdown content={detail.body} className="mt-2 text-sm" />
                </details>
              ) : null}
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Changes</h2>
                <div role="group" aria-label="Diff layout" className="ml-auto flex gap-0.5">
                  {(["unified", "split"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={view === option}
                      onClick={() => setView(option)}
                      className={cn(
                        "rounded px-2 py-0.5 text-xs capitalize",
                        view === option
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                {detail.files.map((file) => (
                  <FileDiff
                    key={file.path}
                    file={file}
                    view={view}
                    initiallyOpen={detail.files.length <= COLLAPSE_ALL_ABOVE}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {detail && detail.state === "open" ? (
        <ReviewBox
          detail={detail}
          onDone={load}
        />
      ) : null}
    </div>
  );
}

export function parsePrSubPath(subPath: string): { repo: string; number: number } | null {
  const parts = subPath.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length !== 4 || parts[0] !== "pr") return null;
  const [, owner, name, num] = parts;
  const number = Number(num);
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || !Number.isInteger(number) || number < 1)
    return null;
  return { repo: `${owner}/${name}`, number };
}
