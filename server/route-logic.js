// Pure helpers behind the routes in app.js: no server, port or git.

import path from 'node:path';

// Whether `filePath`, resolved against `worktreePath`, stays inside it (the
// worktree root itself counts as inside).
export function isInsideWorktree(worktreePath, filePath) {
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, filePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// One SSE frame for a `/api/watch` change event.
export function formatChangeEvent(paths) {
  return `data: ${JSON.stringify({ paths })}\n\n`;
}

// One SSE frame for a `/api/watch-worktrees` snapshot.
export function formatWorktreeListEvent(worktreeList) {
  return `data: ${JSON.stringify(worktreeList)}\n\n`;
}

// One SSE frame for the named event sent when the worktree poll fails.
export function formatPollErrorEvent(err) {
  return `event: worktree-poll-error\ndata: ${JSON.stringify({ message: err.message })}\n\n`;
}
