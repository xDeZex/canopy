import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComments, appendThread, appendReply, validateReply, commentsRevision, validateNewThread, setThreadResolved, validateResolution } from '../../server/comments.js';

export const thread = <Patch extends object>(patch?: Patch) => ({
  id: 'thread-1', file: 'public/app.js', side: 'modified', line_range: { start: 1, end: 2 },
  created_at: '2026-10-01T12:00:00Z', resolved: false,
  messages: [
    { id: 'later', author: 'agent', text: '<img onerror="alert(1)">', created_at: '2026-10-01T12:02:00Z' },
    { id: 'first', author: 'user', text: 'Please explain.\nSecond line.', created_at: '2026-10-01T12:00:00Z' },
  ], ...patch,
});
const source = (threads: readonly unknown[]) => JSON.stringify({ version: 1, threads });

test('explicit resolution changes only the chosen flag, retaining stored history and unrelated threads', () => {
  const original = thread();
  const other = thread({ id: 'other' });
  const resolved = setThreadResolved(source([original, other]), { threadId: original.id, resolved: true });
  assert.deepEqual(resolved.thread, { ...original, resolved: true });
  assert.deepEqual(parseComments(resolved.source).threads, parseComments(source([{ ...original, resolved: true }, other])).threads);
  const reopened = setThreadResolved(resolved.source, { threadId: original.id, resolved: false });
  assert.deepEqual(reopened.thread, original);
  assert.deepEqual(setThreadResolved(reopened.source, { threadId: original.id, resolved: false }).thread, original);
  assert.throws(() => setThreadResolved(resolved.source, { threadId: 'missing', resolved: true }), /not found/);
  assert.throws(() => setThreadResolved('version: 2\nthreads: []', { threadId: original.id, resolved: true }), /schema/);
  assert.equal(validateResolution({ threadId: original.id, resolved: false }), null);
  for (const input of [{}, { threadId: '', resolved: true }, { threadId: 't', resolved: 'true' },
    { threadId: 't', resolved: true, text: 'reply' }]) assert.equal(typeof validateResolution(input), 'string');
});

test('user replies append without rewriting history, reopen even resolved threads, and never interpret prose', () => {
  const original = thread({ resolved: true });
  const other = thread({ id: 'other' });
  const result = appendReply(source([original, other]), { threadId: original.id, text: 'Resolved, fixed, done.' },
    { messageId: 'new', createdAt: '2026-10-02T09:00:00Z' });
  const loaded = parseComments(result.source).threads;
  assert.deepEqual(result.thread.messages.slice(0, -1), original.messages);
  assert.equal(result.thread.resolved, false);
  assert.match(result.source, /User replies append author: user and always set resolved: false/);
  assert.deepEqual(result.thread.messages.at(-1), { id: 'new', author: 'user', text: 'Resolved, fixed, done.', created_at: '2026-10-02T09:00:00Z' });
  assert.deepEqual(loaded[1], parseComments(source([other])).threads[0]);
  assert.throws(() => appendReply(source([original]), { threadId: 'missing', text: 'x' }, { messageId: 'new', createdAt: ids.createdAt }), /not found/);
  assert.throws(() => appendReply(source([original]), { threadId: original.id, text: 'x' }, { messageId: 'first', createdAt: ids.createdAt }), /Duplicate/);
  for (const input of [{}, { threadId: '', text: 'x' }, { threadId: 't', text: ' ' }, { threadId: 't', text: 'x'.repeat(20001) }]) {
    assert.equal(typeof validateReply(input), 'string');
  }
  assert.equal(validateReply({ threadId: 't', text: '<b>literal</b>' }), null);
});

test('mixed version 1 threads accept only complete anchors or genuinely general conversations', () => {
  const { file, side, line_range, ...general } = thread({ id: 'general' });
  const result = parseComments(source([thread(), general]));
  assert.equal(result.warning, null);
  assert.deepEqual(Object.keys(result.threads[1]), ['id', 'created_at', 'resolved', 'messages']);
  assert.deepEqual(result.threads[1].messages.map((message) => message.id), ['first', 'later']);
  for (const anchor of [{ file }, { side }, { line_range }, { file, side }, { file, line_range },
    { side, line_range }, { file: null, side: null, line_range: null }, { file, side, line_range: null }]) {
    assert.match(parseComments(source([{ ...general, ...anchor }])).warning ?? '', /schema/);
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
    assert.match(result.warning ?? '', /comments/i, yaml);
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

test('a range request creates a thread with the inclusive 1-based line_range', () => {
  const { thread: created, source } = appendThread(null, { ...request, line: 3, endLine: 5 }, ids);
  assert.deepEqual(created.line_range, { start: 3, end: 5 });
  const loaded = parseComments(source).threads[0];
  assert.ok('line_range' in loaded);
  assert.deepEqual(loaded.line_range, { start: 3, end: 5 });
  assert.deepEqual(appendThread(null, { ...request, line: 4, endLine: 4 }, ids).thread.line_range, { start: 4, end: 4 });
});

test('range requests validate their end line against the start', () => {
  assert.equal(validateNewThread({ ...request, line: 1, endLine: 1 }), null);
  assert.equal(validateNewThread({ ...request, line: 1, endLine: 2 }), null);
  for (const bad of [{ endLine: 6 }, { endLine: 0 }, { endLine: 7.5 }, { endLine: '9' }, { endLine: null }, { endLine: Infinity }]) {
    assert.ok(validateNewThread({ ...request, line: 7, ...bad }), JSON.stringify(bad));
  }
});

const headerOf = (text: string) => { const match = text.match(/^(?:#.*\n)+/); assert.ok(match); return match[0]; };
const schemaExample = (header: string) => { const match = header.match(/^# Schema:\n((?:#  .*\n)+)/m); assert.ok(match); return match[1].replace(/^# ?/gm, ''); };

test('a saved sidecar starts with a comment header that states the contract and still parses', () => {
  const { source, thread: created } = appendThread(null, request, ids);
  const header = headerOf(source);
  for (const rule of [/Append a message/, /author: agent/, /reread the file/, /atomically\s+# rename/, /Never edit in place/,
    /resolved: true only when the same edit also adds an agent response/,
    /Explicit user Resolve\/Reopen changes only resolved/]) assert.match(header, rule);
  assert.deepEqual(parseComments(source), { warning: null, threads: [created] });
});

test('the schema example in the header is a valid version 1 document, so it cannot drift from the validator', () => {
  const example = schemaExample(headerOf(appendThread(null, request, ids).source));
  const { warning, threads } = parseComments(example);
  assert.equal(warning, null);
  assert.equal(threads.length, 1);
  assert.deepEqual(Object.keys(threads[0]), ['id', 'file', 'side', 'line_range', 'created_at', 'resolved', 'messages']);
});

test('a later save keeps the header exactly once', () => {
  const first = appendThread(null, request, ids).source;
  const second = appendThread(first, request, { ...ids, threadId: 'thread-two' }).source;
  assert.equal(second.match(/Canopy review comments/g)?.length, 1);
  assert.equal(parseComments(second).threads.length, 2);
});

test('unknown fields make the whole file refused rather than repaired', () => {
  assert.match(parseComments(source([thread({ extra: true })])).warning ?? '', /schema/);
  assert.match(parseComments(JSON.stringify({ version: 1, threads: [], extra: 1 })).warning ?? '', /schema/);
});
