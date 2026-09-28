// The git-backed default dependencies of the app: what `createApp` uses when
// a test doesn't inject a fake. Only glue: each piece delegates to a module
// that owns the logic.

import { runGit } from './git.js';
import { parseWorktreeList, selectedFirst } from './porcelain.js';
import { getFileTree } from './status.js';
import { readFileContent } from './file-content.js';
import { listCommits } from './commits.js';
import { watchWorktree } from './watcher.js';

// Lists the repo's worktrees with the one containing `repoRoot` first.
export function createListWorktrees(repoRoot) {
  return async () => {
    const stdout = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
    return selectedFirst(parseWorktreeList(stdout), repoRoot);
  };
}

export const defaultDeps = { getFileTree, getFileContent: readFileContent, listCommits, watchWorktree };
