import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollStore } from '../../public/auto-scroll.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test('defaults to off', () => {
  assert.equal(createAutoScrollStore(memoryStorage()).isEnabled(), false);
});

test('persists the choice across stores', () => {
  const storage = memoryStorage();
  createAutoScrollStore(storage).setEnabled(true);
  assert.equal(createAutoScrollStore(storage).isEnabled(), true);
  createAutoScrollStore(storage).setEnabled(false);
  assert.equal(createAutoScrollStore(storage).isEnabled(), false);
});

test('ignores unrecognised saved values', () => {
  assert.equal(createAutoScrollStore(memoryStorage({ 'canopy:auto-scroll': 'yes' })).isEnabled(), false);
});

test('keeps the session choice when storage reads and writes throw', () => {
  const store = createAutoScrollStore({
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  });
  assert.equal(store.isEnabled(), false);
  store.setEnabled(true);
  assert.equal(store.isEnabled(), true);
});
