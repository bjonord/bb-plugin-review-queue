---
name: review-queue
description: List open GitHub pull requests waiting for the user's review with the `bb review-queue` CLI. Use when the user asks which PRs need their review, what is in their review queue, or what their team is waiting on.
---

# Review queue

The Review Queue plugin reads GitHub with the user's `gh` login. It checks
GitHub notifications once a minute and refreshes when PR activity appears,
with a full refresh at least every 5 minutes. It sorts open PRs into three
groups:

1. From your team: review requested from the user by name, author is in a configured team.
2. From others: review requested from the user by name, any other author.
   Groups 1 and 2 also hold PRs the user already reviewed that got new commits in the last 14 days, marked `[new commits since your review]`. `[re-review]` marks a PR where the user's review was requested again.
3. Team review requests: review requested from one of the user's selected teams (not the user by name), any author.

## Commands

| Command | Effect |
| --- | --- |
| `bb review-queue list` | Show the cached queue. |
| `bb review-queue refresh` | Fetch from GitHub now, then show the queue. |
| `bb review-queue teams` | List the user's GitHub teams; `[x]` marks the ones that count as their team. |
| `bb review-queue teams set <org/slug>[,...]` | Choose the user's team. Only do this when the user asks. |
| `bb review-queue team-age <days\|all>` | Hide team review requests older than `<days>` (default 30). Only do this when the user asks. |

Add `--json` when the output drives code.

## Settings

`bb plugin config review-queue` shows them (drafts, team requests, refresh
interval). Reload the plugin after a change: `bb plugin reload review-queue`.
The team choice is not a setting; use `bb review-queue teams set`.
