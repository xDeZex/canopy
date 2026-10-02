# Reply / reopen demo (#62)

This is a **user-run visual and keyboard evaluation**, not an agent browser check.
Run Canopy from the clone as described in the README, select a disposable worktree,
and use an existing review thread (or add a comment with the gutter / `c` shortcut).
The worktree's `.canopy/comments.yaml` is the durable conversation.

## Reply, reopen, save, reload

1. To simulate an agent resolving the thread, run the script below from the clone,
   substituting the selected worktree's absolute path and a thread ID from its sidecar.
   It appends an agent response and explicitly resolves **alongside that response**.
   Wait for the incoming message / Resolved state, or reload the page.
2. Tab to **Reply** and press Enter/Space. Confirm the labelled inline textarea gets
   focus, resolved history remains visible, and there is no Edit action.
3. Type `Is this resolved? <b>This is literal text</b>`. Move the caret/select text;
   change File / Diff or inline / side-by-side while the draft is open. Also try a
   live file update, navigating away/back, and general/unavailable conversations.
   The draft should survive; a draft that no longer has focus must not steal it.
4. Save reply. Confirm the conversation is Open, previous messages are unchanged,
   and the new user message is chronological, with literal angle brackets.
5. Reload the page and reselect the conversation. Check the reply still appears,
   and its sidecar ID / creation timestamp did not change. Writing “resolved”,
   “fixed”, or “done” in a user reply must not resolve the thread.

```sh
node --input-type=module - /absolute/selected-worktree thread-id <<'JS'
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse, stringify } from 'yaml';
const file = path.join(process.argv[2], '.canopy/comments.yaml');
const data = parse(await readFile(file, 'utf8'));
const thread = data.threads.find((thread) => thread.id === process.argv[3]);
if (!thread) throw new Error('Unknown thread id');
thread.messages.push({ id: `agent-${randomUUID()}`, author: 'agent',
  text: 'Simulated incoming agent response', created_at: new Date().toISOString() });
thread.resolved = true;
const temp = `${file}.${randomUUID()}.tmp`;
await writeFile(temp, stringify(data));
await rename(temp, file);
JS
```

This disposable demo script drops YAML comments; normal Canopy saves re-emit the
contract header. External writers must reread immediately before editing, preserve
existing IDs/timestamps and unrelated data, and write via a temporary file + rename.
User replies always reopen; agent prose never resolves implicitly.

## Deterministic incoming-update conflict

Use **DevTools Network Request Blocking**, not a `window.fetch` replacement: the
app captures its fetch dependency at startup. Block only the selected worktree's
active SSE connection, leaving comment GETs and POSTs available.

1. In Network, find the selected worktree's `/api/watch?worktree=…&ignoreGitignore=…`
   request. Copy its full URL into a blocking rule, replacing only the final
   `ignoreGitignore` value with `*`. For example, for `/absolute/selected-worktree`
   on the default port:
   `http://localhost:4173/api/watch?worktree=%2Fabsolute%2Fselected-worktree&ignoreGitignore=*`.
   Use the actual host/port and URL-encoded worktree path from your request.
   **Do not block** `/api/comments`, `/api/watch-worktrees`, or `/api/watch-activity`.
2. Enable the rule **before reloading the page**. Reload to close any already-open
   SSE connection; adding a rule alone need not close it. Reselect the worktree/file,
   wait for the initial `/api/comments?worktree=…` GET to finish, and confirm the
   active `/api/watch?…` attempts are blocked. Recreate the reply draft now (a page
   reload discards unsaved drafts).
3. Run the agent-response script again without changing Git HEAD, worktrees, or
   the browser's observation mode. The incoming response should **not** appear yet:
   the browser still holds the revision from its initial GET. If it does appear,
   an active connection was not blocked; repeat from step 2 before proceeding.
4. Save reply. The POST should return **409**, followed by an unblocked comment GET.
   Confirm a visible conflict, the incoming response in the conversation,
   and the same draft. **Retry reply** must not become available before the refreshed
   history is displayed. Review the incoming message, then retry.
5. Remove/disable the blocking rule. Switch worktrees away/back to recreate the
   active SSE connection, or reload the page now that the draft was saved. Confirm
   `/api/watch?…` is connected, both the incoming response and user reply survive
   reload, and the thread is reopened.

Why this isolates a stale revision: active-watch messages/reconnects trigger comment
loads; the repo-wide worktree stream handles worktree metadata, and the activity
stream / 30-second UI timer only update edit-time displays. There is no comment
polling timer. Initial worktree selection and mutation-result refreshes still use
unblocked `/api/comments` GETs. This procedure was checked against those code paths,
not run by an agent in a browser.

Please report whether layout, Tab order, focus/caret retention, native typing and
conflict/retry feedback feel right in File, inline Diff and side-by-side Diff.
Automated tests use injected IO/fetch and DOM/Monaco stubs; they do not verify
Monaco's real visual layout or browser/IME behaviour.
