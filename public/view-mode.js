// Pure default-mode logic for the Diff/File toggle (variant D). A clean
// file has no diff to show, so it opens in File mode; anything else
// (modified/added/deleted, or a status we haven't loaded yet) opens in
// Diff mode, per the issue's acceptance criteria.
export function defaultViewMode(status) {
  return status === 'clean' ? 'file' : 'diff';
}
