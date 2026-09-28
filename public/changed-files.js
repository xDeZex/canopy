import { collectFiles } from './collect-files.js';

const byPath = (a, b) => a.path.localeCompare(b.path);

// Flat list of files with a non-clean status, sorted alphabetically by full
// relative path (#22), independent of folder expansion state.
export function changedFiles(nodes) {
  return collectFiles(nodes)
    .filter((file) => file.status !== 'clean')
    .sort(byPath);
}
