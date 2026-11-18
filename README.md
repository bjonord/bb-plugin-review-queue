# bb-plugin-review-queue

A [bb](https://getbb.app) plugin that shows the open GitHub pull requests waiting for your review, in three columns:

1. **From your team:** review requested from you by name, author is in one of your configured teams.
2. **From others:** review requested from you by name, any other author.
3. **Team requests from teammates:** review requested from one of your teams, author is a teammate.

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

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `teams` | `Teamtailor/platform` | GitHub teams whose members count as your team, `org/slug`, comma separated. |
| `includeTeamRequests` | `true` | Show the third column. |
| `includeDrafts` | `false` | Include draft PRs. |
| `refreshMinutes` | `5` | How often to poll GitHub. |

```
bb plugin config review-queue set teams "Teamtailor/platform"
bb plugin reload review-queue
```

## CLI

```
bb review-queue list [--json]
bb review-queue refresh [--json]
```

## Develop

```
bb plugin dev
```
