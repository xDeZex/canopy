import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../../server/app.js';

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

// Opens a request and resolves as soon as headers arrive, leaving the
// response stream open — for exercising the SSE route at the protocol
// level (status/headers, then individual `data: ...` frames as they're
// written) rather than waiting for the connection to end.
function openStream(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: requestPath }, (res) => {
      resolve({ req, res });
    });
    req.on('error', reject);
    req.end();
  });
}

function nextChunk(res) {
  return new Promise((resolve) => res.once('data', (chunk) => resolve(chunk.toString('utf8'))));
}

test('GET /api/worktrees returns the listed worktrees as JSON', async (t) => {
  const worktrees = [{ path: '/main', branch: 'main' }, { path: '/linked', branch: 'wip' }];
  const server = createApp({ listWorktrees: async () => worktrees });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());

  const res = await get(server.address().port, '/api/worktrees');

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), worktrees);
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

test('worktree-scoped routes reject missing and unknown paths before doing route work', async (t) => {
  let listCalls = 0;
  let routeCalls = 0;
  const server = createApp({
    listWorktrees: async () => {
      listCalls++;
      return [{ path: '/repos/canopy' }];
    },
    getFileTree: async () => { routeCalls++; return []; },
    getFileContent: async () => { routeCalls++; return { head: '', working: '' }; },
    listCommits: async () => { routeCalls++; return []; },
    watchWorktree: () => { routeCalls++; return { close() {} }; },
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address();

  for (const method of ['GET', 'HEAD']) {
    for (const route of ['/api/files', '/api/watch', '/api/file-content?file=README.md', '/api/commits']) {
      const separator = route.includes('?') ? '&' : '?';
      const missingError = route.startsWith('/api/file-content')
        ? 'Missing "worktree" or "file" query param'
        : 'Missing "worktree" query param';
      const before = listCalls;
      const missing = await request(port, method, route);
      assert.equal(missing.statusCode, 400, `${method} ${route}`);
      assert.equal(missing.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(missing.headers['content-length'], String(Buffer.byteLength(JSON.stringify({ error: missingError }))));
      assert.equal(missing.body, method === 'HEAD' ? '' : JSON.stringify({ error: missingError }));
      assert.equal(listCalls, before, 'missing worktree must not query worktrees');

      const unknown = await request(port, method, `${route}${separator}worktree=${encodeURIComponent('/nowhere')}`);
      assert.equal(unknown.statusCode, 404, `${method} ${route}`);
      assert.equal(unknown.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(unknown.headers['content-length'], String(Buffer.byteLength(JSON.stringify({ error: 'Unknown worktree' }))));
      assert.equal(unknown.body, method === 'HEAD' ? '' : JSON.stringify({ error: 'Unknown worktree' }));
      assert.equal(listCalls, before + 1, 'unknown worktree must query worktrees once');
      assert.equal(routeCalls, 0, 'rejected requests must not start route work or SSE watchers');
    }
  }
});

test('GET /api/files serializes an injected file tree for the requested worktree', async (t) => {
  const fixture = [
    { path: '/repos/canopy', /* other worktree fields unused by /api/files */ },
  ];
  const tree = [
    { name: 'README.md', type: 'file', path: 'README.md', status: 'clean' },
    {
      name: 'server',
      type: 'dir',
      path: 'server',
      children: [{ name: 'app.js', type: 'file', path: 'server/app.js', status: 'modified' }],
    },
  ];

  const server = createApp({
    listWorktrees: async () => fixture,
    getFileTree: async (worktreePath) => {
      assert.equal(worktreePath, '/repos/canopy');
      return tree;
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(port, `/api/files?worktree=${encodeURIComponent('/repos/canopy')}`);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), tree);
});

test('GET /api/files forwards the ref and defaults to HEAD', async (t) => {
  const calls = [];
  const server = createApp({
    listWorktrees: async () => [{ path: '/repos/canopy' }],
    getFileTree: async (...args) => { calls.push(args); return []; },
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `/api/files?worktree=${encodeURIComponent('/repos/canopy')}`;
  assert.equal((await get(server.address().port, url)).statusCode, 200);
  assert.equal((await get(server.address().port, `${url}&ref=abc1234`)).statusCode, 200);
  assert.deepEqual(calls, [['/repos/canopy', 'HEAD'], ['/repos/canopy', 'abc1234']]);
});

test('GET /api/file-content checks a missing file before resolving the worktree', async (t) => {
  let listCalls = 0;
  const server = createApp({
    listWorktrees: async () => {
      listCalls++;
      return [];
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  for (const query of ['', `?worktree=${encodeURIComponent('/nowhere')}`]) {
    const res = await get(port, `/api/file-content${query}`);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'Missing "worktree" or "file" query param' });
  }
  assert.equal(listCalls, 0);
});

test('GET /api/file-content serializes injected content for the requested worktree and file', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];

  const server = createApp({
    listWorktrees: async () => fixture,
    getFileContent: async (worktreePath, filePath) => {
      assert.equal(worktreePath, '/repos/canopy');
      assert.equal(filePath, 'server/app.js');
      return { head: 'old content\n', working: 'new content\n' };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(
    port,
    `/api/file-content?worktree=${encodeURIComponent('/repos/canopy')}&file=${encodeURIComponent('server/app.js')}`
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), {
    path: 'server/app.js',
    head: 'old content\n',
    working: 'new content\n',
  });
});

test('GET /api/file-content for a path with neither a HEAD nor a working version is a 404', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];

  const server = createApp({
    listWorktrees: async () => fixture,
    getFileContent: async () => ({ head: null, working: null }),
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(
    port,
    `/api/file-content?worktree=${encodeURIComponent('/repos/canopy')}&file=${encodeURIComponent('gone.txt')}`
  );

  assert.equal(res.statusCode, 404);
});

test('GET /api/file-content with a ref param passes it through to content lookup', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];

  const server = createApp({
    listWorktrees: async () => fixture,
    getFileContent: async (worktreePath, filePath, ref) => {
      assert.equal(worktreePath, '/repos/canopy');
      assert.equal(filePath, 'server/app.js');
      assert.equal(ref, 'abc1234');
      return { head: 'content as of abc1234\n', working: 'new content\n' };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(
    port,
    `/api/file-content?worktree=${encodeURIComponent('/repos/canopy')}&file=${encodeURIComponent('server/app.js')}&ref=abc1234`
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), {
    path: 'server/app.js',
    head: 'content as of abc1234\n',
    working: 'new content\n',
  });
});

test('GET /api/file-content without a ref param defaults to HEAD', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];

  const server = createApp({
    listWorktrees: async () => fixture,
    getFileContent: async (worktreePath, filePath, ref) => {
      assert.equal(ref, 'HEAD');
      return { head: 'old content\n', working: 'new content\n' };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(
    port,
    `/api/file-content?worktree=${encodeURIComponent('/repos/canopy')}&file=${encodeURIComponent('server/app.js')}`
  );

  assert.equal(res.statusCode, 200);
});

test('HEAD /api/watch returns SSE headers without opening a watcher', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];
  let watcherStarted = false;

  const server = createApp({
    listWorktrees: async () => fixture,
    watchWorktree: () => {
      watcherStarted = true;
      return { close: () => {} };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await request(port, 'HEAD', `/api/watch?worktree=${encodeURIComponent('/repos/canopy')}`);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.body, '');
  assert.equal(watcherStarted, false, 'a HEAD request should not start a live watcher');
});

test('GET /api/watch starts watching the requested worktree and streams change events as SSE', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];
  let capturedOnChange;

  const server = createApp({
    listWorktrees: async () => fixture,
    watchWorktree: (worktreePath, onChange) => {
      assert.equal(worktreePath, '/repos/canopy');
      capturedOnChange = onChange;
      return { close: () => {} };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const { req, res } = await openStream(port, `/api/watch?worktree=${encodeURIComponent('/repos/canopy')}`);
  t.after(() => req.destroy());

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.ok(capturedOnChange, 'expected the route to start a watcher with an onChange callback');

  const chunkPromise = nextChunk(res);
  capturedOnChange(['server/app.js']);
  const chunk = await chunkPromise;

  assert.equal(chunk, `data: ${JSON.stringify({ paths: ['server/app.js'] })}\n\n`);
});

test('closing the client connection stops the underlying watcher', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];
  let closeCalled;
  const closedPromise = new Promise((resolve) => {
    closeCalled = resolve;
  });

  const server = createApp({
    listWorktrees: async () => fixture,
    watchWorktree: () => ({ close: () => closeCalled() }),
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const { req, res } = await openStream(port, `/api/watch?worktree=${encodeURIComponent('/repos/canopy')}`);
  res.resume(); // drain, since nothing further is read from this response

  req.destroy();

  await closedPromise; // resolves once the route's close() handler runs; hangs (and times out) otherwise
});

test('GET /api/file-content rejects a file path that escapes the worktree', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];

  const server = createApp({
    listWorktrees: async () => fixture,
    getFileContent: async () => {
      throw new Error('should not be called for an escaping path');
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(
    port,
    `/api/file-content?worktree=${encodeURIComponent('/repos/canopy')}&file=${encodeURIComponent('../../etc/passwd')}`
  );

  assert.equal(res.statusCode, 403);
});

test('HEAD /api/watch-worktrees returns SSE headers without starting a poll', async (t) => {
  let pollStarted = false;

  const server = createApp({
    watchWorktreeList: () => {
      pollStarted = true;
      return { close: () => {} };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await request(port, 'HEAD', '/api/watch-worktrees');

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.body, '');
  assert.equal(pollStarted, false, 'a HEAD request should not start a live poll');
});

test('GET /api/watch-worktrees streams worktree-list changes as SSE', async (t) => {
  let capturedOnChange;

  const server = createApp({
    watchWorktreeList: (onChange) => {
      capturedOnChange = onChange;
      return { close: () => {} };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const { req, res } = await openStream(port, '/api/watch-worktrees');
  t.after(() => req.destroy());

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.ok(capturedOnChange, 'expected the route to start a poll with an onChange callback');

  const fixture = [{ path: '/repos/canopy' }, { path: '/repos/canopy-worktrees/new' }];
  const chunkPromise = nextChunk(res);
  capturedOnChange(fixture);
  const chunk = await chunkPromise;

  assert.equal(chunk, `data: ${JSON.stringify(fixture)}\n\n`);
});

test('closing the client connection stops the worktree-list poll', async (t) => {
  let closeCalled;
  const closedPromise = new Promise((resolve) => {
    closeCalled = resolve;
  });

  const server = createApp({
    watchWorktreeList: () => ({ close: () => closeCalled() }),
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const { req, res } = await openStream(port, '/api/watch-worktrees');
  res.resume();

  req.destroy();

  await closedPromise;
});

test('a worktree-poll error is forwarded to the client as a named SSE event', async (t) => {
  let capturedOnError;

  const server = createApp({
    watchWorktreeList: (_onChange, { onError } = {}) => {
      capturedOnError = onError;
      return { close: () => {} };
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const { req, res } = await openStream(port, '/api/watch-worktrees');
  t.after(() => req.destroy());

  const chunkPromise = nextChunk(res);
  capturedOnError(new Error('git worktree list failed'));
  const chunk = await chunkPromise;

  assert.equal(chunk, `event: worktree-poll-error\ndata: ${JSON.stringify({ message: 'git worktree list failed' })}\n\n`);
});

test('GET /api/commits serializes an injected commit list for the requested worktree', async (t) => {
  const fixture = [{ path: '/repos/canopy' }];
  const commits = [
    { sha: 'abc1234', message: 'second commit', date: '2026-09-27T10:00:00+02:00' },
    { sha: 'def5678', message: 'first commit', date: '2026-09-26T10:00:00+02:00' },
  ];

  const server = createApp({
    listWorktrees: async () => fixture,
    listCommits: async (worktreePath) => {
      assert.equal(worktreePath, '/repos/canopy');
      return commits;
    },
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => server.close());

  const res = await get(port, `/api/commits?worktree=${encodeURIComponent('/repos/canopy')}`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), commits);
});

test('GET /api/commits passes the requested file to an injected listCommits, and null when absent', async (t) => {
  const seen = [];
  const server = createApp({
    listWorktrees: async () => [{ path: '/repos/canopy' }],
    listCommits: async (worktreePath, file) => { seen.push(file); return []; },
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `/api/commits?worktree=${encodeURIComponent('/repos/canopy')}`;

  await get(server.address().port, `${base}&file=src%2Fx.js`);
  await get(server.address().port, base);

  assert.deepEqual(seen, ['src/x.js', null]);
});
