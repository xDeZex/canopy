import type { PreferenceStorage } from './preference-storage.js';

const STORAGE_KEY = 'canopy:auto-scroll';

// Global (not per-file) preference for scrolling to the first change when a
// diff opens. Off by default; persisted, but a blocked or failing storage
// only costs the persistence, never the session's choice.
export function createAutoScrollStore(storage?: PreferenceStorage | null) {
  let enabled = false;
  try {
    storage ??= window.localStorage;
    enabled = storage.getItem(STORAGE_KEY) === 'true';
  } catch {
    storage = null;
  }

  return {
    isEnabled() {
      return enabled;
    },
    setEnabled(next: unknown) {
      enabled = Boolean(next);
      try {
        storage?.setItem?.(STORAGE_KEY, String(enabled));
      } catch {
        storage = null;
      }
    },
  };
}
