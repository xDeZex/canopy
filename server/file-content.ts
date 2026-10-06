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
import type { Git } from './git-port.js';

export type ReadWorkingFile = (absolutePath: string) => Promise<string>;
export interface FileContentOptions {
  runGit?: Git;
  readWorkingFile?: ReadWorkingFile;
  oldPath?: string;
}

const defaultReadFile = (absolutePath: string) => readFile(absolutePath, 'utf8');

export async function readFileContent(
  worktreePath: string,
  filePath: string,
  ref = 'HEAD',
  { runGit = defaultRunGit, readWorkingFile = defaultReadFile, oldPath = filePath }: FileContentOptions = {},
) {
  // A renamed file's ref side is its old path's content, so the diff shows
  // only the edits made on top of the move.
  const [head, working] = await Promise.all([
    readRefContent(worktreePath, oldPath, ref, runGit),
    readWorkingContent(worktreePath, filePath, readWorkingFile),
  ]);
  return { head, working };
}

// `git show` exits 128 for missing paths or objects, including an unborn HEAD.
// Explicit locks must confirm path absence before treating this as missing.
export function isMissingRefSide(err: unknown) {
  return errorCode(err) === 128;
}

// A former directory can now be a file, blocking access to its deleted children.
export function isMissingWorkingSide(err: unknown) {
  return errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR';
}

function errorCode(err: unknown): unknown {
  return err !== null && (typeof err === 'object' || typeof err === 'function') && 'code' in err ? err.code : undefined;
}

async function readRefContent(worktreePath: string, filePath: string, ref: string, runGit: Git) {
  // Validate explicit locks outside the missing-file catch. An invalid base
  // is an error, not an empty file; Auto retains its unborn-HEAD behavior.
  if (ref !== 'HEAD') {
    const resolved = await runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], worktreePath);
    ref = resolved.trim();
  }
  try {
    return await runGit(['show', `${ref}:${filePath}`], worktreePath, { maxBuffer: 1024 * 1024 * 32 });
  } catch (err) {
    if (isMissingRefSide(err)) {
      if (ref === 'HEAD') return null;
      // Match show's root-relative paths, preserve unusual names, and keep
      // path arguments separate from options. Lookup failures remain errors.
      const entry = await runGit(['ls-tree', '--full-tree', '-z', ref, '--', filePath], worktreePath);
      if (entry === '') return null;
    }
    throw err;
  }
}

async function readWorkingContent(worktreePath: string, filePath: string, readWorkingFile: ReadWorkingFile) {
  try {
    return await readWorkingFile(path.join(worktreePath, filePath));
  } catch (err) {
    if (isMissingWorkingSide(err)) return null;
    throw err;
  }
}
