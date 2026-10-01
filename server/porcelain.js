// Parses the output of `git worktree list --porcelain` into plain objects.
//
// Porcelain format: one block per worktree, separated by a blank line, each
// line a `<key> <value>` pair (`branch`, `locked`, and `prunable` may carry
// a value; `detached` and `bare` are bare keys). See `git worktree --help`.

export function parseWorktreeList(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];

  return trimmed.split(/\n\n+/).map(parseBlock);
}

function parseBlock(block) {
  return parseFields(block.split('\n'));
}

// -z avoids quoting paths and preserves embedded newlines. Keep the raw local
// ref too, so destructive callers can validate rather than guess its prefix.
export function parseWorktreeListZ(output) {
  return output.split('\0\0').filter(Boolean).map((block) => parseFields(block.split('\0'), true));
}

function parseFields(fields, includeBranchRef = false) {
  const worktree = {
    path: null,
    head: null,
    branch: null,
    detached: false,
    bare: false,
    locked: false,
    lockedReason: null,
    prunable: false,
    prunableReason: null,
  };

  if (includeBranchRef) worktree.branchRef = null;

  for (const line of fields) {
    if (!line) continue;
    const spaceIndex = line.indexOf(' ');
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);

    switch (key) {
      case 'worktree':
        worktree.path = value;
        break;
      case 'HEAD':
        worktree.head = value;
        break;
      case 'branch':
        if (includeBranchRef) worktree.branchRef = value;
        worktree.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        worktree.detached = true;
        break;
      case 'bare':
        worktree.bare = true;
        break;
      case 'locked':
        worktree.locked = true;
        worktree.lockedReason = value || null;
        break;
      case 'prunable':
        worktree.prunable = true;
        worktree.prunableReason = value || null;
        break;
      default:
        // Forward-compatible: ignore porcelain keys we don't know about yet.
        break;
    }
  }

  return worktree;
}

// Moves the worktree at `selectedPath` to the front so the UI starts on the
// folder passed to the CLI, even when it is a linked worktree. Returns a new
// array; an unknown path leaves the order unchanged.
export function selectedFirst(worktrees, selectedPath) {
  const selected = worktrees.findIndex((worktree) => worktree.path === selectedPath);
  if (selected <= 0) return worktrees;
  return [worktrees[selected], ...worktrees.slice(0, selected), ...worktrees.slice(selected + 1)];
}
