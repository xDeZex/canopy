// Reads a file's content as of a git ref (`git show <ref>:<path>`, defaulting
// to `HEAD`) and its on-disk working-tree content for a given worktree, in
// parallel. Passing a commit sha as `ref` instead of the default `HEAD`
// generalizes this to a commit-locked diff (#5): the "head" side then shows
// the file as of that commit rather than the last one.
//
// A file can lack either side: a new/untracked file (or one that doesn't
// exist yet as of an older `ref`) has no ref-side version; a file deleted
// from disk (but still tracked) has no working-tree version. Both are
// represented as `null` rather than treated as errors, since they're
// expected states for a file under active edit — the caller decides what
// "neither exists" (both null) means for its path.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export async function readFileContent(worktreePath, filePath, ref = 'HEAD') {
  const [head, working] = await Promise.all([
    readRefContent(worktreePath, filePath, ref),
    readWorkingContent(worktreePath, filePath),
  ]);
  return { head, working };
}

async function readRefContent(worktreePath, filePath, ref) {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: 1024 * 1024 * 32,
    });
    return stdout;
  } catch {
    // `git show` exits non-zero both when the path has no version at `ref`
    // (new/untracked file, or a ref that predates the file) and when `ref`
    // itself doesn't resolve (e.g. HEAD in a repo with no commits yet).
    // Either way, there's no content to show for that side.
    return null;
  }
}

async function readWorkingContent(worktreePath, filePath) {
  try {
    return await readFile(path.join(worktreePath, filePath), 'utf8');
  } catch (err) {
    // A former directory can now be a file, blocking access to its deleted children.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}
