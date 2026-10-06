import test from 'node:test';
import assert from 'node:assert/strict';
import { pickActiveWorktree } from '../../public/worktree-select.js';

test('keeps the current active path when it is still in the list', () => {
  const worktrees = [{ path: '/a' }, { path: '/b' }];
  assert.equal(pickActiveWorktree(worktrees, '/b'), '/b');
});

test('falls back to the first worktree when the active one was removed', () => {
  const worktrees = [{ path: '/a' }, { path: '/b' }];
  assert.equal(pickActiveWorktree(worktrees, '/removed'), '/a');
});

test('falls back to null when no worktrees remain', () => {
  assert.equal(pickActiveWorktree([], '/a'), null);
});

test('picks the first worktree when there was no active path yet', () => {
  const worktrees = [{ path: '/a' }, { path: '/b' }];
  assert.equal(pickActiveWorktree(worktrees, null), '/a');
});
