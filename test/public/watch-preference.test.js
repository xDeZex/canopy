import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchPreferenceStore } from '../../public/watch-preference.js';

test('ignore preference defaults on, persists browser choice, and survives blocked storage', () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const preference = createWatchPreferenceStore(storage);
  assert.equal(preference.isEnabled(), true);
  preference.setEnabled(false);
  assert.equal(createWatchPreferenceStore(storage).isEnabled(), false);
  preference.setEnabled(true);
  assert.equal(createWatchPreferenceStore(storage).isEnabled(), true);
  const blocked = createWatchPreferenceStore({ getItem() { throw new Error('blocked'); } });
  assert.equal(blocked.isEnabled(), true);
  blocked.setEnabled(false);
  assert.equal(blocked.isEnabled(), false);
  const writeBlocked = createWatchPreferenceStore({ getItem: () => null, setItem() { throw new Error('blocked'); } });
  writeBlocked.setEnabled(false);
  assert.equal(writeBlocked.isEnabled(), false);
});
