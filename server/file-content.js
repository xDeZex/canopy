// Reads a file's HEAD content (`git show HEAD:<path>`) and its on-disk
// working-tree content for a given worktree, in parallel.
//
// A file can lack either side: a new/untracked file has no HEAD version, a
// file deleted from disk (but still tracked) has no working-tree version.
// Both are represented as `null` rather than treated as errors, since
// they're expected states for a file under active edit — the caller decides
// what "neither exists" (both null) means for its path.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export async function readFileContent(worktreePath, filePath) {
  const [head, working] = await Promise.all([
    readHeadContent(worktreePath, filePath),
    readWorkingContent(worktreePath, filePath),
  ]);
  return { head, working };
}

async function readHeadContent(worktreePath, filePath) {
  try {
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: 1024 * 1024 * 32,
    });
    return stdout;
  } catch {
    // `git show` exits non-zero both when the path has no HEAD version
    // (new/untracked file) and when HEAD itself doesn't exist yet (a repo
    // with no commits). Either way, there's no HEAD content to show.
    return null;
  }
}

async function readWorkingContent(worktreePath, filePath) {
  try {
    return await readFile(path.join(worktreePath, filePath), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
