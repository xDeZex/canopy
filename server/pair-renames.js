// Pairs unstaged moves: git reports a file moved on disk without staging as
// a deletion plus an untracked file, so they are matched by content
// similarity. Pure; callers read the file contents.

const MIN_SIMILARITY = 0.5;
// Fuzzy scoring is O(deleted × added), so it is skipped past this many
// comparisons. Exact matches are found by hashing and are not limited.
const MAX_FUZZY_COMPARISONS = 40000;

// The deleted and untracked-added paths worth comparing, or null when there
// is nothing to pair. Only entries tagged `untracked` are added candidates,
// so staged additions are left alone, and a path deleted and recreated is
// one modified file, not a move.
export function renameCandidates(entries) {
  const deleted = entries.filter((entry) => entry.status === 'deleted').map(({ path }) => path);
  const deletedPaths = new Set(deleted);
  const added = entries
    .filter((entry) => entry.status === 'added' && entry.untracked &&!deletedPaths.has(entry.path))
    .map(({ path }) => path);
  if (!deleted.length || !added.length) return null;
  return { deleted, added };
}

// Lines are compared without their newline so a last line that gains or
// loses one still matches; each line weighs its length plus that newline.
function contentProfile(content) {
  const lines = new Map();
  const split = content.split('\n');
  if (split.at(-1) === '') split.pop();
  for (const line of split) lines.set(line, (lines.get(line) ?? 0) + 1);
  return { content, size: content.length, lines };
}

// Like git's rename score: the size of the lines the two contents share,
// divided by the larger content's size. 1 for identical content, 0 for
// nothing shared.
function profileSimilarity(from, to) {
  if (from.content === to.content) return 1;
  const largest = Math.max(from.size, to.size);
  // Too different in size to reach the threshold; skip the line comparison.
  if (Math.min(from.size, to.size) / largest < MIN_SIMILARITY) return 0;
  let shared = 0;
  for (const [line, count] of to.lines) {
    shared += (line.length + 1) * Math.min(count, from.lines.get(line) ?? 0);
  }
  return Math.min(shared / largest, 1);
}

// Empty, unreadable (null) and binary (NUL-containing) files never pair.
function pairable(files) {
  return files.filter(({ content }) => content && !content.includes('\0'));
}

const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

// Files with identical content, found by looking the content up. Among
// several identical deleted files, the one with the same name is preferred.
function pairExact(deleted, added) {
  const deletedByContent = new Map();
  for (const file of deleted) {
    deletedByContent.set(file.content, [...(deletedByContent.get(file.content) ?? []), file]);
  }
  const pairs = [];
  for (const to of added) {
    const candidates = deletedByContent.get(to.content);
    if (!candidates?.length) continue;
    const sameName = candidates.findIndex((from) => basename(from.path) === basename(to.path));
    const [from] = candidates.splice(Math.max(sameName, 0), 1);
    pairs.push({ oldPath: from.path, path: to.path });
  }
  return pairs;
}

// Similar but not identical content, best matches first, each file used once.
function pairFuzzy(deleted, added) {
  if (deleted.length * added.length > MAX_FUZZY_COMPARISONS) return [];
  const addedProfiles = added.map((file) => ({ path: file.path, ...contentProfile(file.content) }));
  const scored = [];
  for (const from of deleted.map((file) => ({ path: file.path, ...contentProfile(file.content) }))) {
    for (const to of addedProfiles) {
      const score = profileSimilarity(from, to);
      if (score >= MIN_SIMILARITY) scored.push({ oldPath: from.path, path: to.path, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const usedOld = new Set();
  const usedNew = new Set();
  const pairs = [];
  for (const { oldPath, path } of scored) {
    if (usedOld.has(oldPath) || usedNew.has(path)) continue;
    usedOld.add(oldPath);
    usedNew.add(path);
    pairs.push({ oldPath, path });
  }
  return pairs;
}

// `deleted` and `added` are `{ path, content }` lists. Returns `{ oldPath,
// path }` pairs, each file used at most once: exact matches first, then the
// remaining files by similarity.
export function pairRenames(deleted, added) {
  const exact = pairExact(pairable(deleted), pairable(added));
  const usedOld = new Set(exact.map((pair) => pair.oldPath));
  const usedNew = new Set(exact.map((pair) => pair.path));
  const fuzzy = pairFuzzy(
    pairable(deleted).filter((file) => !usedOld.has(file.path)),
    pairable(added).filter((file) => !usedNew.has(file.path)),
  );
  return [...exact, ...fuzzy];
}

// Replaces each paired deletion and addition with one renamed entry, at the
// addition's position.
export function applyRenames(entries, pairs) {
  const oldPathByNewPath = new Map(pairs.map((pair) => [pair.path, pair.oldPath]));
  const oldPaths = new Set(pairs.map((pair) => pair.oldPath));
  return entries
    .filter((entry) => !(entry.status === 'deleted' && oldPaths.has(entry.path)))
    .map((entry) => {
      const oldPath = entry.status === 'added' ? oldPathByNewPath.get(entry.path) : undefined;
      return oldPath === undefined ? entry : { path: entry.path, status: 'renamed', oldPath };
    });
}
