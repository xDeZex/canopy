import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComments } from '../../server/comments.js';

export const thread = (patch = {}) => ({
  id: 'thread-1', file: 'public/app.js', side: 'modified', line_range: { start: 1, end: 2 },
  created_at: '2026-10-01T12:00:00Z', resolved: false,
  messages: [
    { id: 'later', author: 'agent', text: '<img onerror="alert(1)">', created_at: '2026-10-01T12:02:00Z' },
    { id: 'first', author: 'user', text: 'Please explain.\nSecond line.', created_at: '2026-10-01T12:00:00Z' },
  ], ...patch,
});
const source = (threads) => JSON.stringify({ version: 1, threads });

test('mixed version 1 threads accept only complete anchors or genuinely general conversations', () => {
  const { file, side, line_range, ...general } = thread({ id: 'general' });
  const result = parseComments(source([thread(), general]));
  assert.equal(result.warning, null);
  assert.deepEqual(Object.keys(result.threads[1]), ['id', 'created_at', 'resolved', 'messages']);
  assert.deepEqual(result.threads[1].messages.map((message) => message.id), ['first', 'later']);
  for (const anchor of [{ file }, { side }, { line_range }, { file, side }, { file, line_range },
    { side, line_range }, { file: null, side: null, line_range: null }, { file, side, line_range: null }]) {
    assert.match(parseComments(source([{ ...general, ...anchor }])).warning, /schema/);
  }
});

test('version 1 conversations preserve identities, text and timestamps and sort messages chronologically', () => {
  const result = parseComments(source([thread()]));
  assert.equal(result.warning, null);
  assert.deepEqual(result.threads, [thread({ messages: [thread().messages[1], thread().messages[0]] })]);
});

test('malformed YAML, unsafe tags, unsupported versions and invalid schema fail closed with a warning', () => {
  const invalid = [
    'threads: [', 'version: 1\nthreads: !evil []', '!!js/function "function () {}"',
    'version: 1\nthreads: !!set {}', 'version: 1\nversion: 1\nthreads: []',
    '{"version":2,"threads":[]}', 'version: 1\nthreads: null',
    source([thread({ side: 'original' })]), source([thread({ resolved: 'false' })]),
    source([thread({ file: null })]), source([thread({ side: null })]),
    source([thread({ line_range: null })]),
    source([thread({ line_range: { start: 0, end: 2 } })]),
    source([thread({ line_range: { start: 3, end: 2 } })]),
    source([thread({ created_at: 'yesterday' })]), source([thread({ messages: [] })]),
    source([thread({ created_at: '2026-02-30T12:00:00Z' })]),
    source([thread({ messages: [ { ...thread().messages[0], author: 'bot' } ] })]),
    source([thread(), thread()]), source([thread({ messages: [thread().messages[0], thread().messages[0]] })]),
    ...['../secret', '/etc/passwd', 'C:/secret', 'a\\b', 'a/../b', './a', 'a//b', 'a\u0000b']
      .map((file) => source([thread({ file })])),
  ];
  for (const yaml of invalid) {
    const result = parseComments(yaml);
    assert.deepEqual(result.threads, [], yaml);
    assert.match(result.warning, /comments/i, yaml);
  }
  assert.deepEqual(parseComments('version: 1\nthreads: []'), { threads: [], warning: null });
});
