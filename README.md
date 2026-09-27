# Canopy

A live view over what an AI coding agent is doing across many branches and worktrees at once — so you can read and give feedback on generated docs, code, and tests as they land, or while they're still being written.

## Motivation

When an agent works across several branches/worktrees in parallel, reviewing its output means constantly switching directories and re-running `git diff`/`git status` by hand. Existing tools solve pieces of this (`lazygit` for branch/worktree switching and diffs, `bat`/`glow` for reading files, VS Code for a full GUI) but nothing combines exactly this shape:

- a file tree
- a git tree (status, branches, worktrees)
- a full-file view with edits highlighted inline (not just diff hunks)
- auto-updating as files change on disk, live

## Planned features (MVP scope only)

1. **File tree** — browse any worktree's files, edited or not.
2. **Git tree** — list of worktrees and branches; pick one to view.
3. **Full-file diff view** — show the whole current file with added/changed lines highlighted inline, not a hunk-only diff.
4. **Auto-update** — watch the filesystem; the view refreshes itself as the agent writes files, no manual refresh.
5. **Worktree/branch switching** — swap which worktree the tree and diff view are pointed at.

Explicitly out of scope for now: commenting/annotation, multi-repo dashboards, remote/hosted use, auth, anything beyond a single local user reviewing local worktrees.

## Intended approach

- **Backend**: a small local Node process. Git state comes from shelling out to `git status --porcelain`, `git worktree list --porcelain`, `git branch` — read-only, no git library needed. A file watcher (`chokidar`) watches the active worktree and pushes change events to the frontend over a WebSocket/SSE connection.
- **Frontend**: a single page, no build step to start. The full-file-with-inline-highlights view is the one piece that looks hard but isn't — it's a direct embed of **Monaco's diff editor** (the same component VS Code uses): feed it the file's HEAD content and its on-disk content, it renders the rest.
- **Shape**: a local web app (browser tab), not Electron — a desktop window wrapper (Electron/Tauri) is a trivial follow-up if wanted later, not a prerequisite.

## Status

Not yet built. This README is the spec from the planning conversation; implementation hasn't started.
