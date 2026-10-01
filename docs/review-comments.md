# Review comments: sidecar contract and agent workflow

Each registered worktree has at most one conversation file at the fixed path `.canopy/comments.yaml`, relative to that worktree's root. It is created lazily on the first saved comment; until then it is absent and Canopy shows no threads.

## Pointing an agent at a worktree's comments

Canopy has no vendor-specific integration and edits no agent-instruction files. Tell the agent yourself, for example:

> Read `<worktree>/.canopy/comments.yaml` and address the unresolved threads. Reply by appending a message with `author: agent`. Reread the file immediately before each edit and replace it atomically (see below).

Use the worktree you are reviewing: each worktree has its own file, and conversations never cross between worktrees.

## Version 1 schema

```yaml
version: 1
threads:
  - id: thread-1                  # stable, unique in the file
    file: src/example.js          # relative path; no '..', '.', empty, absolute, ':' or '\' parts
    side: modified                # only the modified side is supported
    line_range: {start: 2, end: 3}  # inclusive, 1-based; a single line has start == end
    created_at: "2026-10-01T12:00:00Z"
    resolved: false
    messages:                     # at least one; unique ids within the thread
      - id: message-1             # stable
        author: user              # user | agent
        text: Please explain this change.   # plain text, never Markdown or HTML
        created_at: "2026-10-01T12:00:00Z"
```

A thread not tied to a file may omit `file`, `side` and `line_range` together (never use null). Unknown fields, duplicate ids, other versions and non-core YAML tags make Canopy refuse the whole file with a visible warning; it never repairs it. IDs and `created_at` values must stay unchanged once written.

Canopy saves new threads with `author: user`, equal `start` and `end`, `side: modified` and `resolved: false`.

## Writing from outside Canopy

1. **Reread** the latest file contents immediately before changing them.
2. Change only what you mean to, keeping every other thread and message exactly as it was.
3. Write the whole result to a temporary file in the same directory and **atomically rename** it over `comments.yaml`. Do not edit in place.

Replies reopen a thread: a new message does not change `resolved`. Set `resolved: true` only when the same edit also adds an agent response.

## Live refresh

Canopy watches the sidecar of the selected worktree and refreshes messages and `resolved` state without a page reload. This holds when `.canopy/` is gitignored and regardless of the ignore-gitignored setting. If a write is malformed or partial, the last valid conversation stays visible with a warning until the next valid write; a missing file is the normal no-threads state. Switching worktrees shows only that worktree's file.

## Revision checks and what they do not cover

Canopy sends each client the revision (a hash of the exact file bytes, or `absent`) with the comments it loaded. A save carries that revision; Canopy rereads the file, and if it differs, rejects the save visibly (HTTP 409), reloads the latest comments and keeps your draft so you can review and save again. Saves inside Canopy are serialized per worktree.

This is not a global lock. An external writer can still change the file between Canopy's reread and its atomic rename; that write is then replaced by Canopy's. Canopy never reads a half-written file because it only ever replaces the file atomically, but two writers racing in that short window is possible. Keep agent runs and manual saves from overlapping when the conversation matters.

Saving rewrites the whole file from its parsed content: threads and messages are preserved exactly, but YAML comments, anchors and formatting added by hand are not. The new file is written to a temporary `comments.yaml.<id>.tmp` beside it (removed on failure) and renamed. Path and symlink checks for writes have the same time-of-check/time-of-use limit as reads: do not run Canopy over a filesystem an adversary is changing concurrently. Line numbers are not checked against file content on the server, and a draft is not moved if the file changes while it is open.

Canopy refuses to save over a file that is malformed, an unsupported version or a symlink, and never replaces data it cannot parse.

## Git

Canopy never edits any ignore file. Whether comments are committed is your choice: they may be worth keeping in the repository. To keep them out of `git status`, add `/.canopy/comments.yaml` to the repository's `.gitignore` or to `.git/info/exclude` yourself. (This repository's own `.gitignore` ignores `.canopy/`.)

## Lifetime

Conversations outlive a Canopy session: closing Canopy leaves the file. Deleting a worktree deletes its file with the rest of the worktree, after Canopy's existing preview and confirmation of ignored/untracked data.
