// Pure default-mode logic for the Diff/File toggle (variant D). A clean
// file has no diff to show, so it opens in File mode; anything else
// (modified/added/deleted, or a status we haven't loaded yet) opens in
// Diff mode, per the issue's acceptance criteria.
export function defaultViewMode(status) {
  return status === 'clean' ? 'file' : 'diff';
}

const STORAGE_KEY = 'canopy:view-mode';

// A status picks the initial mode for this session, but only an explicit
// toggle is saved. A saved choice takes precedence over the first file.
export function createViewModeStore(storage) {
  let savedMode;
  try {
    storage ??= window.localStorage;
    savedMode = storage.getItem(STORAGE_KEY);
  } catch {
    // Storage may be blocked, including access to the localStorage property.
    // Keep the preference in memory for this page instead.
    storage = null;
  }
  let mode = savedMode === 'file' || savedMode === 'diff' ? savedMode : 'diff';
  let seeded = mode === savedMode;

  return {
    getMode() {
      return mode;
    },
    seed(status) {
      if (seeded) return;
      mode = defaultViewMode(status);
      seeded = true;
    },
    setMode(nextMode) {
      if (nextMode !== 'file' && nextMode !== 'diff') throw new RangeError(`Invalid view mode: ${nextMode}`);
      mode = nextMode;
      seeded = true;
      try {
        storage?.setItem(STORAGE_KEY, mode);
      } catch {
        // A failed write must not undo the user's session choice.
        storage = null;
      }
    },
  };
}
