// Acquires changed paths from porcelain (HEAD) or a ref diff, then merges
// them with `git ls-files` for flat and nested views.
//
// Porcelain v1 -z format: each NUL record is a two-character XY status code,
// a space, then the path. Renames/copies add a source record after the destination.
// `--untracked-files=all`
// makes untracked directories expand to their individual files, so no
// separate directory walk is needed. See `git status --help`.

import { runGit as defaultRunGit } from './git.js';
import { readFile, stat as defaultStat } from 'node:fs/promises';
import { join } from 'node:path';
import { renameCandidates, pairRenames, applyRenames } from './pair-renames.js';

const defaultReadFile = (absolutePath) => readFile(absolutePath, 'utf8');

export async function getChangedPaths(worktreePath, ref = 'HEAD', runGit = defaultRunGit, readWorkingFile = defaultReadFile) {
  if (ref === 'HEAD') {
    const output = await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], worktreePath);
    return pairUnstagedRenames(parseStatus(output), { ref: 'HEAD', worktreePath, runGit, readWorkingFile });
  }

  // Resolve before using the ref as a diff argument: even a caller-supplied
  // value beginning with '-' cannot become a git option. Invalid refs fail.
  const resolved = (await runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], worktreePath)).trim();
  const [diff, untracked] = await Promise.all([
    runGit(['diff', '--no-ext-diff', '--name-status', '-z', resolved, '--'], worktreePath),
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath),
  ]);
  return pairUnstagedRenames(combineRefDiff(diff, untracked), { ref: resolved, worktreePath, runGit, readWorkingFile });
}

// Reads the candidate files' contents (the git/disk edge) and pairs them
// into renames. The `untracked` tag only serves the pairing, so it is dropped.
async function pairUnstagedRenames(entries, { ref, worktreePath, runGit, readWorkingFile }) {
  const withoutTag = (list) => list.map(({ untracked, ...entry }) => entry);
  const candidates = renameCandidates(entries);
  if (!candidates) return withoutTag(entries);

  const orNull = (read) => read.catch(() => null);
  const [deleted, added] = await Promise.all([
    mapInBatches(candidates.deleted, async (path) => ({
      path, content: await orNull(runGit(['show', `${ref}:${path}`], worktreePath)),
    })),
    mapInBatches(candidates.added, async (path) => ({
      path, content: await orNull(readWorkingFile(join(worktreePath, path))),
    })),
  ]);
  return withoutTag(applyRenames(entries, pairRenames(deleted, added)));
}

// Bounds how many git processes or file reads are in flight at once, so a
// bulk move cannot exhaust file descriptors.
const READ_BATCH_SIZE = 50;

async function mapInBatches(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += READ_BATCH_SIZE) {
    results.push(...await Promise.all(items.slice(i, i + READ_BATCH_SIZE).map(fn)));
  }
  return results;
}

// The tracked files merged with their changed-path statuses, as a nested tree.
export async function getFileTree(worktreePath, ref = 'HEAD', runGit = defaultRunGit, stat = defaultStat, readWorkingFile = defaultReadFile) {
  const [changedPaths, lsOut] = await Promise.all([
    getChangedPaths(worktreePath, ref, runGit, readWorkingFile),
    runGit(['ls-files', '-z'], worktreePath),
  ]);
  // An unstaged move leaves the old path in the index, but the file is gone.
  const movedAway = new Set(changedPaths.filter(({ status }) => status === 'renamed').map(({ oldPath }) => oldPath));
  const trackedPaths = lsOut.split('\0').filter((path) => path && !movedAway.has(path));
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

// `git ls-files --others -z`: NUL-terminated paths. Entries are tagged
// `untracked` so a rename can tell them from staged additions.
export function parseUntracked(output) {
  return output.split('\0').filter(Boolean).map((path) => ({ path, status: 'added', untracked: true }));
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
    entries.push({ path, status, ...(status === 'renamed' ? { oldPath } : {}), ...(code === '??' ? { untracked: true } : {}) });
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
