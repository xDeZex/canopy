import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentStore } from '../../server/comment-store.js';
import { commentsRevision, parseComments } from '../../server/comments.js';
import { createRequestHandler } from '../../server/handle-request.js';
import type { RequestDescription, ResponseDescription } from '../../server/handle-request.js';
import type { WriteIo } from '../../server/comment-store.js';
import { errorDetails } from '../../server/comments.js';
import { createCommentLoader } from '../../server/comment-loader.js';

const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const SIDECAR = '/repo/.canopy/comments.yaml';

// In-memory filesystem: path -> 'dir' | 'symlink' | file text.
interface FixtureOptions {
  files?: Record<string, string>;
  writeFails?: boolean | (() => boolean);
  afterWrite?: (files: Map<string, string>) => unknown;
  idStart?: number;
}
// Reads in these tests require an existing file; missing paths fail closed.
class Files extends Map<string, string> {
  override get(path: string): string {
    const value = super.get(path);
    assert.ok(value !== undefined, `Missing fixture file: ${path}`);
    return value;
  }
}
function fixture({ files = { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x\ny\n' }, writeFails = false, afterWrite = () => {}, idStart = 0 }: FixtureOptions = {}) {
  const fs = new Files(Object.entries(files));
  const log: string[][] = [];
  let id = idStart;
  const kind = (path: string) => { if (!fs.has(path)) throw enoent(); return fs.get(path); };
  const io: WriteIo = {
    realpath: async (path) => path,
    lstat: async (path) => {
      const value = kind(path);
      return { isSymbolicLink: () => value === 'symlink', isDirectory: () => value === 'dir',
        isFile: () => value !== 'dir' && value !== 'symlink' };
    },
    readFile: async (path) => { log.push(['read', path]); return kind(path); },
    mkdir: async (path) => { log.push(['mkdir', path]); if (!fs.has(path)) fs.set(path, 'dir'); },
    writeExclusive: async (path, data) => {
      log.push(['write', path]);
      if (typeof writeFails === 'function' ? writeFails() : writeFails) { fs.set(path, 'partial'); throw new Error('disk full'); }
      fs.set(path, data);
      await afterWrite(fs);
    },
    rename: async (from, to) => { log.push(['rename', from, to]); fs.set(to, kind(from)); fs.delete(from); },
    rm: async (path) => { log.push(['rm', path]); fs.delete(path); },
  };
  const store = createCommentStore({ io, newId: () => `id${++id}`, now: () => new Date('2026-10-02T09:00:00Z') });
  return { store, loader: createCommentLoader(io), fs, log };
}
const request = (revision: string, patch: Record<string, unknown> = {}) => ({ file: 'src/a.js', line: 2, text: 'Why?', revision, ...patch });
function responseJson(response: ResponseDescription): Record<string, unknown> {
  assert.ok(response.body !== undefined);
  const value: unknown = JSON.parse(response.body.toString());
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function commentHandler(store: ReturnType<typeof createCommentStore>, loader?: ReturnType<typeof createCommentLoader>) {
  const unused = (): never => { throw new Error('Unexpected non-comment capability'); };
  return createRequestHandler({
    getWorktrees: async () => [{ path: '/repo' }], createComment: store.create,
    getTree: unused, getContent: unused, getCommits: unused, getComments: loader ?? unused,
    watchWorktree: unused, subscribeToWorktreeChanges: unused, subscribeToActivity: unused,
    readStatic: unused, publicDir: '/unused', worktreeDeletion: { preview: unused, remove: unused },
  });
}

test('a failed queued save recovers through the real handler, store and loader without losing deterministic identities', async () => {
  let writes = 0;
  const f = fixture({ writeFails: () => ++writes === 1 });
  const handle = commentHandler(f.store, f.loader);
  const post = (input: unknown) => handle({ method: 'POST', pathname: '/api/comments',
    searchParams: new URLSearchParams({ worktree: '/repo' }), headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(input) });
  const responses = await Promise.all([post(request('absent')), post(request('absent'))]);
  assert.deepEqual(responses.map((response) => response.status), [500, 201]);
  assert.deepEqual(responseJson(responses[0]), { error: 'Could not save comment', conflict: false, revision: null });
  const created = parseComments(f.fs.get(SIDECAR)).threads[0];
  assert.equal(created.id, 'thread-id4');
  assert.equal(created.messages[0].id, 'message-id5');
  assert.equal(created.created_at, '2026-10-02T09:00:00.000Z');
  assert.equal([...f.fs.keys()].some((path) => path.endsWith('.tmp')), false);
  const loaded = await handle({ method: 'GET', pathname: '/api/comments', searchParams: new URLSearchParams({ worktree: '/repo' }) });
  assert.equal(loaded.status, 200);
  assert.deepEqual(responseJson(loaded), { threads: [{ ...created, unavailable: null }], warning: null, revision: commentsRevision(f.fs.get(SIDECAR)) });
  const resolved = await post({ action: 'set-resolved', threadId: created.id, resolved: true, revision: responseJson(loaded).revision });
  assert.equal(resolved.status, 201);
  const replied = await post({ threadId: created.id, text: 'Still needs review', revision: responseJson(resolved).revision });
  assert.equal(replied.status, 201);
  const final = (await f.loader('/repo')).threads[0];
  assert.equal(final.resolved, false);
  assert.equal(final.id, created.id);
  assert.equal(final.created_at, created.created_at);
  assert.deepEqual(final.messages[0], created.messages[0]);
  assert.deepEqual(final.messages[1], { id: 'message-id8', author: 'user', text: 'Still needs review', created_at: created.created_at });
});

test('resolution route persists chosen flags without creating messages and rejects stale or ambiguous mutations', async () => {
  const { store, fs, log } = fixture();
  const first = await store.create('/repo', request('absent'));
  const other = await store.create('/repo', request(first.revision, { text: 'Is this resolved?' }));
  const handle = commentHandler(store);
  const post = (input: unknown, patch: Partial<RequestDescription> = {}) => handle({ method: 'POST', pathname: '/api/comments',
    searchParams: new URLSearchParams({ worktree: '/repo' }), headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(input), ...patch });
  const input = { action: 'set-resolved', threadId: first.thread.id, resolved: true, revision: other.revision };
  log.length = 0;
  assert.equal((await post(input, { headers: { host: 'localhost', origin: 'http://evil', 'content-type': 'application/json' } })).status, 403);
  assert.equal((await post(input, { searchParams: new URLSearchParams({ worktree: '/unknown' }) })).status, 404);
  for (const patch of [{ resolved: 'true' }, { text: 'reply' }, { action: 'unknown' }, { action: undefined }, { revision: undefined }]) {
    assert.equal((await post({ ...input, ...patch })).status, 400);
  }
  assert.equal((await post({ ...input, threadId: 'missing' })).status, 409);
  assert.equal(log.some(([step]) => step === 'write'), false);
  const response = await post(input);
  assert.equal(response.status, 201);
  const result = responseJson(response);
  assert.deepEqual(result.thread, { ...first.thread, resolved: true });
  assert.deepEqual(parseComments(fs.get(SIDECAR)).threads, [{ ...first.thread, resolved: true }, other.thread]);
  const before = fs.get(SIDECAR);
  const stale = await post(input);
  assert.equal(stale.status, 409);
  assert.equal(responseJson(stale).conflict, true);
  assert.equal(fs.get(SIDECAR), before);
  const reopened = await post({ ...input, revision: result.revision, resolved: false });
  assert.equal(reopened.status, 201);
  assert.deepEqual(parseComments(fs.get(SIDECAR)).threads, [first.thread, other.thread]);
});

test('resolution of general or unavailable threads shares reply serialization and refuses unsafe or failed writes', async () => {
  const message = { id: 'original', author: 'agent', text: 'Fixed', created_at: '2026-10-01T12:00:00Z' };
  const threads = [
    { id: 'general', created_at: message.created_at, resolved: false, messages: [message] },
    { id: 'unavailable', file: 'deleted.js', side: 'modified', line_range: { start: 4, end: 8 },
      created_at: message.created_at, resolved: false, messages: [message] },
  ];
  const source = JSON.stringify({ version: 1, threads });
  const input = { action: 'set-resolved', threadId: 'unavailable', resolved: true, revision: commentsRevision(source) };
  const files = { '/repo': 'dir', '/repo/.canopy': 'dir', [SIDECAR]: source };
  const f = fixture({ files });
  const results = await Promise.allSettled([f.store.create('/repo', input),
    f.store.create('/repo', { threadId: 'unavailable', text: 'reply', revision: input.revision })]);
  assert.equal(results[0].status, 'fulfilled');
  assert.ok(results[1].status === 'rejected');
  const reason: unknown = results[1].reason;
  assert.equal(errorDetails(reason).conflict, true);
  const general = await f.store.create('/repo', { ...input, threadId: 'general', revision: results[0].value.revision });
  assert.deepEqual(general.thread, { ...threads[0], resolved: true });
  assert.deepEqual(parseComments(f.fs.get(SIDECAR)).threads, threads.map((thread) => ({ ...thread, resolved: true })));
  const failures: [string, boolean, number | undefined][] = [[source, true, undefined], ['version: 2\nthreads: []', false, 409], ['symlink', false, 409]];
  for (const [data, writeFails, status] of failures) {
    const failed = fixture({ writeFails, files: { ...files, [SIDECAR]: data } });
    await assert.rejects(failed.store.create('/repo', { ...input, revision: commentsRevision(data) }), (err: unknown) => errorDetails(err).status === status);
    assert.equal(failed.fs.get(SIDECAR), data);
    assert.equal(failed.log.some(([step]) => step === 'rename'), false);
    assert.equal([...failed.fs.keys()].some((path) => path.endsWith('.tmp')), false);
  }
});

test('registered same-origin reply route uses the shared atomic revision guard and preserves unseen messages', async () => {
  const { store, fs, log } = fixture();
  const first = await store.create('/repo', request('absent'));
  const second = await store.create('/repo', request(first.revision, { text: 'unrelated' }));
  fs.set(SIDECAR, fs.get(SIDECAR).replace('resolved: false', 'resolved: true'));
  const revision = commentsRevision(fs.get(SIDECAR));
  const handle = commentHandler(store);
  const post = (input: unknown, patch: Partial<RequestDescription> = {}) => handle({ method: 'POST', pathname: '/api/comments',
    searchParams: new URLSearchParams({ worktree: '/repo' }), headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(input), ...patch });
  const input = { threadId: first.thread.id, text: 'Done <b>literal</b>', revision };
  log.length = 0;
  assert.equal((await post(input, { headers: { host: 'localhost', origin: 'http://evil', 'content-type': 'application/json' } })).status, 403);
  assert.equal((await post(input, { searchParams: new URLSearchParams({ worktree: '/unknown' }) })).status, 404);
  assert.equal((await post({ ...input, threadId: 'missing' })).status, 409);
  assert.equal((await post({ ...input, text: ' ' })).status, 400);
  assert.equal(log.some(([step]) => step === 'write'), false);
  const response = await post(input);
  assert.equal(response.status, 201);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const result = responseJson(response);
  const threads = parseComments(fs.get(SIDECAR)).threads;
  assert.equal(threads[0].resolved, false);
  assert.deepEqual(threads[0].messages[0], first.thread.messages[0]);
  assert.equal(threads[0].messages[1].author, 'user');
  assert.equal(threads[0].messages[1].text, input.text);
  assert.deepEqual(threads[1], second.thread);
  assert.equal(result.revision, commentsRevision(fs.get(SIDECAR)));
  const before = fs.get(SIDECAR);
  assert.equal((await post(input)).status, 409);
  assert.equal(fs.get(SIDECAR), before);
});

test('general and unavailable anchored threads can be replied to without relocating their anchors', async () => {
  const message = { id: 'original', author: 'agent', text: 'Fixed', created_at: '2026-10-01T12:00:00Z' };
  const threads = [
    { id: 'general', created_at: message.created_at, resolved: true, messages: [message] },
    { id: 'unavailable', file: 'deleted.js', side: 'modified', line_range: { start: 4, end: 8 },
      created_at: message.created_at, resolved: true, messages: [message] },
  ];
  const source = JSON.stringify({ version: 1, threads });
  const { store, fs } = fixture({ files: { '/repo': 'dir', '/repo/.canopy': 'dir', [SIDECAR]: source } });
  let revision = commentsRevision(source);
  for (const thread of threads) {
    const result = await store.create('/repo', { threadId: thread.id, text: 'Still open?', revision });
    revision = result.revision;
    assert.deepEqual(result.thread, { ...thread, resolved: false, messages: [message, result.thread.messages[1]] });
  }
  assert.equal(parseComments(fs.get(SIDECAR)).threads.length, 2);
});

test('reply and new-thread mutations share a queue and reply failures preserve the atomic sidecar boundary', async () => {
  const seeded = fixture();
  const first = await seeded.store.create('/repo', request('absent'));
  const input = { threadId: first.thread.id, text: 'reply', revision: first.revision };
  const results = await Promise.allSettled([seeded.store.create('/repo', input), seeded.store.create('/repo', request(first.revision))]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.ok(results[1].status === 'rejected');
  const reason: unknown = results[1].reason;
  assert.equal(errorDetails(reason).conflict, true);
  const before = seeded.fs.get(SIDECAR);
  const failures: [string, boolean, number | undefined][] = [[before, true, undefined], ['version: 2\nthreads: []', false, 409], ['symlink', false, 409]];
  for (const [data, writeFails, status] of failures) {
    const { store, fs, log } = fixture({ writeFails, files: { '/repo': 'dir', '/repo/.canopy': 'dir', [SIDECAR]: data } });
    await assert.rejects(store.create('/repo', { ...input, revision: commentsRevision(data) }), (err: unknown) => errorDetails(err).status === status);
    assert.equal(fs.get(SIDECAR), data);
    assert.equal(log.some(([step]) => step === 'rename'), false);
    assert.equal([...fs.keys()].some((path) => path.endsWith('.tmp')), false);
  }
});

test('first save lazily creates the sidecar via a temp file and atomic rename', async () => {
  const { store, fs, log } = fixture();
  const result = await store.create('/repo', request('absent'));
  assert.equal(result.thread.id, 'thread-id1');
  assert.equal(result.thread.messages[0].id, 'message-id2');
  assert.equal(result.thread.created_at, '2026-10-02T09:00:00.000Z');
  assert.equal(result.revision, commentsRevision(fs.get(SIDECAR)));
  assert.deepEqual(parseComments(fs.get(SIDECAR)).threads, [result.thread]);
  assert.deepEqual(log.map(([step]) => step), ['mkdir', 'write', 'rename']);
  const last = log.at(-1); assert.ok(last);
  assert.equal(last[2], SIDECAR);
  assert.match(last[1], /comments\.yaml\.id3\.tmp$/);
  assert.equal([...fs.keys()].some((path) => path.endsWith('.tmp')), false);
});

test('later saves keep unrelated threads and report the new revision', async () => {
  const { store, fs } = fixture();
  const first = await store.create('/repo', request('absent', { text: 'one' }));
  const second = await store.create('/repo', request(first.revision, { text: 'two', line: 1 }));
  assert.deepEqual(parseComments(fs.get(SIDECAR)).threads.map((t) => t.messages[0].text), ['one', 'two']);
  assert.equal(second.revision, commentsRevision(fs.get(SIDECAR)));
});

test('stale revisions are rejected with the latest revision and nothing is written', async () => {
  const { store, fs, log } = fixture();
  await store.create('/repo', request('absent'));
  const before = fs.get(SIDECAR);
  log.length = 0;
  for (const stale of ['absent', 'deadbeef']) {
    await assert.rejects(store.create('/repo', request(stale)), (error: unknown) => {
      const err = errorDetails(error);
      return err.status === 409 && err.conflict === true && err.revision === commentsRevision(before);
    });
  }
  assert.equal(fs.get(SIDECAR), before);
  assert.deepEqual(log.filter(([step]) => ['write', 'rename', 'mkdir'].includes(step)), []);
});

test('an external edit after the client loaded is detected by reread, not overwritten', async () => {
  const { store, fs } = fixture();
  const first = await store.create('/repo', request('absent'));
  fs.set(SIDECAR, fs.get(SIDECAR).replace('Why?', 'Edited by agent'));
  await assert.rejects(store.create('/repo', request(first.revision)), { status: 409, conflict: true });
  assert.match(fs.get(SIDECAR), /Edited by agent/);
});

test('an agent replacement during the temp write returns a visible conflict and preserves its data for every mutation', async () => {
  const seeded = fixture();
  const first = await seeded.store.create('/repo', request('absent'));
  const source = seeded.fs.get(SIDECAR);
  const external = source.replace('Why?', 'Edited by agent');
  for (const input of [request(first.revision),
    { threadId: first.thread.id, text: 'reply', revision: first.revision },
    { action: 'set-resolved', threadId: first.thread.id, resolved: true, revision: first.revision }]) {
    const { store, fs, log } = fixture({ files: { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x',
      '/repo/.canopy': 'dir', [SIDECAR]: source }, idStart: 10, afterWrite: (files) => files.set(SIDECAR, external) });
    const handle = commentHandler(store);
    const response = await handle({ method: 'POST', pathname: '/api/comments',
      searchParams: new URLSearchParams({ worktree: '/repo' }), headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify(input) });
    assert.equal(response.status, 409);
    assert.deepEqual(responseJson(response), {
      error: 'Comments changed since you loaded them. They were reloaded; review them and save again.',
      conflict: true, revision: commentsRevision(external),
    });
    assert.equal(fs.get(SIDECAR), external);
    assert.equal(log.some(([step]) => step === 'rename'), false);
    assert.ok(log.some(([step]) => step === 'rm'));
    assert.equal([...fs.keys()].some((path) => path.endsWith('.tmp')), false);
  }
});

test('malformed or unsupported existing data is refused and left untouched', async () => {
  for (const bad of ['threads: [', 'version: 2\nthreads: []\n']) {
    const { store, fs, log } = fixture({ files: { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/repo/.canopy': 'dir', [SIDECAR]: bad } });
    await assert.rejects(store.create('/repo', request(commentsRevision(bad))), { status: 409 });
    assert.equal(fs.get(SIDECAR), bad);
    assert.deepEqual(log.filter(([step]) => ['write', 'rename'].includes(step)), []);
  }
});

test('unsafe inputs and symlinked or non-file paths are rejected before any write', async () => {
  const unsafe = [request('absent', { file: '../x' }), request('absent', { file: 'missing.js' }),
    request('absent', { file: 'src' }), request('absent', { line: 0 }), request('absent', { text: ' ' }), { ...request('absent'), revision: undefined }];
  for (const input of unsafe) {
    const { store, log } = fixture();
    await assert.rejects(store.create('/repo', input), { status: 400 });
    assert.deepEqual(log, []);
  }
  const unsafeAnchors: Record<string, string>[] = [
    { '/repo': 'dir', '/repo/src': 'symlink', '/repo/src/a.js': 'x' },
    { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'symlink' },
  ];
  for (const files of unsafeAnchors) {
    const { store, log } = fixture({ files });
    await assert.rejects(store.create('/repo', request('absent')), { status: 400 });
    assert.deepEqual(log, []);
  }
  const unsafeSidecars: Record<string, string>[] = [
    { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/repo/.canopy': 'symlink' },
    { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/repo/.canopy': 'dir', [SIDECAR]: 'symlink' },
  ];
  for (const files of unsafeSidecars) {
    const { store, log } = fixture({ files });
    await assert.rejects(store.create('/repo', request('absent')), { status: 409 });
    assert.deepEqual(log.filter(([step]) => ['write', 'rename', 'mkdir'].includes(step)), []);
  }
});

test('a failed atomic write leaves the original sidecar and removes the temp file', async () => {
  const seeded = fixture();
  const first = await seeded.store.create('/repo', request('absent'));
  const before = seeded.fs.get(SIDECAR);
  const { store, fs, log } = fixture({ writeFails: true, idStart: 10, files: { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/repo/.canopy': 'dir', [SIDECAR]: before } });
  await assert.rejects(store.create('/repo', request(first.revision)), /disk full/);
  assert.equal(fs.get(SIDECAR), before);
  assert.equal([...fs.keys()].some((path) => path.endsWith('.tmp')), false);
  assert.ok(log.some(([step]) => step === 'rm'));
  assert.equal(log.some(([step]) => step === 'rename'), false);
});

test('concurrent saves in one worktree are serialized so the second sees a conflict', async () => {
  const { store } = fixture();
  const results = await Promise.allSettled([store.create('/repo', request('absent')), store.create('/repo', request('absent'))]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.ok(results[1].status === 'rejected');
  const reason: unknown = results[1].reason;
  assert.equal(errorDetails(reason).status, 409);
});

test('worktrees are isolated: a save only touches the selected worktree sidecar', async () => {
  const files = { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/other': 'dir', '/other/src': 'dir', '/other/src/a.js': 'x' };
  const { store, fs } = fixture({ files });
  await store.create('/other', request('absent'));
  assert.equal(fs.has('/repo/.canopy/comments.yaml'), false);
  assert.ok(fs.has('/other/.canopy/comments.yaml'));
});

test('a range thread is saved and reloaded with its inclusive range', async () => {
  const { store, fs } = fixture();
  const result = await store.create('/repo', request('absent', { line: 1, endLine: 2 }));
  assert.ok('line_range' in result.thread);
  assert.deepEqual(result.thread.line_range, { start: 1, end: 2 });
  const loaded = parseComments(fs.get(SIDECAR)).threads[0];
  assert.ok('line_range' in loaded);
  assert.deepEqual(loaded.line_range, { start: 1, end: 2 });
});

test('an invalid range, or a range on a stale revision, writes nothing and keeps unseen messages', async () => {
  const { store, fs, log } = fixture();
  const first = await store.create('/repo', request('absent', { text: 'seen elsewhere' }));
  const before = fs.get(SIDECAR);
  log.length = 0;
  await assert.rejects(store.create('/repo', request(first.revision, { line: 2, endLine: 1 })), { status: 400 });
  await assert.rejects(store.create('/repo', request('absent', { line: 1, endLine: 2 })), { status: 409, conflict: true });
  assert.equal(fs.get(SIDECAR), before);
  assert.deepEqual(log.filter(([step]) => ['write', 'rename', 'mkdir'].includes(step)), []);
});
