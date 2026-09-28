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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit as defaultRunGit } from './git.js';

const defaultReadFile = (absolutePath) => readFile(absolutePath, 'utf8');

export async function readFileContent(
  worktreePath,
  filePath,
  ref = 'HEAD',
  { runGit = defaultRunGit, readWorkingFile = defaultReadFile } = {},
) {
  const [head, working] = await Promise.all([
    readRefContent(worktreePath, filePath, ref, runGit),
    readWorkingContent(worktreePath, filePath, readWorkingFile),
  ]);
  return { head, working };
}

// `git show` exits 128 both when the path has no version at `ref` (new/untracked
// file, or a ref that predates the file) and when `ref` itself doesn't resolve
// (e.g. HEAD in a repo with no commits yet). Either way, there's no content to
// show for that side. Anything else (git missing, output too large) is real.
export function isMissingRefSide(err) {
  return err?.code === 128;
}

// A former directory can now be a file, blocking access to its deleted children.
export function isMissingWorkingSide(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

async function readRefContent(worktreePath, filePath, ref, runGit) {
  try {
    return await runGit(['show', `${ref}:${filePath}`], worktreePath, { maxBuffer: 1024 * 1024 * 32 });
  } catch (err) {
    if (isMissingRefSide(err)) return null;
    throw err;
  }
}

async function readWorkingContent(worktreePath, filePath, readWorkingFile) {
  try {
    return await readWorkingFile(path.join(worktreePath, filePath));
  } catch (err) {
    if (isMissingWorkingSide(err)) return null;
    throw err;
  }
}
