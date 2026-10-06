import test from 'node:test';
import assert from 'node:assert/strict';
import { isTypingTarget, shortcutAction } from '../../public/keyboard-shortcuts.js';
import type { ShortcutEvent } from '../../public/keyboard-shortcuts.js';

const press = (key: string, extra: Partial<ShortcutEvent> = {}) => shortcutAction({ key, target: { tagName: 'DIV' }, ...extra });

test('j and l step back and forward through changes', () => {
  assert.deepEqual(press('j'), { type: 'prev-change' });
  assert.deepEqual(press('l'), { type: 'next-change' });
});

test('s and f step back and forward through changed files', () => {
  assert.deepEqual(press('s'), { type: 'prev-file' });
  assert.deepEqual(press('f'), { type: 'next-file' });
  assert.equal(press('s', { ctrlKey: true }), null);
  assert.equal(press('f', { target: { tagName: 'INPUT', readOnly: false } }), null);
});

test('w and r select newer and older comparison commits with the same guards', () => {
  assert.deepEqual(press('w'), { type: 'newer-commit' });
  assert.deepEqual(press('r'), { type: 'older-commit' });
  for (const key of ['w', 'r']) {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      assert.equal(press(key, { [modifier]: true }), null);
    }
    for (const target of [
      { tagName: 'INPUT', readOnly: false },
      { tagName: 'TEXTAREA', readOnly: false },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) assert.equal(press(key, { target }), null);
  }
  assert.deepEqual(press('r', { target: { tagName: 'TEXTAREA', readOnly: true } }), { type: 'older-commit' });
  assert.equal(press('W'), null);
  assert.equal(press('R'), null);
});

test('e and d scroll up and down with the same typing and modifier guards', () => {
  assert.deepEqual(press('e'), { type: 'scroll-up' });
  assert.deepEqual(press('d'), { type: 'scroll-down' });
  for (const key of ['e', 'd']) {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      assert.equal(press(key, { [modifier]: true }), null);
    }
    for (const target of [
      { tagName: 'INPUT', readOnly: false },
      { tagName: 'TEXTAREA', readOnly: false },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) assert.equal(press(key, { target }), null);
  }
  assert.deepEqual(press('e', { target: { tagName: 'TEXTAREA', readOnly: true } }), { type: 'scroll-up' });
  assert.equal(press('E'), null);
  assert.equal(press('D'), null);
});

test('c adds a comment with the same typing and modifier guards', () => {
  assert.deepEqual(press('c'), { type: 'add-comment' });
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(press('c', { [modifier]: true }), null);
  }
  for (const target of [
    { tagName: 'INPUT', readOnly: false },
    { tagName: 'TEXTAREA', readOnly: false },
    { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true },
  ]) assert.equal(press('c', { target }), null);
  assert.deepEqual(press('c', { target: { tagName: 'TEXTAREA', readOnly: true } }), { type: 'add-comment' });
  assert.equal(press('C'), null);
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
