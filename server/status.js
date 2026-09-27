// Parses `git status --porcelain --untracked-files=all` output into a flat
// list of changed paths with a normalized status, and merges that with a
// full tracked-file listing (`git ls-files`) into a nested file tree.
//
// Porcelain v1 short format: each line is a two-character XY status code, a
// space, then the path (`old -> new` for renames). `--untracked-files=all`
// makes untracked directories expand to their individual files, so no
// separate directory walk is needed. See `git status --help`.

export function parseStatus(output) {
  const trimmed = output.replace(/\r?\n$/, '');
  if (!trimmed) return [];

  return trimmed.split('\n').map((line) => {
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const path = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
    return { path, status: normalizeStatus(code) };
  });
}

function normalizeStatus(code) {
  if (code.includes('?')) return 'added';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  return 'modified';
}

// Merges the full set of tracked paths (from `git ls-files`) with the
// (possibly empty) set of changed paths from `parseStatus` into a nested
// file tree. Tracked paths with no matching status entry are clean; status
// entries not present in `trackedPaths` are untracked additions.
export function buildFileTree(trackedPaths, statusEntries) {
  const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry.status]));
  const allPaths = new Set([...trackedPaths, ...statusByPath.keys()]);

  const root = new Map();

  for (const filePath of allPaths) {
    const segments = filePath.split('/');
    let level = root;
    let prefix = '';

    segments.forEach((segment, i) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isFile = i === segments.length - 1;

      if (!level.has(segment)) {
        level.set(
          segment,
          isFile
            ? { name: segment, type: 'file', path: prefix, status: statusByPath.get(prefix) ?? 'clean' }
            : { name: segment, type: 'dir', path: prefix, childMap: new Map() }
        );
      }

      if (!isFile) level = level.get(segment).childMap;
    });
  }

  return toSortedArray(root);
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
