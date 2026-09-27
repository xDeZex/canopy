import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultViewMode } from './view-mode.js';

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
