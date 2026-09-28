import test from 'node:test';
import assert from 'node:assert/strict';
import { isInsideWorktree, formatChangeEvent, formatWorktreeListEvent, formatPollErrorEvent } from '../../server/route-logic.js';

test('isInsideWorktree accepts the root and paths beneath it', () => {
  assert.equal(isInsideWorktree('/repos/canopy', 'server/app.js'), true);
  assert.equal(isInsideWorktree('/repos/canopy', '.'), true);
  assert.equal(isInsideWorktree('/repos/canopy', 'a/../b.js'), true);
});

test('isInsideWorktree rejects paths that escape the root, including sibling-prefix ones', () => {
  assert.equal(isInsideWorktree('/repos/canopy', '../../etc/passwd'), false);
  assert.equal(isInsideWorktree('/repos/canopy', '../canopy-other/x'), false);
  assert.equal(isInsideWorktree('/repos/canopy', '/etc/passwd'), false);
});

test('formatChangeEvent frames the changed paths as an unnamed data event', () => {
  assert.equal(formatChangeEvent(['a.js']), 'data: {"paths":["a.js"]}\n\n');
});

test('formatWorktreeListEvent frames the list as an unnamed data event', () => {
  assert.equal(formatWorktreeListEvent([{ path: '/a' }]), 'data: [{"path":"/a"}]\n\n');
});

test('formatPollErrorEvent frames the message as the named worktree-poll-error event', () => {
  assert.equal(
    formatPollErrorEvent(new Error('boom')),
    'event: worktree-poll-error\ndata: {"message":"boom"}\n\n'
  );
});
