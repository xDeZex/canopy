import type { PreferenceStorage } from './preference-storage.js';

const STORAGE_KEY = 'canopy:ignore-gitignore';

// Browser-wide saved default; each open app owns its current observation mode.
export function createWatchPreferenceStore(storage?: PreferenceStorage | null) {
  let enabled = true;
  try {
    storage ??= window.localStorage;
    enabled = storage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    storage = null;
  }

  return {
    isEnabled() { return enabled; },
    setEnabled(next: unknown) {
      enabled = Boolean(next);
      try { storage?.setItem?.(STORAGE_KEY, String(enabled)); }
      catch { storage = null; }
    },
  };
}
