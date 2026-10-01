// Pure: which worktree paths were saved to since the previous activity
// snapshot. A path with no earlier timestamp is initial seeding, not an edit.
export function updatedWorktreePaths(previous, next) {
  return Object.keys(next).filter((path) => {
    const before = previous[path];
    return Number.isFinite(before) && next[path] > before;
  });
}
