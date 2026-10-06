// Tracks, per worktree, which commit a diff view is locked to for its
// comparison base, or that it should track the last commit automatically
// (the default, represented as `null`). A factory rather than module-level
// state so each worktree's lock lives in its own store instance's Map,
// scoped by worktree path — switching the active worktree in the tab bar
// never carries one worktree's lock into another (#5).
export function createCommitLockStore() {
  const lockedShaByWorktree = new Map<string, string>();

  return {
    lockCommit(worktreePath: string, sha: string) {
      lockedShaByWorktree.set(worktreePath, sha);
    },
    setAuto(worktreePath: string) {
      lockedShaByWorktree.delete(worktreePath);
    },
    getLockedCommit(worktreePath: string) {
      return lockedShaByWorktree.get(worktreePath) ?? null;
    },
    // Drops the lock for any worktree not in `knownPaths`. #12 made worktree
    // removal a live, in-session event, so without this a long-running
    // session that repeatedly creates/removes worktrees would otherwise
    // accumulate one forgotten lock entry per removed worktree forever.
    pruneToKnownWorktrees(knownPaths: Iterable<string | null>) {
      const known = new Set(knownPaths);
      for (const worktreePath of lockedShaByWorktree.keys()) {
        if (!known.has(worktreePath)) lockedShaByWorktree.delete(worktreePath);
      }
    },
  };
}
