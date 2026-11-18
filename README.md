# bb-plugin-review-queue

A [bb](https://getbb.app) plugin that shows the open GitHub pull requests waiting for your review, in three columns:

1. **From your team:** review requested from you by name, author is in one of your configured teams.
2. **From others:** review requested from you by name, any other author.
3. **Team review requests:** review requested from one of your selected teams (not you by name), any author.

Each card shows the repo, author and wait time, a size label (XS to XL) with +/- lines and file count, the first lines of the description, and chips for CI, approvals, conflicts and staleness (no activity for 5 days or more).

**Re-review tracking:** PRs you already reviewed come back to the first two columns, marked in blue, when the author pushed new commits in the last 14 days. A PR where your review was requested again gets a "Re-review" chip. The sidebar badge counts the PRs that ask for you by name and turns yellow when one has waited more than a day.

## Requirements

The GitHub CLI, signed in: `gh auth login`. The plugin uses your `gh` session and stores no tokens.

## Install

```
git clone git@github.com:bjonord/bb-plugin-review-queue.git
cd bb-plugin-review-queue
npm install
bb plugin install .
```

## Review in bb

Click a PR title or its **Review** button to open it inside bb: the description, every changed file in bb's diff viewer (unified or split), and a review box with **Approve**, **Request changes** and **Comment**. The review is sent with your `gh` login and recorded against the commit you were looking at. If new commits arrived in the meantime, GitHub shows your review as being on that older commit. The arrow icon opens the PR on GitHub instead.

## Your team

The page lists your GitHub teams as toggles. Click the ones that count as your team; the choice is saved and applied at once. From a terminal:

```
bb review-queue teams
bb review-queue teams set my-org/backend,my-org/infra
```

## Old team requests

The third column hides team requests that have waited more than 30 days. Use the 7d / 30d / 90d / All toggles in the column header, or:

```
bb review-queue team-age 90
bb review-queue team-age all
```

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `includeTeamRequests` | `true` | Show the third column. |
| `includeDrafts` | `false` | Include draft PRs. |
| `refreshMinutes` | `5` | How often to poll GitHub. |

```
bb plugin config review-queue set includeDrafts true
bb plugin reload review-queue
```

## CLI

```
bb review-queue list [--json]
bb review-queue refresh [--json]
bb review-queue teams [set <org/slug>[,<org/slug>...]] [--json]
bb review-queue team-age <days|all> [--json]
```

## Develop

```
bb plugin dev
```
