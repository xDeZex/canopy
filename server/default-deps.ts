// The git-backed default dependencies of the app: what `createApp` uses when
// a test doesn't inject a fake. Discovery also checks directory availability;
// the remaining pieces delegate to the modules that own their logic.

import { statSync } from 'node:fs';
import { runGit } from './git.js';
import type { Git } from './git-port.js';
import { parseWorktreeList, selectedFirst } from './porcelain.js';
import { getFileTree } from './status.js';
import { readFileContent } from './file-content.js';
import { listCommits, originMainSha } from './commits.js';
import { watchWorktree } from './watcher.js';
import { worktreeDeletionReason } from './worktree-delete.js';

export type WorktreeStat = (directory: string) => { isDirectory: () => boolean };

export function hasWorktreeDirectory(directory: string, stat: WorktreeStat = statSync) {
  try { return stat(directory).isDirectory(); }
  catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

// Lists the repo's worktrees with the one containing `repoRoot` first. The
// local remote-tracking ref is shared by linked worktrees; Git resolves it
// from repoRoot without inspecting .git paths or contacting the remote.
// Including the raw tip in each snapshot lets the existing poll observe
// ref-only changes even when a worktree's latest shared commit stays unchanged.
// Browsing requires a directory; deletion can request all Git registrations.
export function createListWorktrees(repoRoot: string, git: Git = runGit, { stat = statSync, includeMissing = false }: { stat?: WorktreeStat; includeMissing?: boolean } = {}) {
  return async () => {
    const [stdout, originSha] = await Promise.all([
      git(['worktree', 'list', '--porcelain'], repoRoot),
      originMainSha(repoRoot, git),
    ]);
    const worktrees = parseWorktreeList(stdout);
    const available = includeMissing ? worktrees : worktrees.filter((worktree) =>
      worktree.path !== null && hasWorktreeDirectory(worktree.path, stat));
    return selectedFirst(available.map((worktree) => ({ ...worktree,
      deletionReason: worktreeDeletionReason(worktree, worktrees, repoRoot) })), repoRoot)
      .map((worktree) => ({ ...worktree, originMainSha: originSha }));
  };
}

export const defaultDeps = { getFileTree, getFileContent: readFileContent, listCommits, watchWorktree };
