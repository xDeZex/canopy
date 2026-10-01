# Throwaway: inline comments (#26)

**Original question (answered):** which inline hierarchy makes line/range feedback easiest to scan while reviewing real worktree diffs and directing an arbitrary coding agent?

**Verdict: B — Compact review rail**, selected by the user. The user considers this sufficient to conclude the prototype, with replies reopening threads and no Edit control. A/C remain available as primary-source comparison material. No prototype code is intended for main; production implementation remains separate.

Run from this worktree: `npm run prototype`. Open **http://localhost:4176/?variant=B** (A/C still available; `PORT` overrides 4176). Uses existing locked dependencies and the existing Monaco CDN. Select a real worktree/file and choose **Diff** if File mode is selected. Without `variant` this is the normal app. Normal server denies prototype assets; even the prototype runner disables activation/assets when `NODE_ENV=production`.

- **A — Full-width conversation:** broad stacked message, metadata header, separate action footer.
- **B — Compact review rail (selected):** continuous inline gutter rail, metadata/actions column, adjacent chronological user/agent messages and reply input.
- **C — Paired context + feedback:** a code-evidence pane paired with the feedback pane **inside a real Monaco view zone**, not a detached sidebar. Uses the selected diff mode rather than forcing two native diff editors: Monaco zones belong to a single editor, so paired context remains usable in both inline and side-by-side modes.

All variants keep cards always visible directly under the anchor range. Every card has Delete thread (entire conversation), plus user Resolve/Reopen; no Edit control. Resolved messages remain grey and struck-through but legible; replies/actions are not struck-through. The dropdown mixes open/resolved threads in oldest-first thread creation order, summarizes the initial message, and jumps across real files. The bottom switcher wraps, updates the URL, and supports left/right arrows **outside** inputs, selections, editable content, Monaco, and the rail separator. Threads survive switches but reset on reload.

## Confirmed resolution authority

**Either user or agent can resolve directly.** The user can reopen explicitly or by replying. Asking “is this resolved?” is just an agent message and **does not auto-resolve**. Per-thread **Agent asks** appends a follow-up and opens/reopens the thread; **Agent resolves** appends an agent response and explicitly resolves that same thread (available on open threads). User replies append messages and set `resolved: false`. Agent replies likewise reopen unless the agent explicitly resolves with its response. No resolver metadata is stored, so there is no stale resolver to clear on reopen.

## Prototype glossary (not production domain decisions)

- **Thread:** a stable-ID conversation owning file, side, inclusive line range, creation time, and resolved flag. Its anchor and creation time do not change on replies.
- **Message:** an ordered entry with stable ID, author (`user` or `agent`), text, and creation time. The initial creator message supplies the dropdown summary; subsequent messages are replies/follow-ups.
- **Resolve / Reopen:** thread-state changes, independent of message wording. A reply reopens; explicit resolution closes. Delete thread removes the initial message and every reply. Message editing/deletion is outside this prototype.

## Interaction and assumptions

Drag-select code (or Shift+arrow inside Monaco), then click the **+ gutter** on a selected line. Or click a gutter + for a single line, then Shift-click another + to extend the draft range. The selection toolbar is an additional accessible creation path. A composer is itself inline. Three explicit sample threads are seeded once per visited worktree on real file paths; they are not read from disk. The first includes an agent follow-up (including “is this resolved?”) and remains open; the second includes an agent response and is resolved. The third, when possible, demonstrates cross-file navigation. Labeled reply inputs update draft state without rebuilding cards on each keystroke; drafts survive variant/action rerenders in memory.

Anchors use **modified-side, 1-based, inclusive line ranges**, ending at the line immediately above the zone. Original-only deletion comments are not modeled; for a deleted file the modified model is a synthetic empty line. Changed comparison refs do not remap anchors. On shorter files the displayed anchor is clamped while stored range remains unchanged. Folded regions use `showInHiddenAreas` but need real-world validation. Multiple cards on a range share one dynamically sized view zone; long text wraps and edits retain creation timestamps.

## Proposed agent-agnostic sidecar

Visible live beneath the app, proposed path: `<worktree>/.canopy/comments.yaml`.

```yaml
version: 1
threads:
  - id: "stable-thread-id"
    file: "public/app.js"
    side: modified
    line_range: { start: 23, end: 34 }
    created_at: "2026-10-01T12:00:00.000Z"
    resolved: false
    messages:
      - id: "stable-initial-message-id"
        author: user
        text: "Please clarify this behavior."
        created_at: "2026-10-01T12:00:00.000Z"
      - id: "stable-follow-up-id"
        author: agent
        text: "Is the fallback behavior clear now? Is this resolved?"
        created_at: "2026-10-01T12:01:00.000Z"
      - id: "stable-reply-id"
        author: user
        text: "Please explain the fallback path too."
        created_at: "2026-10-01T12:02:00.000Z"
```

This proposed surface reflects the full conversation: thread `id/file/side/line_range/created_at/resolved` and ordered message `id/author/text/created_at`. Array order is conversation chronology. The format/version is still a prototype proposal, not a shipped contract. Strings use JSON-compatible quoted YAML scalars, including escaped newlines. **No sidecar reads/writes, no automatic delivery, no vendor-specific hooks, no CLAUDE.md/AGENTS.md changes.** Manually point any coding agent at the sidecar in a future implementation. Each thread's labeled agent controls stand in for manual YAML write-back **in memory only**, never selecting an implicit oldest thread. The visible YAML and full state inspector update on switch/selection/draft/action/workspace transitions; full state is also `window.__canopyCommentPrototype` (including `threadsByWorktree` and reply drafts).

## Proposed storage lifetime

Each worktree owns `<worktree>/.canopy/comments.yaml`, not a shared file in the common Git directory. A committed repository `.gitignore` rule `/.canopy/comments.yaml` excludes the sidecar from commits and merges while sharing the ignore rule across worktrees. Deleting the worktree directory deletes its conversations, including resolved threads. Ending an agent session alone does not remove the worktree or comments. No archival/persistence beyond worktree lifetime is proposed.

Ordinary `git worktree remove` can refuse a worktree containing ignored/untracked files. Canopy already previews ignored/untracked data, includes it in its confirmation snapshot, then uses `git worktree remove --force` (`server/worktree-delete.js`). Preserve that explicit confirmation for deletion of conversations and unrelated local files. The prototype does not add the ignore rule or create a sidecar because it performs no filesystem writes.

## Remaining questions / risks

- Validate selected B at realistic conversation density and narrow pane widths; A/C are retained as comparison material, not undecided winners.
- Should deletion-side anchors be supported, and how should side + comparison ref be represented?
- How should anchors migrate when agents change content, and how are stale anchors surfaced?
- Concurrency and external YAML writes remain unresolved: conflict/merge behavior, ordering/duplicate IDs, reload/watch behavior, and user drafts versus agent writes need a production design.
- Is a persistent + on every line too busy? Is select-then-click enough, or should the hovered gutter expose it?
- Validate native collapsed-region rendering, accessibility/focus, and zone alignment against many diff shapes before production implementation.

Throwaway-only: no new tests; syntax/regression/smoke checks instead. Browser evaluation is left to the user. Real app read paths and existing navigation remain; comment mutations are exclusively stubbed. Do not promote this code directly to production.
