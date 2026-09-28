import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreeList, selectedFirst } from './porcelain.js';

test('parses a single worktree with a branch', () => {
  const output = [
    'worktree /home/oliver/repos/canopy',
    'HEAD a8c8e65b40e000beb566ebdc65256176636bc075',
    'branch refs/heads/main',
    '',
  ].join('\n');

  assert.deepEqual(parseWorktreeList(output), [
    {
      path: '/home/oliver/repos/canopy',
      head: 'a8c8e65b40e000beb566ebdc65256176636bc075',
      branch: 'main',
      detached: false,
      bare: false,
      locked: false,
      lockedReason: null,
      prunable: false,
      prunableReason: null,
    },
  ]);
});

test('parses multiple worktrees separated by a blank line', () => {
  const output = [
    'worktree /home/oliver/repos/canopy',
    'HEAD a8c8e65b40e000beb566ebdc65256176636bc075',
    'branch refs/heads/main',
    '',
    'worktree /home/oliver/repos/canopy-worktrees/feature',
    'HEAD 1234abcd1234abcd1234abcd1234abcd1234abcd',
    'branch refs/heads/feature/diff-view',
    '',
  ].join('\n');

  const result = parseWorktreeList(output);

  assert.equal(result.length, 2);
  assert.equal(result[0].path, '/home/oliver/repos/canopy');
  assert.equal(result[0].branch, 'main');
  assert.equal(result[1].path, '/home/oliver/repos/canopy-worktrees/feature');
  assert.equal(result[1].branch, 'feature/diff-view');
});

test('marks a detached HEAD worktree with no branch', () => {
  const output = [
    'worktree /home/oliver/repos/canopy-worktrees/detached',
    'HEAD 1234abcd1234abcd1234abcd1234abcd1234abcd',
    'detached',
    '',
  ].join('\n');

  const [worktree] = parseWorktreeList(output);

  assert.equal(worktree.branch, null);
  assert.equal(worktree.detached, true);
});

test('marks a bare repository worktree', () => {
  const output = ['worktree /home/oliver/repos/canopy.git', 'bare', ''].join('\n');

  const [worktree] = parseWorktreeList(output);

  assert.equal(worktree.bare, true);
  assert.equal(worktree.head, null);
  assert.equal(worktree.branch, null);
});

test('parses a locked worktree with no reason given', () => {
  const output = [
    'worktree /home/oliver/repos/canopy-worktrees/locked',
    'HEAD 1234abcd1234abcd1234abcd1234abcd1234abcd',
    'branch refs/heads/locked-branch',
    'locked',
    '',
  ].join('\n');

  const [worktree] = parseWorktreeList(output);

  assert.equal(worktree.locked, true);
  assert.equal(worktree.lockedReason, null);
});

test('parses a locked worktree with a multi-word reason', () => {
  const output = [
    'worktree /home/oliver/repos/canopy-worktrees/locked',
    'HEAD 1234abcd1234abcd1234abcd1234abcd1234abcd',
    'branch refs/heads/locked-branch',
    'locked claude agent agent-abb0562d4fd8e72fc (pid 3165672 start 106238831)',
    '',
  ].join('\n');

  const [worktree] = parseWorktreeList(output);

  assert.equal(worktree.locked, true);
  assert.equal(
    worktree.lockedReason,
    'claude agent agent-abb0562d4fd8e72fc (pid 3165672 start 106238831)'
  );
});

test('parses a prunable worktree with a reason', () => {
  const output = [
    'worktree /home/oliver/repos/canopy-worktrees/gone',
    'HEAD 1234abcd1234abcd1234abcd1234abcd1234abcd',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  const [worktree] = parseWorktreeList(output);

  assert.equal(worktree.prunable, true);
  assert.equal(worktree.prunableReason, 'gitdir file points to non-existent location');
});

test('returns an empty array for empty output', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList('\n'), []);
});

test('selectedFirst moves the selected linked worktree to the front', () => {
  const worktrees = [{ path: '/main' }, { path: '/a' }, { path: '/b' }];
  assert.deepEqual(selectedFirst(worktrees, '/b'), [{ path: '/b' }, { path: '/main' }, { path: '/a' }]);
});

test('selectedFirst leaves the order alone when the main or an unknown path is selected', () => {
  const worktrees = [{ path: '/main' }, { path: '/a' }];
  assert.deepEqual(selectedFirst(worktrees, '/main'), worktrees);
  assert.deepEqual(selectedFirst(worktrees, '/elsewhere'), worktrees);
});
