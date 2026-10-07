import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../../server/app.js';
import { createListWorktrees } from '../../server/default-deps.js';
import { fakeGit } from './fake-git.js';
import { createRequestHandler } from '../../server/handle-request.js';
import { getFileTree } from '../../server/status.js';
import { readFileContent } from '../../server/file-content.js';
import { listCommits } from '../../server/commits.js';
import { watchWorktree } from '../../server/watcher.js';
import { createWorktreeDeletion } from '../../server/worktree-delete.js';
import { FakeWatcher, deferred } from './observation-fakes.js';

test('non-missing Git and unexpected directory stat failures remain errors at request boundaries', async () => {
  for (const source of ['git', 'discovery-stat', 'request-stat', 'subscription-stat']) {
    const failure = Object.assign(new Error(`Permission denied: ${source}`), { code: 'EACCES' });
    const { runGit, calls } = fakeGit((args) => {
      if (args[0] === 'worktree') return 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /linked\nHEAD bbb\nbranch refs/heads/topic\n';
      if (args[0] === 'rev-parse') return 'ccc\n';
      if (source === 'git') throw failure;
      throw new Error(`Unexpected Git call: ${args}`);
    });
    let checks = 0;
    const unexpected = () => assert.fail('Unexpected filesystem IO');
    const handler = createRequestHandler({
      getWorktrees: createListWorktrees('/main', runGit, { stat: () => {
        if (source === 'discovery-stat') throw failure;
        return { isDirectory: () => true };
      } }),
      statWorktree: () => {
        if (source === 'request-stat' || (source === 'subscription-stat' && ++checks === 2)) throw failure;
        return { isDirectory: () => true };
      },
      getTree: (directory, ref) => getFileTree(directory, ref, runGit, unexpected, unexpected),
      getContent: unexpected, getCommits: unexpected, getComments: unexpected, createComment: unexpected,
      watchWorktree: (directory, onChange, options) => watchWorktree(directory, onChange, {
        ...options, runGit, watch: unexpected, readFile: unexpected, stat: unexpected,
      }),
      subscribeToWorktreeChanges: unexpected, subscribeToActivity: unexpected,
      readStatic: unexpected, publicDir: '/public', worktreeDeletion: { preview: unexpected, remove: unexpected },
    });
    const request = { method: 'GET', pathname: source === 'subscription-stat' ? '/api/watch' : '/api/files',
      searchParams: new URLSearchParams({ worktree: '/linked' }) };
    if (source === 'subscription-stat') {
      const response = await handler(request);
      assert.ok(response.stream);
      assert.throws(() => response.stream?.subscribe(unexpected), (error) => error === failure);
      assert.ok(calls.every(({ cwd }) => cwd === '/main'));
    } else await assert.rejects(handler(request), (error) => error === failure);
  }
});

test('HTTP watch removal before subscription returns JSON 404 on retries without observer IO or error logs', { timeout: 5000 }, async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { runGit, calls } = fakeGit({
    worktree: 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /linked\nHEAD bbb\nbranch refs/heads/topic\n',
    'rev-parse': 'ccc\n',
  });
  let checks = 0;
  const unexpected = () => assert.fail('Removed worktree must not reach filesystem IO');
  const server = createApp({
    listWorktrees: createListWorktrees('/main', runGit, { stat: () => ({ isDirectory: () => true }) }),
    statWorktree: () => ({ isDirectory: () => ++checks % 2 === 1 }),
    watchWorktree: (directory, onChange, options) => watchWorktree(directory, onChange, {
      ...options, runGit, watch: unexpected, readFile: unexpected, stat: unexpected,
    }),
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await new Promise<{ status: number | undefined; contentType: string | undefined; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: address.port, path: '/api/watch?worktree=/linked' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body }));
      }).on('error', reject);
    });
    assert.equal(response.status, 404);
    assert.equal(response.contentType, 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(response.body), { error: 'Worktree directory is missing' });
  }
  assert.equal(errors.mock.callCount(), 0);
  assert.ok(calls.every(({ cwd }) => cwd === '/main'));
});

test('watch subscription rechecks a worktree removed after the response was prepared', async () => {
  let present = true;
  const { runGit, calls } = fakeGit({
    worktree: 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /linked\nHEAD bbb\nbranch refs/heads/topic\n',
    'rev-parse': 'ccc\n',
  });
  const stat = () => ({ isDirectory: () => present });
  const unexpected = () => assert.fail('Removed worktree must not reach filesystem IO');
  const handler = createRequestHandler({
    getWorktrees: createListWorktrees('/main', runGit, { stat }), statWorktree: stat,
    getTree: unexpected, getContent: unexpected, getCommits: unexpected,
    getComments: unexpected, createComment: unexpected,
    watchWorktree: (directory, onChange, options) => watchWorktree(directory, onChange, {
      ...options, runGit, watch: unexpected, readFile: unexpected, stat: unexpected,
    }),
    subscribeToWorktreeChanges: unexpected, subscribeToActivity: unexpected,
    readStatic: unexpected, publicDir: '/public', worktreeDeletion: { preview: unexpected, remove: unexpected },
  });
  const response = await handler({ method: 'GET', pathname: '/api/watch',
    searchParams: new URLSearchParams({ worktree: '/linked' }) });
  assert.ok(response.stream);
  present = false;
  assert.throws(() => response.stream?.subscribe(unexpected), /Worktree directory is missing/);
  assert.ok(calls.every(({ cwd }) => cwd === '/main'), 'No worktree Git IO begins before rejection');
});

test('existing worktree requests still read files and start and close their filesystem observers', async () => {
  const watchers: FakeWatcher[] = [];
  const indexObserved = deferred<void>();
  const { runGit, calls } = fakeGit((args) => {
    if (args[0] === 'worktree') return 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /linked\nHEAD bbb\nbranch refs/heads/topic\n';
    if (args[0] === 'rev-parse') return args.includes('--git-path') ? '/metadata/linked/index\n' : 'ccc\n';
    if (args[0] === 'status') return '';
    if (args[0] === 'ls-files') return 'file.ts\0';
    throw new Error(`Unexpected Git call: ${args}`);
  });
  const stat = () => ({ isDirectory: () => true });
  const unexpected = () => assert.fail('Unexpected IO');
  const handler = createRequestHandler({
    getWorktrees: createListWorktrees('/main', runGit, { stat }), statWorktree: stat,
    getTree: (directory, ref) => getFileTree(directory, ref, runGit, unexpected, unexpected),
    getContent: unexpected, getCommits: unexpected, getComments: unexpected, createComment: unexpected,
    watchWorktree: (directory, onChange, options) => watchWorktree(directory, onChange, {
      ...options, runGit, readFile: () => '', stat: () => ({ isFile: () => false }),
      watch: (watchedPath, chokidarOptions) => {
        const watcher = new FakeWatcher();
        watcher.watchedWith = { path: watchedPath, chokidarOptions };
        watchers.push(watcher);
        if (watchedPath === '/metadata/linked/index') indexObserved.resolve(undefined);
        return watcher;
      },
    }),
    subscribeToWorktreeChanges: unexpected, subscribeToActivity: unexpected,
    readStatic: unexpected, publicDir: '/public', worktreeDeletion: { preview: unexpected, remove: unexpected },
  });
  const searchParams = new URLSearchParams({ worktree: '/linked' });
  const files = await handler({ method: 'GET', pathname: '/api/files', searchParams });
  assert.equal(files.status, 200);
  assert.deepEqual(JSON.parse(String(files.body)), [{ name: 'file.ts', path: 'file.ts', type: 'file', status: 'clean' }]);
  const response = await handler({ method: 'GET', pathname: '/api/watch', searchParams });
  assert.equal(response.status, 200);
  assert.ok(response.stream);
  const close = response.stream.subscribe(() => {});
  await indexObserved.promise;
  assert.deepEqual(watchers.map((watcher) => watcher.watchedWith.path), ['/linked', '/metadata/linked/index']);
  close();
  assert.ok(watchers.every((watcher) => watcher.closed));
  assert.ok(calls.some(({ args, cwd }) => args[0] === 'status' && cwd === '/linked'));
});

test('files requests fail cleanly when the worktree disappears after directory validation', async () => {
  let present = true;
  const { runGit } = fakeGit((args, cwd) => {
    if (cwd === '/linked') {
      present = false;
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    }
    return args[0] === 'worktree'
      ? 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /linked\nHEAD bbb\nbranch refs/heads/topic\n'
      : 'ccc\n';
  });
  const stat = () => ({ isDirectory: () => present });
  const unexpected = () => assert.fail('Unexpected IO');
  const handler = createRequestHandler({
    getWorktrees: createListWorktrees('/main', runGit, { stat }), statWorktree: stat,
    getTree: (directory, ref) => getFileTree(directory, ref, runGit, unexpected, unexpected),
    getContent: unexpected, getCommits: unexpected, getComments: unexpected, createComment: unexpected,
    watchWorktree: unexpected, subscribeToWorktreeChanges: unexpected, subscribeToActivity: unexpected,
    readStatic: unexpected, publicDir: '/public', worktreeDeletion: { preview: unexpected, remove: unexpected },
  });
  const response = await handler({ method: 'GET', pathname: '/api/files',
    searchParams: new URLSearchParams({ worktree: '/linked' }) });
  assert.equal(response.status, 404);
  assert.deepEqual(JSON.parse(String(response.body)), { error: 'Worktree directory is missing' });
});

test('missing prunable worktrees retain deletion assessment without Git in the missing directory', async () => {
  const sha = 'a'.repeat(40);
  const listing = `worktree /main\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree /missing\nHEAD ${sha}\nbranch refs/heads/topic\nprunable gitdir file points to non-existent location\n\n`;
  const { runGit, calls } = fakeGit((args) => args[0] === 'worktree'
    ? (args.includes('-z') ? listing.replaceAll('\n', '\0') : listing) : `${sha}\n`);
  const stat = (directory: string) => {
    if (directory === '/missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  };
  const unexpected = () => assert.fail('Deletion assessment must not use worktree IO');
  const handler = createRequestHandler({
    getWorktrees: createListWorktrees('/main', runGit, { stat }),
    getDeletionWorktrees: createListWorktrees('/main', runGit, { stat, includeMissing: true }),
    statWorktree: stat,
    getTree: unexpected, getContent: unexpected, getCommits: unexpected,
    getComments: unexpected, createComment: unexpected, watchWorktree: unexpected,
    subscribeToWorktreeChanges: unexpected, subscribeToActivity: unexpected,
    readStatic: unexpected, publicDir: '/public',
    worktreeDeletion: createWorktreeDeletion('/main', runGit, { secret: Buffer.from('test-secret') }),
  });
  const searchParams = new URLSearchParams({ worktree: '/missing' });
  const preview = await handler({ method: 'GET', pathname: '/api/worktree-deletion', searchParams });
  assert.equal(preview.status, 200);
  assert.deepEqual(JSON.parse(String(preview.body)), {
    path: '/missing', branch: 'topic', reason: 'Prunable worktree cannot be safely assessed',
  });
  const removal = await handler({ method: 'DELETE', pathname: '/api/worktree-deletion', searchParams,
    headers: { host: 'localhost', 'x-canopy-confirmation': 'token' } });
  assert.equal(removal.status, 403);
  assert.equal(JSON.parse(String(removal.body)).error, 'Prunable worktree cannot be safely assessed');
  assert.ok(calls.every(({ cwd }) => cwd === '/main'));
});

test('stale worktree requests return 404 before file Git IO or filesystem observation', async () => {
  const { runGit, calls } = fakeGit({
    worktree: 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /linked\nHEAD bbb\nbranch refs/heads/topic\n',
    'rev-parse': 'ccc\n',
  });
  const unexpected = () => assert.fail('Missing worktree must not reach filesystem IO');
  const handler = createRequestHandler({
    // Simulate removal after discovery, before the request uses the directory.
    getWorktrees: createListWorktrees('/main', runGit, { stat: () => ({ isDirectory: () => true }) }),
    statWorktree: () => { throw Object.assign(new Error('deleted'), { code: 'ENOENT' }); },
    getTree: (directory, ref) => getFileTree(directory, ref, runGit, unexpected, unexpected),
    getContent: (directory, file, ref) => readFileContent(directory, file, ref, { runGit, readWorkingFile: unexpected }),
    getCommits: (directory, file) => listCommits(directory, file, runGit),
    watchWorktree: (directory, onChange, options) => watchWorktree(directory, onChange, {
      ...options, runGit, watch: unexpected, readFile: unexpected, stat: unexpected,
    }),
    getComments: unexpected, createComment: unexpected,
    subscribeToWorktreeChanges: unexpected, subscribeToActivity: unexpected,
    readStatic: unexpected, publicDir: '/public',
    worktreeDeletion: { preview: unexpected, remove: unexpected },
  });
  for (const route of ['/api/files', '/api/file-content', '/api/commits', '/api/watch', '/api/comments']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await handler({ method, pathname: route,
        searchParams: new URLSearchParams({ worktree: '/linked', file: 'file.ts' }) });
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.equal(response.stream, undefined);
      if (method === 'GET') assert.deepEqual(JSON.parse(String(response.body)), { error: 'Worktree directory is missing' });
      else assert.equal(response.body, undefined);
    }
  }
  assert.ok(calls.every(({ cwd }) => cwd === '/main'), 'Only repository-level discovery may run Git');
});

test('discovery omits missing and non-directory worktrees, retaining existing prunable directories', async () => {
  const { runGit } = fakeGit({
    worktree: 'worktree /main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /missing\nHEAD bbb\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n\nworktree /file\nHEAD ccc\ndetached\n\nworktree /present\nHEAD ddd\nbranch refs/heads/topic\nprunable invalid gitdir file\n',
    'rev-parse': 'eee\n',
  });
  const worktrees = await createListWorktrees('/main', runGit, {
    stat: (directory) => {
      if (directory === '/missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isDirectory: () => directory !== '/file' };
    },
  })();
  assert.deepEqual(worktrees.map(({ path, head, branch, deletionReason, originMainSha }) =>
    ({ path, head, branch, deletionReason, originMainSha })), [
    { path: '/main', head: 'aaa', branch: 'main', deletionReason: 'Main worktree cannot be deleted', originMainSha: 'eee' },
    { path: '/present', head: 'ddd', branch: 'topic', deletionReason: 'Prunable worktree cannot be safely assessed', originMainSha: 'eee' },
  ]);
});

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
  const worktrees = await createListWorktrees('/linked', runGit, { stat: () => ({ isDirectory: () => true }) })();
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
  const options = { repoRoot: '/main', listWorktrees: createListWorktrees('/main', git, { stat: () => ({ isDirectory: () => true }) }) };
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
