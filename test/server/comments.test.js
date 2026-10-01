import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComments, appendThread, commentsRevision, validateNewThread } from '../../server/comments.js';

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

const ids = { threadId: 'thread-new', messageId: 'message-new', createdAt: '2026-10-02T09:00:00.000Z' };
const request = { file: 'src/a.js', line: 7, text: 'Why this?\n<b>x</b>' };

test('appending to an absent sidecar creates a single-line modified-side user thread that parses back', () => {
  const { source, thread: created } = appendThread(null, request, ids);
  assert.deepEqual(created, { id: 'thread-new', file: 'src/a.js', side: 'modified', line_range: { start: 7, end: 7 },
    created_at: ids.createdAt, resolved: false,
    messages: [{ id: 'message-new', author: 'user', text: request.text, created_at: ids.createdAt }] });
  assert.deepEqual(parseComments(source), { warning: null, threads: [created] });
});

test('appending preserves existing threads, chronology and unrelated messages exactly', () => {
  const existing = JSON.stringify({ version: 1, threads: [thread({ id: 'late', created_at: '2026-10-03T00:00:00Z' }), thread({ id: 'early' })] });
  const { source } = appendThread(existing, request, ids);
  const stored = parseComments(source).threads;
  assert.deepEqual(stored.map((t) => t.id), ['early', 'thread-new', 'late']);
  assert.deepEqual(stored.find((t) => t.id === 'early'), thread({ id: 'early', messages: [thread().messages[1], thread().messages[0]] }));
});

test('appending refuses malformed or unsupported existing data instead of replacing it', () => {
  for (const bad of ['threads: [', '{"version":2,"threads":[]}', 'version: 1\nthreads: !evil []', source([thread({ side: 'original' })])]) {
    assert.throws(() => appendThread(bad, request, ids), bad);
  }
  assert.throws(() => appendThread(source([thread({ id: 'thread-new' })]), request, ids), /Duplicate/);
});

test('serialization quotes tricky text so it round-trips verbatim', () => {
  for (const text of ['- item', 'a: b', '# not a comment', '"quoted"', 'null', '123', '|', 'line\n\nbreak ', '!!js/function x', '&anchor *alias', '  unicode ✓']) {
    assert.equal(parseComments(appendThread(null, { ...request, text }, ids).source).threads[0].messages[0].text, text, text);
  }
});

test('revisions identify exact sidecar content and give an absent sidecar its own revision', () => {
  assert.equal(commentsRevision(null), 'absent');
  assert.equal(commentsRevision('a'), commentsRevision('a'));
  assert.notEqual(commentsRevision('a'), commentsRevision('a '));
  assert.notEqual(commentsRevision(''), commentsRevision(null));
});

test('new thread requests validate path, line and text', () => {
  assert.equal(validateNewThread(request), null);
  for (const bad of [{ file: '../x' }, { file: '/abs' }, { file: '' }, { line: 0 }, { line: 1.5 }, { line: '3' }, { line: null },
    { text: '' }, { text: '  \n' }, { text: 5 }, { text: 'x'.repeat(20001) }]) {
    assert.ok(validateNewThread({ ...request, ...bad }), JSON.stringify(bad));
  }
  assert.ok(validateNewThread());
});

test('serialized timestamps are quoted so external YAML readers keep them as strings', () => {
  const { source } = appendThread(null, request, ids);
  assert.match(source, /created_at: "2026-10-02T09:00:00\.000Z"/);
});
