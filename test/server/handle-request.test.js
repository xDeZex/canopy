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

test('comments route is read-only, membership-scoped and ignores arbitrary sidecar/file/ref parameters', async () => {
  const calls = [];
  const handler = makeHandler({ getComments: async (path) => { calls.push(path); return { threads: [], warning: 'Invalid YAML' }; } });
  for (const [url, method, status] of [
    ['/api/comments', 'GET', 400], ['/api/comments?worktree=/unknown', 'GET', 404],
    ['/api/comments?worktree=/linked', 'PUT', 404],
  ]) assert.equal((await handler(request(method, url))).status, status);
  assert.deepEqual(calls, []);
  const result = await handler(request('GET', '/api/comments?worktree=/linked&file=/etc/passwd&ref=other'));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { threads: [], warning: 'Invalid YAML' });
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls, ['/linked']);
  const head = await handler(request('HEAD', '/api/comments?worktree=/linked'));
  assert.equal(head.status, result.status);
  assert.deepEqual(head.headers, result.headers);
  assert.equal(head.body, undefined);
});

test('deletion preview and confirmed DELETE validate exact membership, origin and custom confirmation header', async () => {
  const calls = [];
  const handler = makeHandler({ worktreeDeletion: {
    preview: async (path) => ({ path, confirmation: 'signed-snapshot' }),
    remove: async (path, confirmation) => { calls.push({ path, confirmation }); return { removed: true }; },
  } });
  const url = '/api/worktree-deletion?worktree=/linked';
  const preview = await handler(request('GET', url));
  assert.deepEqual(JSON.parse(preview.body), { path: '/linked', confirmation: 'signed-snapshot' });
  assert.match(preview.headers['Cache-Control'], /no-store/);
  for (const [target, headers, status] of [
    ['/api/worktree-deletion', { host: 'localhost' }, 400],
    ['/api/worktree-deletion?worktree=/arbitrary', { host: 'localhost', 'x-canopy-confirmation': 'token' }, 404],
    [url, { host: 'localhost' }, 403],
    [url, { host: 'localhost', origin: 'https://evil.example', 'x-canopy-confirmation': 'token' }, 403],
    [url, { host: 'localhost', 'sec-fetch-site': 'cross-site', 'x-canopy-confirmation': 'token' }, 403],
    [url, { host: 'localhost', 'sec-fetch-site': 'same-site', 'x-canopy-confirmation': 'token' }, 403],
  ]) {
    assert.equal((await handler({ ...request('DELETE', target), headers })).status, status);
  }
  assert.deepEqual(calls, []);
  const result = await handler({ ...request('DELETE', url), headers: {
    host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin',
    'x-canopy-confirmation': 'signed-snapshot',
  } });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ path: '/linked', confirmation: 'signed-snapshot' }]);
});

test('deletion errors disclose details and preserve removal outcomes with default branch fields', async () => {
  for (const [details, status, payload] of [
    [{}, 500, { removed: false, branchDeleted: false, branch: null }],
    [{ status: 409, removed: null }, 409, { removed: null, branchDeleted: false, branch: null }],
    [{ status: 403, removed: false, branchDeleted: null }, 403, { removed: false, branchDeleted: false, branch: null }],
    [{ status: 500, removed: true, branchDeleted: true, branch: 'feature' }, 500,
      { removed: true, branchDeleted: true, branch: 'feature' }],
  ]) {
    const fail = async () => { throw Object.assign(new Error('git failed /secret/path'), details); };
    const handler = makeHandler({ worktreeDeletion: { preview: fail, remove: fail } });
    for (const method of ['GET', 'DELETE']) {
      const response = await handler({ ...request(method, '/api/worktree-deletion?worktree=/linked'),
        headers: { host: 'localhost', 'x-canopy-confirmation': 'token' } });
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(response.body), { error: 'git failed /secret/path', ...payload });
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(response.headers['Content-Length'], Buffer.byteLength(response.body));
    }
  }
});

test('deletion HEAD runs preview, retaining GET status and headers without a body', async () => {
  for (const fails of [false, true]) {
    const calls = [];
    const handler = makeHandler({ worktreeDeletion: {
      preview: async (path) => {
        calls.push(path);
        if (fails) throw Object.assign(new Error('Preview unavailable'), { status: 409, removed: null });
        return { path, confirmation: 'signed-snapshot' };
      },
      remove: async () => assert.fail('HEAD must not remove a worktree'),
    } });
    const url = '/api/worktree-deletion?worktree=/linked';
    const get = await handler(request('GET', url));
    const head = await handler(request('HEAD', url));
    assert.equal(head.status, fails ? 409 : 200);
    assert.deepEqual(head.headers, get.headers);
    assert.equal(head.body, undefined);
    assert.equal(head.stream, undefined);
    assert.deepEqual(calls, ['/linked', '/linked']);
  }
});

test('unsupported mutation methods return 404 before membership validation or static fallback', async () => {
  const unexpected = () => assert.fail('Unsupported methods must not invoke dependencies');
  const handler = makeHandler({ getWorktrees: unexpected, createComment: unexpected,
    worktreeDeletion: { preview: unexpected, remove: unexpected }, readStatic: unexpected });
  for (const [route, methods] of [
    ['/api/worktree-deletion', ['POST', 'PUT', 'PATCH', 'OPTIONS']],
    ['/api/comments', ['DELETE', 'PUT', 'PATCH', 'OPTIONS']],
  ]) {
    for (const method of methods) {
      const response = await handler(request(method, route));
      assert.equal(response.status, 404);
      assert.deepEqual(JSON.parse(response.body), { error: 'Not found' });
      assert.equal(response.headers['Cache-Control'], undefined);
    }
  }
});

test('mutation validation checks membership before origin or body and only then adds no-store', async () => {
  const unexpected = () => assert.fail('Validation failures must not invoke mutations');
  const handler = makeHandler({ createComment: unexpected, worktreeDeletion: { remove: unexpected } });
  for (const [method, route, originError] of [
    ['DELETE', '/api/worktree-deletion', 'Same-origin request with confirmation header required'],
    ['POST', '/api/comments', 'Same-origin JSON request required'],
  ]) {
    for (const [query, status, error, cache] of [
      ['', 400, 'Missing "worktree" query param', undefined],
      ['?worktree=/unknown', 404, 'Unknown worktree', undefined],
      ['?worktree=/linked', 403, originError, 'no-store'],
    ]) {
      const response = await handler({ ...request(method, `${route}${query}`),
        headers: { host: 'localhost', origin: 'https://evil.example' }, body: 'not json' });
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(response.body), { error });
      assert.equal(response.headers['Cache-Control'], cache);
    }
  }
  for (const body of [undefined, 'not json', 'null', '[1]', '42', '"text"']) {
    const response = await handler({ ...request('POST', '/api/comments?worktree=/linked'),
      headers: { host: 'localhost', 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), { error: 'Invalid JSON body' });
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
});

test('both observation routes forward the browser ignore mode, defaulting on', async () => {
  for (const [query, expected] of [['', true], ['&ignoreGitignore=true', true], ['&ignoreGitignore=false', false]]) {
    const observed = [];
    const handler = makeHandler({
      watchWorktree: (_path, _change, options) => {
        observed.push(options.ignoreGitignore);
        return { close() {} };
      },
      subscribeToActivity: (_change, options) => {
        observed.push(options.ignoreGitignore);
        return () => {};
      },
    });
    for (const route of ['/api/watch', '/api/watch-activity']) {
      const response = await handler(request('GET', `${route}?worktree=/linked${query}`));
      response.stream.subscribe(() => {})();
    }
    assert.deepEqual(observed, [expected, expected]);
  }
});

test('/api/worktrees responds with the listed worktrees as JSON', async () => {
  const res = await run('/api/worktrees');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['Content-Length'], Buffer.byteLength(res.body));
  assert.deepEqual(JSON.parse(res.body), worktrees);
});

test('/api/watch-activity streams timestamp snapshots and cleans up; HEAD starts no watcher', async () => {
  const calls = [];
  const overrides = { subscribeToActivity: (notify) => {
    calls.push('subscribe');
    notify({ '/main': 123, '/linked': null });
    return () => calls.push('close');
  } };
  const head = await run('/api/watch-activity', 'HEAD', overrides);
  assert.equal(head.stream, undefined);
  assert.deepEqual(calls, []);
  const response = await run('/api/watch-activity', 'GET', overrides);
  const frames = [];
  const close = response.stream.subscribe((frame) => frames.push(frame));
  assert.deepEqual(frames, ['data: {"/main":123,"/linked":null}\n\n']);
  close();
  assert.deepEqual(calls, ['subscribe', 'close']);
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

test('/api/watch delivers index invalidations separately from file edits for the requested worktree', async () => {
  let invalidate;
  let closed = false;
  const res = await run('/api/watch?worktree=/linked', 'GET', {
    watchWorktree: (worktreePath, onChange, options) => {
      assert.equal(worktreePath, '/linked');
      invalidate = options?.onStatusChange;
      onChange(['open.txt']);
      return { close: () => { closed = true; } };
    },
  });
  const frames = [];
  const cleanup = res.stream.subscribe((frame) => frames.push(frame));
  assert.equal(typeof invalidate, 'function');
  invalidate();
  assert.deepEqual(frames, [
    'data: {"paths":["open.txt"]}\n\n',
    'event: status-invalidated\ndata: {}\n\n',
  ]);
  cleanup();
  assert.equal(closed, true);
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

test('HEAD on every SSE route keeps GET headers without a body, stream or subscription', async () => {
  const unexpected = () => assert.fail('HEAD must not start a subscription');
  const handler = makeHandler({
    watchWorktree: unexpected,
    subscribeToWorktreeChanges: unexpected,
    subscribeToActivity: unexpected,
  });
  for (const url of ['/api/watch?worktree=/main', '/api/watch-worktrees', '/api/watch-activity']) {
    const get = await handler(request('GET', url));
    const head = await handler(request('HEAD', url));
    assert.equal(head.status, 200);
    assert.deepEqual(head.headers, get.headers);
    assert.equal(head.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(head.body, undefined);
    assert.equal(head.stream, undefined);
  }
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

test('/api/file-content passes the old path of a renamed file to getContent', async () => {
  const calls = [];
  const res = await run('/api/file-content?worktree=/main&file=new.js&oldFile=old.js', 'GET', {
    getContent: async (...args) => { calls.push(args); return { head: 'h', working: 'w' }; },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['/main', 'new.js', 'HEAD', { oldPath: 'old.js' }]]);
});

test('/api/file-content forbids an old path escaping the worktree', async () => {
  const res = await run('/api/file-content?worktree=/main&file=new.js&oldFile=../etc/passwd');
  assert.equal(res.status, 403);
});

const jsonHeaders = { host: 'localhost', 'content-type': 'application/json' };
const post = (handler, url, headers, body = '{"file":"a.js","line":1,"text":"hi","revision":"absent"}') =>
  handler({ ...request('POST', url), headers, body });

test('comment creation requires a registered worktree, same-origin JSON and a valid body', async () => {
  const calls = [];
  const handler = makeHandler({ createComment: async (path, input) => { calls.push({ path, input }); return { revision: 'r2', thread: { id: 't' } }; } });
  const url = '/api/comments?worktree=/linked';
  for (const [target, headers, body, status] of [
    ['/api/comments', jsonHeaders, undefined, 400],
    ['/api/comments?worktree=/unknown', jsonHeaders, undefined, 404],
    [url, { 'content-type': 'application/json' }, undefined, 403],
    [url, { host: 'localhost' }, undefined, 403],
    [url, { ...jsonHeaders, 'content-type': 'text/plain' }, undefined, 403],
    [url, { ...jsonHeaders, origin: 'https://evil.example' }, undefined, 403],
    [url, { ...jsonHeaders, 'sec-fetch-site': 'cross-site' }, undefined, 403],
    [url, jsonHeaders, 'not json', 400],
    [url, jsonHeaders, '[1]', 400],
    [url, jsonHeaders, 'null', 400],
  ]) assert.equal((await post(handler, target, headers, body)).status, status, `${target} ${JSON.stringify(headers)} ${body}`);
  assert.deepEqual(calls, []);
  const ok = await post(handler, url, { ...jsonHeaders, origin: 'http://localhost', 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 201);
  assert.deepEqual(JSON.parse(ok.body), { revision: 'r2', thread: { id: 't' } });
  assert.equal(ok.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls, [{ path: '/linked', input: { file: 'a.js', line: 1, text: 'hi', revision: 'absent' } }]);
});

test('comment creation reports conflicts with the latest revision and hides unexpected error details', async () => {
  const conflict = makeHandler({ createComment: async () => { throw Object.assign(new Error('Comments changed'), { status: 409, conflict: true, revision: 'r9' }); } });
  const response = await post(conflict, '/api/comments?worktree=/linked', jsonHeaders);
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { error: 'Comments changed', conflict: true, revision: 'r9' });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const broken = makeHandler({ createComment: async () => { throw new Error('EACCES /secret/path'); } });
  const failure = await post(broken, '/api/comments?worktree=/linked', jsonHeaders);
  assert.equal(failure.status, 500);
  assert.deepEqual(JSON.parse(failure.body), { error: 'Could not save comment', conflict: false, revision: null });
  assert.equal(failure.headers['Cache-Control'], 'no-store');
});
