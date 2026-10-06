import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../../server/app.js';
import { createListWorktrees } from '../../server/default-deps.js';
import { fakeGit } from './fake-git.js';

test('HTTP static IO preserves MIME, byte length and HEAD semantics with a fake filesystem', async (t) => {
  const reads: string[] = [];
  const server = createApp({
    listWorktrees: async () => [],
    readStatic: async (file: string) => {
      reads.push(file);
      if (file.endsWith('/missing.js')) throw new Error('missing');
      return Buffer.from('é');
    },
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = (method: string, path: string) => new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: address.port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
  for (const [path, mime] of [
    ['/', 'text/html; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'], ['/blob.bin', 'application/octet-stream'],
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(method, path);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], mime);
      assert.equal(response.headers['content-length'], '2');
      assert.equal(response.body, method === 'HEAD' ? '' : 'é');
    }
  }
  const missing = await request('GET', '/missing.js');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'Not found' });
  assert.equal(reads.length, 9);
  assert.ok(reads[0].endsWith('/public/index.html'));
});

test('discovery refuses an unconfigured fake Git listing instead of silently inventing an empty repository', async () => {
  const { runGit } = fakeGit({ 'rev-parse': 'aaa\n' });
  await assert.rejects(createListWorktrees('/main', runGit)(), /Unexpected Git call: worktree list --porcelain/);
});

test('discovery keeps Git identity/order while selecting a linked worktree and labeling the actual main worktree', async () => {
  const { runGit, calls } = fakeGit({
    worktree: 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /other\nHEAD bbb\ndetached\n\nworktree /linked\nHEAD ccc\nbranch refs/heads/topic\n',
    'rev-parse': 'ddd\n',
  });
  const worktrees = await createListWorktrees('/linked', runGit)();
  assert.deepEqual(worktrees.map(({ path, head, branch, deletionReason, originMainSha }) =>
    ({ path, head, branch, deletionReason, originMainSha })), [
    { path: '/linked', head: 'ccc', branch: 'topic', deletionReason: 'Server is running in this worktree', originMainSha: 'ddd' },
    { path: '/main', head: 'aaa', branch: 'main', deletionReason: 'Main worktree cannot be deleted', originMainSha: 'ddd' },
    { path: '/other', head: 'bbb', branch: null, deletionReason: null, originMainSha: 'ddd' },
  ]);
  assert.ok(calls.every(({ cwd }) => cwd === '/linked'));
});

// Exercise the Git-backed list and HTTP adapter without inspecting a real
// repository. All Git IO stays at the injected boundary.
test('smoke: the Git-backed worktree list is served over HTTP with fake Git', async (t) => {
  const sha = 'a'.repeat(40);
  const { runGit: git } = fakeGit((args, cwd) => {
    assert.equal(cwd, '/main');
    if (args[0] === 'worktree' && args[1] === 'list') return `worktree /main\nHEAD ${sha}\nbranch refs/heads/main\n`;
    if (args[0] === 'rev-parse') return `${sha}\n`;
    throw new Error(`Unexpected Git call: ${args}`);
  });
  const options = { repoRoot: '/main', listWorktrees: createListWorktrees('/main', git) };
  const server = createApp(options);
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const res = await new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: address.port, path: '/api/worktrees' }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (body += chunk));
        r.on('end', () => resolve({ statusCode: r.statusCode, body }));
      })
      .on('error', reject);
  });

  assert.equal(res.statusCode, 200);
  const worktrees: unknown = JSON.parse(res.body);
  assert.ok(Array.isArray(worktrees));
  assert.equal(worktrees.length, 1);
  const worktree: unknown = worktrees[0];
  assert.ok(worktree !== null && typeof worktree === 'object');
  assert.ok('path' in worktree && 'originMainSha' in worktree);
  assert.equal(worktree.path, '/main');
  assert.equal(worktree.originMainSha, sha);
});
