import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewModeStore, defaultViewMode } from '../../public/view-mode.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test('defaults to File mode for a clean file (no diff to show)', () => {
  assert.equal(defaultViewMode('clean'), 'file');
});

test('defaults to Diff mode for a modified file', () => {
  assert.equal(defaultViewMode('modified'), 'diff');
});

test('defaults to Diff mode for an added file', () => {
  assert.equal(defaultViewMode('added'), 'diff');
});

test('defaults to Diff mode for a deleted file', () => {
  assert.equal(defaultViewMode('deleted'), 'diff');
});

test('defaults to Diff mode when status is unknown (e.g. not yet loaded)', () => {
  assert.equal(defaultViewMode(undefined), 'diff');
});

test('seeds from the first file only, without persisting the status-derived mode', () => {
  const storage = memoryStorage();
  const store = createViewModeStore(storage);
  assert.equal(store.getMode(), 'diff');
  store.seed('clean');
  assert.equal(store.getMode(), 'file');
  store.seed('modified');
  assert.equal(store.getMode(), 'file');
  assert.equal(storage.getItem('canopy:view-mode'), null);

  // A reload before any explicit selection uses its own first file.
  const reloaded = createViewModeStore(storage);
  reloaded.seed('modified');
  assert.equal(reloaded.getMode(), 'diff');
});

test('a modified first file keeps Diff mode when switching to a clean file', () => {
  const store = createViewModeStore(memoryStorage());
  store.seed('modified');
  store.seed('clean');
  assert.equal(store.getMode(), 'diff');
});

test('an explicit toggle persists, survives reload, and overrides later file statuses', () => {
  const storage = memoryStorage();
  const store = createViewModeStore(storage);
  store.seed('clean');
  store.setMode('diff');
  assert.equal(storage.getItem('canopy:view-mode'), 'diff');
  store.seed('clean');
  assert.equal(store.getMode(), 'diff');

  const reloaded = createViewModeStore(storage);
  assert.equal(reloaded.getMode(), 'diff');
  reloaded.seed('clean');
  assert.equal(reloaded.getMode(), 'diff');
  reloaded.setMode('file');
  assert.equal(createViewModeStore(storage).getMode(), 'file');
});

test('a saved choice wins even before the first file is selected', () => {
  const storage = memoryStorage();
  storage.setItem('canopy:view-mode', 'file');
  const store = createViewModeStore(storage);
  assert.equal(store.getMode(), 'file');
  store.seed('modified');
  assert.equal(store.getMode(), 'file');
});

test('setting a mode before seeding prevents the first file from overriding it', () => {
  const store = createViewModeStore(memoryStorage());
  store.setMode('file');
  store.seed('modified');
  assert.equal(store.getMode(), 'file');
});

test('an unrecognised saved value does not block first-file seeding', () => {
  const storage = memoryStorage();
  storage.setItem('canopy:view-mode', 'unknown');
  const store = createViewModeStore(storage);
  store.seed('clean');
  assert.equal(store.getMode(), 'file');
});

test('a blocked storage read falls back to session-only mode', () => {
  const store = createViewModeStore({
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
  });
  store.seed('clean');
  assert.equal(store.getMode(), 'file');
  assert.doesNotThrow(() => store.setMode('diff'));
  store.seed('clean');
  assert.equal(store.getMode(), 'diff');
});

test('a blocked storage write still updates the session preference', () => {
  const storage = {
    getItem() { return 'file'; },
    setItem() { throw new Error('storage blocked'); },
  };
  const store = createViewModeStore(storage);
  store.seed('modified');
  assert.equal(store.getMode(), 'file');
  assert.doesNotThrow(() => store.setMode('diff'));
  store.seed('clean');
  assert.equal(store.getMode(), 'diff');
  assert.equal(createViewModeStore(storage).getMode(), 'file'); // write did not persist
});

test('a blocked localStorage property does not prevent store creation or toggling', () => {
  const previousWindow = globalThis.window;
  try {
    globalThis.window = Object.defineProperty({}, 'localStorage', {
      get() { throw new Error('storage blocked'); },
    });
    const store = createViewModeStore();
    store.seed('clean');
    assert.equal(store.getMode(), 'file');
    store.setMode('diff');
    assert.equal(store.getMode(), 'diff');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
