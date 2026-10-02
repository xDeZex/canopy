# Resolve / reopen demo (#63)

This is a **user-run visual and keyboard evaluation**, not an agent browser check.
Run Canopy from the clone as described in the README and select a disposable
worktree. No new dependencies are needed.

## Fixture

In a disposable worktree with **no existing `.canopy/comments.yaml`**, create that
file with the fixture below. Do not overwrite a real conversation. The anchored
thread assumes this project's `public/app.js` exists; the unavailable thread
deliberately points at a missing file. Reload Canopy after creating the fixture.

```yaml
version: 1
threads:
  - id: demo-resolution
    file: public/app.js
    side: modified
    line_range: { start: 1, end: 2 }
    created_at: "2026-10-01T12:00:00Z"
    resolved: false
    messages:
      - id: demo-question
        author: user
        text: "Is this resolved? <b>Literal text</b>"
        created_at: "2026-10-01T12:00:00Z"
      - id: demo-agent
        author: agent
        text: "Fixed, done, resolved — prose alone does not change the flag."
        created_at: "2026-10-01T12:01:00Z"
  - id: demo-general
    created_at: "2026-10-01T13:00:00Z"
    resolved: true
    messages:
      - id: demo-general-message
        author: agent
        text: "Explicitly resolved fixture without a file."
        created_at: "2026-10-01T13:00:00Z"
  - id: demo-unavailable
    file: missing-resolution-demo.js
    side: modified
    line_range: { start: 4, end: 8 }
    created_at: "2026-10-01T14:00:00Z"
    resolved: false
    messages:
      - id: demo-unavailable-message
        author: user
        text: "Keep this unavailable anchor intact."
        created_at: "2026-10-01T14:00:00Z"
```

## Resolve, reopen, save, reload

1. Select `public/app.js:1–2` in the compact rail. The fixture must initially be
   **Open**, despite both messages containing resolution-related prose.
2. Tab to the native **Resolve** button and press Enter/Space. This immediately
   saves the chosen flag; no separate Save action is needed. History stays visible,
   selectable, greyed/struck-through. Its compact rail entry stays visible and
   greyed/struck-through too. There must be no Edit action.
3. Reload and reselect the conversation. It must still be **Resolved**, with a
   native **Reopen** button. Press that button and reload again: it must be Open.
   Compare the sidecar with the fixture: only `demo-resolution.resolved` should
   differ, never messages, IDs, timestamps, anchors, or unrelated threads. Normal
   saves also add/re-emit the contract header and may change YAML formatting.
4. Repeat in File, inline Diff and side-by-side Diff. Try selecting/copying literal
   `<b>` text. Verify the modes still work and the control is reachable by Tab.
5. Open **Reply**, type an unsaved draft, select part of it, then Resolve/Reopen.
   The draft/caret should survive history refreshes and switching diff modes.
   Save a reply to a resolved thread: the user reply must reopen it, even if its
   prose says “resolved”. See [the reply demo](reply-demo.md) for more focus checks.
6. Open **Comments without a file** and use Reopen/Resolve on `demo-general`.
   Select the unavailable file entry and toggle `demo-unavailable` in its readable
   fallback conversation. Neither action may invent or move an anchor.

## Explicit agent flag and stale-toggle conflict

Use the [reply demo's agent-response script](reply-demo.md#reply-reopen-save-reload)
with thread ID `demo-resolution`. It appends an agent response and sets
`resolved: true` in the same atomic edit. With watching enabled, confirm the new
message and Resolved state arrive without navigation; reload also reads that flag.
Agent prose must never change resolution implicitly.

For a deterministic stale revision, follow the reply demo's
[active-SSE request-blocking setup](reply-demo.md#deterministic-incoming-update-conflict).
Only the active `/api/watch` request is blocked; comment GETs/POSTs remain available.

1. Start with an Open thread, block active SSE **before** reloading, then recreate
   a reply draft. Reload discards drafts, so do this before typing.
2. Run the agent-response script. Its response must not yet appear in Canopy.
3. Press Resolve. Expect a **409** POST, a comment GET, visible conflict feedback,
   the newly received response, and the same reply draft. **Retry resolve** must
   remain disabled until refreshed history is displayed. Review it, then retry;
   the requested flag stays `true`, rather than accidentally reopening an incoming
   resolved conversation. Repeat starting Resolved and pressing Reopen if desired.
4. If refresh fails, saving stays blocked with a warning. Restore connectivity and
   switch worktrees away/back to refresh without discarding the reply draft;
   the same explicit retry should then be available. Remove the SSE blocking rule
   and reconnect as described in the reply demo. Reload after saving to check both
   messages and the flag survived.

Please report layout, contrast/strike-through readability, Tab order, Enter/Space
activation, focus/caret retention and conflict/retry feedback in all three modes.
Automated tests cover pure transitions and injected IO/fetch/DOM/Monaco seams;
they do not verify real browser layout, screen-reader announcements or IME behaviour.

## Concurrent-write limitation

All comment saves (new threads, replies and resolution changes) recheck the
sidecar's revision through the safe-path reader after writing the temporary file,
immediately before rename. An agent replacement during that write produces a
409 conflict with the latest revision, preserves the agent's data and removes the
temporary file; injected IO/HTTP tests cover this case. The manual stale-toggle
check above does not exercise concurrent filesystem timing.

This is not a filesystem compare-and-swap: an arbitrary external writer can still
replace the sidecar between the final recheck and rename and be overwritten.
Eliminating that remaining race requires a cooperating lock or compare-and-swap
protocol shared by writers; the per-worktree queue only serializes saves in this
Canopy process. Do not treat the demo or automated tests as proof of race-free
external writes.
