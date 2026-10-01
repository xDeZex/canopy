# Canopy

Watch and review an AI coding agent's work across Git worktrees in one browser tab. Follow changes as they happen without switching directories or repeatedly running `git diff`.

![Canopy showing a live README diff across Git worktrees](docs/screenshot.png)

## Run it

Requires Node.js 20.19+ and Git:

```sh
npm install -g github:xDeZex/canopy
canopy .
```

Open http://localhost:4173. Pass any folder inside the Git repository you want to view, such as `canopy projects/canopy`. To use a different port, run `PORT=4174 canopy .`.

To run from a clone instead:

```sh
git clone https://github.com/xDeZex/canopy.git
cd canopy
npm ci
npm run dev -- .
```

## Live observation

**Ignore .gitignore paths** is on by default in the toolbar, and your choice is
saved in this browser. It excludes matching files from live update notifications
and worktree "last saved edit" times, pruning ignored directories before they
are watched. Turning it off observes those files too; both live streams reconnect
immediately and the current view is refreshed. File listing, visibility and
content access are unchanged in either mode. Tabs using different modes have
independent edit timestamps.

Rules come only from each worktree's root and nested `.gitignore` files, including
linked worktrees. Like Git, only regular `.gitignore` files supply rules; symlinked
rule files are not followed. Global Git ignores and `.git/info/exclude` are not
used, and there are no special dependency/build directory defaults. `.git` bookkeeping is
always excluded from file-edit observation (Git index changes still refresh status).
Both observation streams watch symlinks themselves, not their targets; they do
not traverse linked directories, including links outside the worktree.
Rules are cached during observation: **restart Canopy after editing ignore rules**
to reload them for every connected browser and activity watcher.
Unreadable rule files are logged once per watcher and treated as having no rules
until restart; other available rules still apply and edits remain observable.
