import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './app.js';
import { parseWorktreeList } from './porcelain.js';
import { parseStatus, buildFileTree } from './status.js';
import { readFileContent } from './file-content.js';
import { parseCommitLog, LOG_FORMAT } from './commits.js';

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

test('GET /api/files returns this worktree\'s real file tree with live status', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  // Independently derive the expected tree straight from git + the
  // already-tested parser/merger, so this test verifies the HTTP wiring
  // rather than re-asserting status.js's own logic.
  const { stdout: worktreeOut } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
  const [{ path: worktreePath }] = parseWorktreeList(worktreeOut);
  const [{ stdout: statusOut }, { stdout: lsOut }] = await Promise.all([
    execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath }),
    execFileAsync('git', ['ls-files'], { cwd: worktreePath }),
  ]);
  const expected = buildFileTree(lsOut.split('\n').filter(Boolean), parseStatus(statusOut));

  const res = await get(port, `/api/files?worktree=${encodeURIComponent(worktreePath)}`);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), expected);
});

test('GET /api/files without a worktree query param is a 400', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, '/api/files');

  assert.equal(res.statusCode, 400);
});

test('GET /api/files for an unknown worktree path is a 404', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, `/api/files?worktree=${encodeURIComponent('/nowhere')}`);

  assert.equal(res.statusCode, 404);
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
  assert.deepEqual(JSON.parse(res.body), tree);
});

test('GET /api/file-content returns this worktree\'s real HEAD and working content for a clean file', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  // Independently derive the expected content straight from the already-
  // tested readFileContent, so this test verifies the HTTP wiring rather
  // than re-asserting file-content.js's own logic.
  const { stdout: worktreeOut } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
  const [{ path: worktreePath }] = parseWorktreeList(worktreeOut);
  const expected = await readFileContent(worktreePath, 'README.md');

  const res = await get(
    port,
    `/api/file-content?worktree=${encodeURIComponent(worktreePath)}&file=${encodeURIComponent('README.md')}`
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), { path: 'README.md', ...expected });
  assert.ok(expected.head, 'expected README.md to have HEAD content in this repo');
  assert.equal(expected.head, expected.working, 'expected README.md to be clean (no local edits)');
});

test('GET /api/file-content without a worktree query param is a 400', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, '/api/file-content?file=README.md');

  assert.equal(res.statusCode, 400);
});

test('GET /api/file-content without a file query param is a 400', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, `/api/file-content?worktree=${encodeURIComponent('/repos/canopy')}`);

  assert.equal(res.statusCode, 400);
});

test('GET /api/file-content for an unknown worktree path is a 404', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(
    port,
    `/api/file-content?worktree=${encodeURIComponent('/nowhere')}&file=${encodeURIComponent('README.md')}`
  );

  assert.equal(res.statusCode, 404);
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

test('GET /api/watch without a worktree query param is a 400', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, '/api/watch');

  assert.equal(res.statusCode, 400);
});

test('GET /api/watch for an unknown worktree path is a 404', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, `/api/watch?worktree=${encodeURIComponent('/nowhere')}`);

  assert.equal(res.statusCode, 404);
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

test('GET /api/commits returns this worktree\'s real commit history as JSON', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  // Independently derive the expected list straight from git + the
  // already-tested parser, so this test verifies the HTTP wiring rather
  // than re-asserting commits.js's own logic.
  const { stdout: worktreeOut } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
  const [{ path: worktreePath }] = parseWorktreeList(worktreeOut);
  const { stdout: logOut } = await execFileAsync('git', ['log', `--pretty=format:${LOG_FORMAT}`], {
    cwd: worktreePath,
  });
  const expected = parseCommitLog(logOut);

  const res = await get(port, `/api/commits?worktree=${encodeURIComponent(worktreePath)}`);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), expected);
  assert.ok(expected.length >= 1, 'expected at least one commit in this repo');
});

test('GET /api/commits without a worktree query param is a 400', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, '/api/commits');

  assert.equal(res.statusCode, 400);
});

test('GET /api/commits for an unknown worktree path is a 404', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await get(port, `/api/commits?worktree=${encodeURIComponent('/nowhere')}`);

  assert.equal(res.statusCode, 404);
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
