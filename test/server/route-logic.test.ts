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

test('formatChangeEvent keeps embedded newlines inside JSON rather than injecting SSE fields', () => {
  const paths: readonly string[] = ['a\nevent: injected', 'quote".js'];
  assert.equal(formatChangeEvent(paths), 'data: {"paths":["a\\nevent: injected","quote\\\".js"]}\n\n');
  assert.deepEqual(paths, ['a\nevent: injected', 'quote".js']);
});

test('formatWorktreeListEvent frames the list as an unnamed data event', () => {
  assert.equal(formatWorktreeListEvent([{ path: '/a' }]), 'data: [{"path":"/a"}]\n\n');
});

test('formatWorktreeListEvent preserves snapshot fields and empty lists without requiring a full domain object', () => {
  assert.equal(formatWorktreeListEvent([{ path: null, branch: 'topic', locked: true }]),
    'data: [{"path":null,"branch":"topic","locked":true}]\n\n');
  assert.equal(formatWorktreeListEvent([]), 'data: []\n\n');
});

test('formatPollErrorEvent frames the message as the named worktree-poll-error event', () => {
  assert.equal(
    formatPollErrorEvent(new Error('boom')),
    'event: worktree-poll-error\ndata: {"message":"boom"}\n\n'
  );
});

test('formatPollErrorEvent accepts a structural message and escapes newlines without exposing other error fields', () => {
  const error = { message: 'boom\ndata: injected', stack: 'private details' };
  assert.equal(formatPollErrorEvent(error),
    'event: worktree-poll-error\ndata: {"message":"boom\\ndata: injected"}\n\n');
});
