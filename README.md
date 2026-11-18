# bb-plugin-review-queue

A [bb](https://getbb.app) plugin that shows the open GitHub pull requests waiting for your review, in three columns:

1. **From your team:** review requested from you by name, author is in one of your configured teams.
2. **From others:** review requested from you by name, any other author.
3. **Team review requests:** review requested from one of your selected teams (not you by name), any author.

Each PR shows how long it has waited, CI state, review decision and size. The sidebar badge counts the PRs that ask for you by name and turns yellow when one has waited more than a day.

## Requirements

The GitHub CLI, signed in: `gh auth login`. The plugin uses your `gh` session and stores no tokens.

## Install

```
git clone git@github.com:bjonord/bb-plugin-review-queue.git
cd bb-plugin-review-queue
npm install
bb plugin install .
```

## Your team

The page lists your GitHub teams as toggles. Click the ones that count as your team; the choice is saved and applied at once. From a terminal:

```
bb review-queue teams
bb review-queue teams set Teamtailor/platform,Teamtailor/opensearch
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
