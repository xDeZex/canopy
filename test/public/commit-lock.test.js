import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommitLockStore } from '../../public/commit-lock.js';

test('a worktree with no lock set is Auto (null)', () => {
  const store = createCommitLockStore();
  assert.equal(store.getLockedCommit('/repo/a'), null);
});

test('locking a commit is reflected by getLockedCommit', () => {
  const store = createCommitLockStore();
  store.lockCommit('/repo/a', 'abc1234');
  assert.equal(store.getLockedCommit('/repo/a'), 'abc1234');
});

test('setAuto clears a previously locked commit', () => {
  const store = createCommitLockStore();
  store.lockCommit('/repo/a', 'abc1234');
  store.setAuto('/repo/a');
  assert.equal(store.getLockedCommit('/repo/a'), null);
});

test('locks are scoped per worktree', () => {
  const store = createCommitLockStore();
  store.lockCommit('/repo/a', 'abc1234');
  assert.equal(store.getLockedCommit('/repo/b'), null);
  assert.equal(store.getLockedCommit('/repo/a'), 'abc1234');
});

test('locking a new commit for the same worktree replaces the old lock', () => {
  const store = createCommitLockStore();
  store.lockCommit('/repo/a', 'abc1234');
  store.lockCommit('/repo/a', 'def5678');
  assert.equal(store.getLockedCommit('/repo/a'), 'def5678');
});

test('pruneToKnownWorktrees drops the lock for a worktree no longer present', () => {
  const store = createCommitLockStore();
  store.lockCommit('/repo/a', 'abc1234');
  store.lockCommit('/repo/b', 'def5678');

  store.pruneToKnownWorktrees(['/repo/a']);

  assert.equal(store.getLockedCommit('/repo/a'), 'abc1234', 'a still-known worktree keeps its lock');
  assert.equal(store.getLockedCommit('/repo/b'), null, 'a removed worktree\'s lock is dropped');
});

test('pruneToKnownWorktrees leaves locks for still-known worktrees untouched', () => {
  const store = createCommitLockStore();
  store.lockCommit('/repo/a', 'abc1234');

  store.pruneToKnownWorktrees(['/repo/a', '/repo/b']);

  assert.equal(store.getLockedCommit('/repo/a'), 'abc1234');
});
