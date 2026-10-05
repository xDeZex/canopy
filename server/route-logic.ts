// Pure helpers behind the routes in app.js: no server, port or git.

import path from 'node:path';

// Whether `filePath`, resolved against `worktreePath`, stays inside it (the
// worktree root itself counts as inside).
export function isInsideWorktree(worktreePath: string, filePath: string): boolean {
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, filePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// One SSE frame for a `/api/watch` change event.
export function formatChangeEvent(paths: readonly string[]): string {
  return `data: ${JSON.stringify({ paths })}\n\n`;
}

// One SSE frame for a `/api/watch-worktrees` snapshot.
// Only the identifying path is required here; the snapshot's other fields
// pass through untouched. This is not a complete worktree domain model.
export function formatWorktreeListEvent<T extends { readonly path: string | null }>(worktreeList: readonly T[]): string {
  return `data: ${JSON.stringify(worktreeList)}\n\n`;
}

// One SSE frame for the named event sent when the worktree poll fails.
export function formatPollErrorEvent(err: { readonly message: string }): string {
  return `event: worktree-poll-error\ndata: ${JSON.stringify({ message: err.message })}\n\n`;
}
