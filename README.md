# PR Dashboard

A local, neon-terminal dashboard for one GitHub repo's pull requests: the merge queue, failing checks, conflicts, PRs awaiting review, and review and merge stats.

It talks to GitHub through your own `gh` CLI login, so there are no tokens to configure, and it serves the page on `127.0.0.1` only.

## Requirements

- Node 24 or later (`.nvmrc` pins it for nvm)
- The [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`

## Setup

```sh
npm install
echo "PR_DASHBOARD_REPO=owner/name" > .env
npm start
```

Then open <http://localhost:8765>. Pass a different port as an argument: `node server/server.ts 9000`.

## Settings

Read from the environment, or from `.env` at the repo root:

| Variable | Meaning |
| --- | --- |
| `PR_DASHBOARD_REPO` | The repo to watch, as `owner/name`. Required. |
| `IDLE_EXIT_SECONDS` | Stop the server once no page has polled for this long. Off by default. |
| `SELF_RESTART` | `1` to exit with code 75 when a server file changes, for a wrapper to restart it. |
| `PR_DASHBOARD_BROWSER` | Browser executable for `launch.sh`. Defaults to Chrome's Windows install, seen from WSL. |
| `PR_DASHBOARD_BROWSER_PROFILE` | Browser profile for `launch.sh` to open in, for Chromium-based browsers. Defaults to `Default`. |

## The repo's conventions

Some tabs assume a particular workflow:

- **In merge queue** lists open PRs labelled `automerge` and not `stacked`, ordered by [Kodiak](https://kodiakhq.com/)'s status (merging, then queue position, then blocked).
- PRs labelled `hotfix` sort ahead of others in the queue.
- Unresolved review threads count as failing, for repos that require threads resolved before merging.

## API budget

Each 15 second refresh costs about 7 GraphQL points, and stats (refreshed every 5 minutes, or straight after a merge) about 12. GitHub allows 5,000 an hour, shared with everything else using your `gh` login; the dashboard pauses until the reset if fewer than 500 remain.

## Layout

- `client/`: the page, served as-is apart from TypeScript types being stripped (no build step)
- `server/`: the HTTP server and GitHub queries
- `shared/`: types used by both

## Launching from Windows (WSL)

`launch.sh` starts the server if it isn't already running and opens the page in `PR_DASHBOARD_BROWSER`. Chrome, Edge, Brave and Chromium open it as a standalone app window in `PR_DASHBOARD_BROWSER_PROFILE`; any other browser opens it in a normal tab. For example, for Edge:

```sh
PR_DASHBOARD_BROWSER=/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
```
