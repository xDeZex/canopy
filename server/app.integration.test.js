import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from './app.js';

// The one test that runs the app's default git-backed dependencies against a
// real repo (this one), to check the wiring the injected-fake tests skip.
test('smoke: the default dependencies serve this repo\'s worktrees over HTTP', async (t) => {
  const server = createApp({ repoRoot: process.cwd() });
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
  assert.ok(worktrees.length >= 1);
  assert.equal(typeof worktrees[0].path, 'string');
});
