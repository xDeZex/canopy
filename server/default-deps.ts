// The git-backed default dependencies of the app: what `createApp` uses when
// a test doesn't inject a fake. Only glue: each piece delegates to a module
// that owns the logic.

import { runGit } from './git.js';
import type { Git } from './git-port.js';
import { parseWorktreeList, selectedFirst } from './porcelain.js';
import { getFileTree } from './status.js';
import { readFileContent } from './file-content.js';
import { listCommits, originMainSha } from './commits.js';
import { watchWorktree } from './watcher.js';
import { worktreeDeletionReason } from './worktree-delete.js';

// Lists the repo's worktrees with the one containing `repoRoot` first. The
// local remote-tracking ref is shared by linked worktrees; Git resolves it
// from repoRoot without inspecting .git paths or contacting the remote.
// Including the raw tip in each snapshot lets the existing poll observe
// ref-only changes even when a worktree's latest shared commit stays unchanged.
export function createListWorktrees(repoRoot: string, git: Git = runGit) {
  return async () => {
    const [stdout, originSha] = await Promise.all([
      git(['worktree', 'list', '--porcelain'], repoRoot),
      originMainSha(repoRoot, git),
    ]);
    const worktrees = parseWorktreeList(stdout);
    return selectedFirst(worktrees.map((worktree) => ({ ...worktree,
      deletionReason: worktreeDeletionReason(worktree, worktrees, repoRoot) })), repoRoot)
      .map((worktree) => ({ ...worktree, originMainSha: originSha }));
  };
}

export const defaultDeps = { getFileTree, getFileContent: readFileContent, listCommits, watchWorktree };
