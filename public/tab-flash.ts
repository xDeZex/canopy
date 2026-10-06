// Pure: which worktree paths were saved to since the previous activity
// snapshot. A path with no earlier timestamp is initial seeding, not an edit.
export function updatedWorktreePaths(previous: Readonly<Record<string, number | null | undefined>>, next: Readonly<Record<string, number | null | undefined>>) {
  return Object.keys(next).filter((path) => {
    const before = previous[path];
    return typeof before === 'number' && Number.isFinite(before) && Number(next[path]) > before;
  });
}
