import test from 'node:test';
import assert from 'node:assert/strict';
import { isTypingTarget, shortcutAction } from '../../public/keyboard-shortcuts.js';

const press = (key, extra = {}) => shortcutAction({ key, target: { tagName: 'DIV' }, ...extra });

test('j and l step back and forward through changes', () => {
  assert.deepEqual(press('j'), { type: 'prev-change' });
  assert.deepEqual(press('l'), { type: 'next-change' });
});

test('digits 1-9 select the worktree at that position', () => {
  assert.deepEqual(press('1'), { type: 'select-worktree', index: 0 });
  assert.deepEqual(press('9'), { type: 'select-worktree', index: 8 });
});

test('? toggles help and Escape closes', () => {
  assert.deepEqual(press('?'), { type: 'toggle-help' });
  assert.deepEqual(press('Escape'), { type: 'close' });
});

test('other keys, including 0, are not shortcuts', () => {
  for (const key of ['0', 'a', 'k', 'J', 'Enter', '10']) assert.equal(press(key), null);
});

test('a held modifier leaves the key to the browser or Monaco', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(press('j', { [modifier]: true }), null);
    assert.equal(press('1', { [modifier]: true }), null);
  }
});

test('nothing fires while typing into a field', () => {
  assert.equal(shortcutAction({ key: 'j', target: { tagName: 'INPUT', readOnly: false } }), null);
  assert.equal(shortcutAction({ key: '1', target: { tagName: 'TEXTAREA', readOnly: false } }), null);
  assert.equal(shortcutAction({ key: 'l', target: { tagName: 'SELECT' } }), null);
  assert.equal(shortcutAction({ key: 'l', target: { tagName: 'DIV', isContentEditable: true } }), null);
});

test('a read-only textarea, like Monaco\'s, is not typing', () => {
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA', readOnly: true }), false);
  assert.deepEqual(
    shortcutAction({ key: 'j', target: { tagName: 'TEXTAREA', readOnly: true } }),
    { type: 'prev-change' },
  );
});

test('a missing target is not typing', () => {
  assert.equal(isTypingTarget(null), false);
});
