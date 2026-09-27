import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './app.js';
import { parseWorktreeList } from './porcelain.js';

const execFileAsync = promisify(execFile);

async function startServer() {
  const server = createApp();
  server.listen(0);
  await once(server, 'listening');
  return { server, port: server.address().port };
}

function request(port, method, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, method, path: requestPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject)
      .end();
  });
}

function get(port, requestPath) {
  return request(port, 'GET', requestPath);
}

test('GET /api/worktrees returns this repo\'s real worktrees as JSON', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  // Independently derive the expected result straight from git + the
  // already-tested parser, so this test verifies the HTTP wiring rather
  // than re-asserting the parser's own logic.
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
  const expected = parseWorktreeList(stdout);

  const res = await get(port, '/api/worktrees');

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), expected);
  assert.ok(expected.length >= 1, 'expected at least this worktree to be listed');
});

test('GET / serves the page shell', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, '/');

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /<div id="app">/);
});

test('GET /styles.css serves the stylesheet', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, '/styles.css');

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/css/);
});

test('an unknown path returns 404', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, '/does-not-exist.js');

  assert.equal(res.statusCode, 404);
});

test('HEAD requests get headers without a body', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const apiRes = await request(port, 'HEAD', '/api/worktrees');
  assert.equal(apiRes.statusCode, 200);
  assert.match(apiRes.headers['content-type'], /application\/json/);
  assert.equal(apiRes.body, '');

  const pageRes = await request(port, 'HEAD', '/');
  assert.equal(pageRes.statusCode, 200);
  assert.match(pageRes.headers['content-type'], /text\/html/);
  assert.equal(pageRes.body, '');
});

test('serializes injected worktrees end to end, including bare/detached/locked/prunable shapes', async (t) => {
  const fixture = [
    {
      path: '/repos/canopy',
      head: 'a8c8e65b40e000beb566ebdc65256176636bc075',
      branch: 'main',
      detached: false,
      bare: false,
      locked: false,
      lockedReason: null,
      prunable: false,
      prunableReason: null,
    },
    {
      path: '/repos/canopy.git',
      head: null,
      branch: null,
      detached: false,
      bare: true,
      locked: false,
      lockedReason: null,
      prunable: false,
      prunableReason: null,
    },
    {
      path: '/repos/canopy-worktrees/detached',
      head: '1234abcd1234abcd1234abcd1234abcd1234abcd',
      branch: null,
      detached: true,
      bare: false,
      locked: false,
      lockedReason: null,
      prunable: false,
      prunableReason: null,
    },
    {
      path: '/repos/canopy-worktrees/locked',
      head: '5678abcd5678abcd5678abcd5678abcd5678abcd',
      branch: 'wip',
      detached: false,
      bare: false,
      locked: true,
      lockedReason: 'in progress',
      prunable: false,
      prunableReason: null,
    },
    {
      path: '/repos/canopy-worktrees/gone',
      head: '90efcd9090efcd9090efcd9090efcd9090efcd90',
      branch: null,
      detached: true,
      bare: false,
      locked: false,
      lockedReason: null,
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    },
  ];

  const server = createApp({ listWorktrees: async () => fixture });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(port, '/api/worktrees');

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), fixture);
});
