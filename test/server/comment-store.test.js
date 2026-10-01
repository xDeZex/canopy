import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentStore } from '../../server/comment-store.js';
import { commentsRevision, parseComments } from '../../server/comments.js';

const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const SIDECAR = '/repo/.canopy/comments.yaml';

// In-memory filesystem: path -> 'dir' | 'symlink' | file text.
function fixture({ files = { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x\ny\n' }, writeFails = false, idStart = 0 } = {}) {
  const fs = new Map(Object.entries(files));
  const log = [];
  let id = idStart;
  const kind = (path) => { if (!fs.has(path)) throw enoent(); const value = fs.get(path); return value; };
  const io = {
    realpath: async (path) => path,
    lstat: async (path) => {
      const value = kind(path);
      return { isSymbolicLink: () => value === 'symlink', isDirectory: () => value === 'dir',
        isFile: () => value !== 'dir' && value !== 'symlink' };
    },
    readFile: async (path) => { log.push(['read', path]); return fs.get(path); },
    mkdir: async (path) => { log.push(['mkdir', path]); if (!fs.has(path)) fs.set(path, 'dir'); },
    writeExclusive: async (path, data) => {
      log.push(['write', path]);
      if (writeFails) { fs.set(path, 'partial'); throw new Error('disk full'); }
      fs.set(path, data);
    },
    rename: async (from, to) => { log.push(['rename', from, to]); fs.set(to, fs.get(from)); fs.delete(from); },
    rm: async (path) => { log.push(['rm', path]); fs.delete(path); },
  };
  const store = createCommentStore({ io, newId: () => `id${++id}`, now: () => new Date('2026-10-02T09:00:00Z') });
  return { store, fs, log };
}
const request = (revision, patch = {}) => ({ file: 'src/a.js', line: 2, text: 'Why?', revision, ...patch });

test('first save lazily creates the sidecar via a temp file and atomic rename', async () => {
  const { store, fs, log } = fixture();
  const result = await store.create('/repo', request('absent'));
  assert.equal(result.thread.id, 'thread-id1');
  assert.equal(result.thread.messages[0].id, 'message-id2');
  assert.equal(result.thread.created_at, '2026-10-02T09:00:00.000Z');
  assert.equal(result.revision, commentsRevision(fs.get(SIDECAR)));
  assert.deepEqual(parseComments(fs.get(SIDECAR)).threads, [result.thread]);
  assert.deepEqual(log.map(([step]) => step), ['mkdir', 'write', 'rename']);
  assert.equal(log.at(-1)[2], SIDECAR);
  assert.match(log.at(-1)[1], /comments\.yaml\.id3\.tmp$/);
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
    await assert.rejects(store.create('/repo', request(stale)), (err) =>
      err.status === 409 && err.conflict === true && err.revision === commentsRevision(before));
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
  for (const files of [
    { '/repo': 'dir', '/repo/src': 'symlink', '/repo/src/a.js': 'x' },
    { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'symlink' },
  ]) {
    const { store, log } = fixture({ files });
    await assert.rejects(store.create('/repo', request('absent')), { status: 400 });
    assert.deepEqual(log, []);
  }
  for (const files of [
    { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/repo/.canopy': 'symlink' },
    { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/repo/.canopy': 'dir', [SIDECAR]: 'symlink' },
  ]) {
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
  assert.equal(results[1].reason.status, 409);
});

test('worktrees are isolated: a save only touches the selected worktree sidecar', async () => {
  const files = { '/repo': 'dir', '/repo/src': 'dir', '/repo/src/a.js': 'x', '/other': 'dir', '/other/src': 'dir', '/other/src/a.js': 'x' };
  const { store, fs } = fixture({ files });
  await store.create('/other', request('absent'));
  assert.equal(fs.has('/repo/.canopy/comments.yaml'), false);
  assert.ok(fs.has('/other/.canopy/comments.yaml'));
});
