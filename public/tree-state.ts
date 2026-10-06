// Tracks which folder paths in the file rail are expanded, defaulting to
// fully collapsed (#13: a large tree should be minimized, not always fully
// expanded, on first paint or when switching worktrees). A factory, like
// commit-lock.js's store, so each worktree gets its own independent
// expand/collapse state: switching the active worktree never carries one
// worktree's expanded folders into another's file tree, and re-fetching a
// worktree's file tree (#4's live status updates) never resets it, since the
// store is separate from the fetched tree data.
export function createTreeExpansionStore() {
  const expandedPathsByWorktree = new Map<string, Set<string>>();

  function expandedSetFor(worktreePath: string) {
    let set = expandedPathsByWorktree.get(worktreePath);
    if (!set) {
      set = new Set();
      expandedPathsByWorktree.set(worktreePath, set);
    }
    return set;
  }

  return {
    isExpanded(worktreePath: string, dirPath: string) {
      return expandedSetFor(worktreePath).has(dirPath);
    },
    toggle(worktreePath: string, dirPath: string) {
      const set = expandedSetFor(worktreePath);
      if (set.has(dirPath)) set.delete(dirPath);
      else set.add(dirPath);
    },
    // Drops expansion state for any worktree not in `knownPaths`. #12 made
    // worktree removal a live, in-session event, so without this a
    // long-running session that repeatedly creates/removes worktrees would
    // otherwise accumulate one forgotten Set per removed worktree forever.
    pruneToKnownWorktrees(knownPaths: Iterable<string>) {
      const known = new Set(knownPaths);
      for (const worktreePath of expandedPathsByWorktree.keys()) {
        if (!known.has(worktreePath)) expandedPathsByWorktree.delete(worktreePath);
      }
    },
  };
}
