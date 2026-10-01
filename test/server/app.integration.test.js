import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../../server/app.js';
import { createListWorktrees } from '../../server/default-deps.js';

// Exercise the Git-backed list and HTTP adapter without inspecting a real
// repository. All Git IO stays at the injected boundary.
test('smoke: the Git-backed worktree list is served over HTTP with fake Git', async (t) => {
  const sha = 'a'.repeat(40);
  const git = async (args, cwd) => {
    assert.equal(cwd, '/main');
    if (args[0] === 'worktree' && args[1] === 'list') return `worktree /main\nHEAD ${sha}\nbranch refs/heads/main\n`;
    if (args[0] === 'rev-parse') return `${sha}\n`;
    throw new Error(`Unexpected Git call: ${args}`);
  };
  const server = createApp({ repoRoot: '/main', listWorktrees: createListWorktrees('/main', git) });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());

  const res = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: server.address().port, path: '/api/worktrees' }, (r) => {
        let body = '';
        r.on('data', (chunk) => (body += chunk));
        r.on('end', () => resolve({ statusCode: r.statusCode, body }));
      })
      .on('error', reject);
  });

  assert.equal(res.statusCode, 200);
  const worktrees = JSON.parse(res.body);
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].path, '/main');
  assert.equal(worktrees[0].originMainSha, sha);
});
