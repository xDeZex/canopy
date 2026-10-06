// Pure fallback logic for which worktree tab should be active after the
// live worktree list changes (#12: `git worktree add`/`remove` while Canopy
// is open). If the currently active path is still present, keep it; a
// removed active worktree falls back to the first remaining worktree, or to
// no selection (empty state) if none remain.
export function pickActiveWorktree(worktrees: readonly { path: string }[], currentActivePath: string | null) {
  if (worktrees.some((worktree) => worktree.path === currentActivePath)) {
    return currentActivePath;
  }
  return worktrees[0]?.path ?? null;
}
