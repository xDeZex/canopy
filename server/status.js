// Acquires changed paths from porcelain (HEAD) or a ref diff, then merges
// them with `git ls-files` for flat and nested views.
//
// Porcelain v1 -z format: each NUL record is a two-character XY status code,
// a space, then the path. Renames/copies add a source record after the destination.
// `--untracked-files=all`
// makes untracked directories expand to their individual files, so no
// separate directory walk is needed. See `git status --help`.

import { runGit as defaultRunGit } from './git.js';
import { stat as defaultStat } from 'node:fs/promises';
import { join } from 'node:path';

export async function getChangedPaths(worktreePath, ref = 'HEAD', runGit = defaultRunGit) {
  if (ref === 'HEAD') {
    return parseStatus(await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], worktreePath));
  }

  // Resolve before using the ref as a diff argument: even a caller-supplied
  // value beginning with '-' cannot become a git option. Invalid refs fail.
  const resolved = await runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], worktreePath);
  const [diff, untracked] = await Promise.all([
    runGit(['diff', '--no-ext-diff', '--name-status', '-z', resolved.trim(), '--'], worktreePath),
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath),
  ]);
  return combineRefDiff(diff, untracked);
}

// The tracked files merged with their changed-path statuses, as a nested tree.
export async function getFileTree(worktreePath, ref = 'HEAD', runGit = defaultRunGit, stat = defaultStat) {
  const [changedPaths, lsOut] = await Promise.all([
    getChangedPaths(worktreePath, ref, runGit),
    runGit(['ls-files', '-z'], worktreePath),
  ]);
  const trackedPaths = lsOut.split('\0').filter(Boolean);
  const merged = mergeFileStatuses(trackedPaths, changedPaths);
  const withTimes = await Promise.all(merged.map(async (entry) => {
    if (entry.status === 'clean' || entry.status === 'deleted') return entry;
    try {
      const { mtimeMs } = await stat(join(worktreePath, entry.path));
      return Number.isFinite(mtimeMs) ? { ...entry, mtimeMs } : entry;
    } catch {
      // A file can disappear between git status and stat; keep its status.
      return entry;
    }
  }));
  return nestIntoTree(withTimes);
}

// A ref diff never lists untracked files, so they are appended as additions.
export function combineRefDiff(diffOutput, untrackedOutput) {
  return [...parseNameStatus(diffOutput), ...parseUntracked(untrackedOutput)];
}

// `git ls-files --others -z`: NUL-terminated paths.
export function parseUntracked(output) {
  return output.split('\0').filter(Boolean).map((path) => ({ path, status: 'added' }));
}

// `git diff --name-status -z`: status and path are separate NUL fields;
// rename/copy records have one extra (old) path field.
export function parseNameStatus(output) {
  const fields = output.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1;) {
    const code = fields[i++];
    const firstPath = fields[i++];
    const path = /^[RC]/.test(code) ? fields[i++] : firstPath;
    entries.push(code.startsWith('R')
      ? { path, status: 'renamed', oldPath: firstPath }
      : { path, status: normalizeStatus(code) });
  }
  return entries;
}

export function parseStatus(output) {
  const records = output.split('\0');
  const entries = [];
  for (let i = 0; i < records.length - 1;) {
    const record = records[i++];
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const oldPath = /[RC]/.test(code) ? records[i++] : undefined;
    const status = normalizeStatus(code);
    entries.push({ path, status, ...(status === 'renamed' ? { oldPath } : {}) });
  }
  return entries;
}

function normalizeStatus(code) {
  if (code.includes('?')) return 'added';
  // Checked before 'A': a worktree-deleted file (e.g. staged-add-then-
  // removed-from-disk, code "AD") should read as deleted, since that's the
  // file's actual state on disk right now.
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

// Tracked paths with no matching status entry are clean; status entries not
// present in `trackedPaths` are included too (e.g. untracked additions).
export function mergeFileStatuses(trackedPaths, statusEntries) {
  const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry]));
  const allPaths = new Set([...trackedPaths, ...statusByPath.keys()]);

  return [...allPaths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ ...(statusByPath.get(path) ?? { path, status: 'clean' }) }));
}

// The merged entries are already sorted by full path.
export function listChangedFiles(mergedEntries) {
  return mergedEntries.filter((entry) => entry.status !== 'clean');
}

// Nest the flat view into the existing dirs-before-files tree shape.
export function nestIntoTree(mergedEntries) {
  const root = new Map();

  for (const { path, status, oldPath, mtimeMs } of mergedEntries) {
    const segments = path.split('/');
    let level = root;
    let prefix = '';

    segments.forEach((segment, i) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isFile = i === segments.length - 1;

      // Git can report both a deleted tracked child (foo/bar) and an added
      // untracked file (foo). They have the same name/path but need separate
      // nodes so neither status is lost.
      const key = `${isFile ? 'file' : 'dir'}:${segment}`;
      if (!level.has(key)) {
        level.set(
          key,
          isFile
            ? { name: segment, type: 'file', path: prefix, status,
                ...(status === 'renamed' ? { oldPath } : {}),
                ...(mtimeMs != null ? { mtimeMs } : {}) }
            : { name: segment, type: 'dir', path: prefix, childMap: new Map() }
        );
      }

      if (!isFile) level = level.get(key).childMap;
    });
  }

  return toSortedArray(root);
}

export function buildFileTree(trackedPaths, statusEntries) {
  return nestIntoTree(mergeFileStatuses(trackedPaths, statusEntries));
}

function toSortedArray(levelMap) {
  const nodes = [...levelMap.values()].map((node) =>
    node.type === 'dir'
      ? { name: node.name, type: 'dir', path: node.path, children: toSortedArray(node.childMap) }
      : node
  );

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
