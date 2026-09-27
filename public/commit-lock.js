// Tracks, per worktree, which commit a diff view is locked to for its
// comparison base, or that it should track the last commit automatically
// (the default, represented as `null`). A factory rather than module-level
// state so each worktree's lock lives in its own store instance's Map,
// scoped by worktree path — switching the active worktree in the tab bar
// never carries one worktree's lock into another (#5).
export function createCommitLockStore() {
  const lockedShaByWorktree = new Map();

  return {
    lockCommit(worktreePath, sha) {
      lockedShaByWorktree.set(worktreePath, sha);
    },
    setAuto(worktreePath) {
      lockedShaByWorktree.delete(worktreePath);
    },
    getLockedCommit(worktreePath) {
      return lockedShaByWorktree.get(worktreePath) ?? null;
    },
  };
}
