import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentLoader } from '../../server/comment-loader.js';

const conversation = {
  id: 't', file: 'src/app.js', side: 'modified', line_range: { start: 1, end: 2 },
  created_at: '2026-10-01T12:00:00Z', resolved: false,
  messages: [{ id: 'm', author: 'user', text: 'Review this', created_at: '2026-10-01T12:00:00Z' }],
};
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
function fixture(overrides = {}, threads = [conversation]) {
  const reads = [];
  const checked = [];
  const loader = createCommentLoader({
    realpath: async (path) => path,
    lstat: async (path) => {
      checked.push(path);
      const kind = overrides[path] ?? (path.endsWith('.js') || path.endsWith('.yaml') ? 'file' : 'directory');
      if (kind === 'missing') throw missing();
      return { isSymbolicLink: () => kind === 'symlink', isFile: () => kind === 'file', isDirectory: () => kind === 'directory' };
    },
    readFile: async (path) => { reads.push(path); return JSON.stringify({ version: 1, threads }); },
  });
  return { loader, reads, checked };
}

test('general conversations never check an absent anchor path, alongside unavailable file threads', async () => {
  const { file, side, line_range, ...general } = { ...conversation, id: 'general' };
  const f = fixture({ '/repo/src/app.js': 'missing' }, [general, conversation]);
  const result = await f.loader('/repo');
  assert.equal(result.warning, null);
  assert.deepEqual(result.threads[0], general);
  assert.match(result.threads[1].unavailable, /missing/);
  assert.deepEqual(f.checked, ['/repo/.canopy', '/repo/.canopy/comments.yaml', '/repo/src', '/repo/src/app.js']);
});

test('reads only the fixed sidecar and checks anchor availability without reading anchor content', async () => {
  const f = fixture();
  assert.deepEqual(await f.loader('/repo'), { warning: null, threads: [{ ...conversation, unavailable: null }] });
  assert.deepEqual(f.reads, ['/repo/.canopy/comments.yaml']);
  assert.ok(f.checked.includes('/repo/src/app.js'));
});

test('missing sidecars are empty; unsafe/dangling symlinks and unavailable anchors are never followed', async () => {
  for (const target of ['/repo/.canopy', '/repo/.canopy/comments.yaml']) {
    const absent = fixture({ [target]: 'missing' });
    assert.deepEqual(await absent.loader('/repo'), { threads: [], warning: null });
    assert.deepEqual(absent.reads, []);
    const symlink = fixture({ [target]: 'symlink' });
    const result = await symlink.loader('/repo');
    assert.deepEqual(result.threads, []);
    assert.match(result.warning, /symlink/i);
    assert.deepEqual(symlink.reads, []);
  }
  for (const [target, kind, reason] of [
    ['/repo/src', 'symlink', /symlink/i], ['/repo/src/app.js', 'symlink', /symlink/i],
    ['/repo/src/app.js', 'missing', /missing/i], ['/repo/src/app.js', 'directory', /regular file/i],
  ]) {
    const f = fixture({ [target]: kind });
    const result = await f.loader('/repo');
    assert.match(result.threads[0].unavailable, reason);
    assert.equal(result.threads[0].messages[0].text, 'Review this');
    assert.deepEqual(f.reads, ['/repo/.canopy/comments.yaml']);
    if (target === '/repo/src') assert.ok(!f.checked.includes('/repo/src/app.js'));
  }
});
