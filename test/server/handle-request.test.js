import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler } from '../../server/handle-request.js';

const PUBLIC = '/srv/public';
const worktrees = [{ path: '/main' }, { path: '/linked' }];

function makeHandler(overrides = {}) {
  return createRequestHandler({
    getWorktrees: async () => worktrees,
    getTree: async (worktreePath, ref) => ({ worktreePath, ref }),
    getContent: async () => ({ head: 'h', working: 'w' }),
    getCommits: async (worktreePath, file) => ({ worktreePath, file }),
    watchWorktree: () => ({ close() {} }),
    subscribeToWorktreeChanges: () => () => {},
    readStatic: async () => Buffer.from('static'),
    publicDir: PUBLIC,
    ...overrides,
  });
}

function request(method, url) {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  return { method, pathname, searchParams };
}

const run = (url, method = 'GET', overrides) => makeHandler(overrides)(request(method, url));

test('/api/worktrees responds with the listed worktrees as JSON', async () => {
  const res = await run('/api/worktrees');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['Content-Length'], Buffer.byteLength(res.body));
  assert.deepEqual(JSON.parse(res.body), worktrees);
});

test('HEAD keeps status and headers but drops the body', async () => {
  const get = await run('/api/worktrees');
  const head = await run('/api/worktrees', 'HEAD');
  assert.equal(head.status, 200);
  assert.deepEqual(head.headers, get.headers);
  assert.equal(head.body, undefined);
});

test('non-GET/HEAD methods get a 404', async () => {
  const res = await run('/api/worktrees', 'POST');
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Not found' });
});

test('worktree routes reject a missing worktree param with 400', async () => {
  for (const url of ['/api/files', '/api/watch', '/api/commits']) {
    const res = await run(url);
    assert.equal(res.status, 400, url);
    assert.deepEqual(JSON.parse(res.body), { error: 'Missing "worktree" query param' });
  }
});

test('worktree routes reject an unknown worktree with 404', async () => {
  for (const url of ['/api/files?worktree=/nope', '/api/commits?worktree=/nope', '/api/watch?worktree=/nope']) {
    const res = await run(url);
    assert.equal(res.status, 404, url);
    assert.deepEqual(JSON.parse(res.body), { error: 'Unknown worktree' });
  }
});

test('/api/files defaults ref to HEAD and passes an explicit one through', async () => {
  assert.deepEqual(JSON.parse((await run('/api/files?worktree=/main')).body), { worktreePath: '/main', ref: 'HEAD' });
  assert.deepEqual(JSON.parse((await run('/api/files?worktree=/main&ref=dev')).body), { worktreePath: '/main', ref: 'dev' });
});

test('/api/commits passes the file filter, or null when absent', async () => {
  assert.deepEqual(JSON.parse((await run('/api/commits?worktree=/main')).body), { worktreePath: '/main', file: null });
  assert.deepEqual(JSON.parse((await run('/api/commits?worktree=/main&file=a.js')).body), { worktreePath: '/main', file: 'a.js' });
});

test('/api/file-content responds with path, head and working', async () => {
  const res = await run('/api/file-content?worktree=/main&file=a.js');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { path: 'a.js', head: 'h', working: 'w' });
});

test('/api/file-content rejects a missing file or worktree with the combined message', async () => {
  const message = { error: 'Missing "worktree" or "file" query param' };
  const noFile = await run('/api/file-content?worktree=/main');
  const noWorktree = await run('/api/file-content?file=a.js');
  assert.equal(noFile.status, 400);
  assert.deepEqual(JSON.parse(noFile.body), message);
  assert.equal(noWorktree.status, 400);
  assert.deepEqual(JSON.parse(noWorktree.body), message);
});

test('/api/file-content forbids paths escaping the worktree', async () => {
  const res = await run('/api/file-content?worktree=/main&file=../etc/passwd');
  assert.equal(res.status, 403);
});

test('/api/file-content is 404 when neither side exists', async () => {
  const res = await run('/api/file-content?worktree=/main&file=a.js', 'GET', {
    getContent: async () => ({ head: null, working: null }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Not found' });
});

test('/api/watch is described as an SSE stream that watches the worktree and cleans up', async () => {
  const calls = [];
  const res = await run('/api/watch?worktree=/main', 'GET', {
    watchWorktree: (worktreePath, onChange) => {
      calls.push(['watch', worktreePath]);
      onChange(['a.js']);
      return { close: () => calls.push(['close']) };
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  assert.deepEqual(calls, []);

  const frames = [];
  const cleanup = res.stream.subscribe((frame) => frames.push(frame));
  assert.deepEqual(frames, ['data: {"paths":["a.js"]}\n\n']);
  cleanup();
  assert.deepEqual(calls, [['watch', '/main'], ['close']]);
});

test('/api/watch-worktrees frames snapshots and poll errors, and unsubscribes on cleanup', async () => {
  let unsubscribed = false;
  const res = await run('/api/watch-worktrees', 'GET', {
    subscribeToWorktreeChanges: ({ onChange, onError }) => {
      onChange([{ path: '/a' }]);
      onError(new Error('boom'));
      return () => {
        unsubscribed = true;
      };
    },
  });
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');

  const frames = [];
  const cleanup = res.stream.subscribe((frame) => frames.push(frame));
  assert.deepEqual(frames, [
    'data: [{"path":"/a"}]\n\n',
    'event: worktree-poll-error\ndata: {"message":"boom"}\n\n',
  ]);
  cleanup();
  assert.equal(unsubscribed, true);
});

test('HEAD on an SSE route gets the headers with no stream and starts no watcher', async () => {
  let started = false;
  const res = await run('/api/watch?worktree=/main', 'HEAD', {
    watchWorktree: () => {
      started = true;
      return { close() {} };
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.stream, undefined);
  assert.equal(started, false);

  const list = await run('/api/watch-worktrees', 'HEAD');
  assert.equal(list.status, 200);
  assert.equal(list.stream, undefined);
});

test('static: / serves index.html with its content type and length', async () => {
  const read = [];
  const res = await run('/', 'GET', { readStatic: async (p) => (read.push(p), Buffer.from('<html>')) });
  assert.deepEqual(read, ['/srv/public/index.html']);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['Content-Length'], 6);
  assert.equal(res.body.toString(), '<html>');
});

test('static: unknown extensions fall back to octet-stream and HEAD drops the body', async () => {
  const res = await run('/blob.bin', 'HEAD');
  assert.equal(res.headers['Content-Type'], 'application/octet-stream');
  assert.equal(res.headers['Content-Length'], 6);
  assert.equal(res.body, undefined);
});

test('static: a read failure is a 404', async () => {
  const res = await run('/missing.js', 'GET', {
    readStatic: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(res.status, 404);
});

test('static: paths escaping the public dir are forbidden', async () => {
  const res = await makeHandler()({ method: 'GET', pathname: '/../secret', searchParams: new URLSearchParams() });
  assert.equal(res.status, 403);
});

test('dependency errors propagate to the caller', async () => {
  await assert.rejects(
    run('/api/worktrees', 'GET', {
      getWorktrees: async () => {
        throw new Error('git failed');
      },
    }),
    /git failed/
  );
});
