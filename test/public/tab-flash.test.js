import test from 'node:test';
import assert from 'node:assert/strict';
import { updatedWorktreePaths } from '../../public/tab-flash.js';

test('reports paths whose timestamp increased', () => {
  assert.deepEqual(updatedWorktreePaths({ '/a': 1, '/b': 5 }, { '/a': 2, '/b': 5 }), ['/a']);
});

test('ignores initial seeding of paths without a previous timestamp', () => {
  assert.deepEqual(updatedWorktreePaths({}, { '/a': 2 }), []);
  assert.deepEqual(updatedWorktreePaths({ '/a': null }, { '/a': 2 }), []);
});

test('ignores unchanged, older and dropped timestamps', () => {
  assert.deepEqual(updatedWorktreePaths({ '/a': 3, '/b': 3 }, { '/a': 2 }), []);
});
