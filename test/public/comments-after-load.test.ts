import test from 'node:test';
import assert from 'node:assert/strict';
import { commentsAfterLoad } from '../../public/comments-after-load.js';

const thread = { id: 'thread-1', file: 'a.js', resolved: false, messages: [{ id: 'm1', author: 'user', text: 'hi' }] };
const valid = { threads: [thread], warning: null, revision: 'r1' };

test('a valid payload replaces the conversation and clears any warning', () => {
  const warned = { ...valid, warning: 'Cannot load comments: bad', revision: null };
  const resolved = { ...thread, resolved: true };
  assert.deepEqual(commentsAfterLoad(warned, { threads: [resolved], warning: null, revision: 'r2' }),
    { threads: [resolved], warning: null, revision: 'r2' });
});

test('a malformed write keeps the last valid threads and surfaces the warning', () => {
  const incoming = { threads: [], warning: 'Cannot load comments: Malformed YAML', revision: null };
  assert.deepEqual(commentsAfterLoad(valid, incoming),
    { threads: [thread], warning: 'Cannot load comments: Malformed YAML', revision: null });
});

test('repeated malformed writes still keep the last valid threads', () => {
  const once = commentsAfterLoad(valid, { threads: [], warning: 'first', revision: null });
  assert.deepEqual(commentsAfterLoad(once, { threads: [], warning: 'second', revision: null }).threads, [thread]);
});

test('a missing sidecar is a valid empty state, not a warning', () => {
  assert.deepEqual(commentsAfterLoad(valid, { threads: [], warning: null, revision: 'absent' }),
    { threads: [], warning: null, revision: 'absent' });
});
