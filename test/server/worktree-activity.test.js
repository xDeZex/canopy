import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchActivity, createActivityFeed, activityIgnored } from '../../server/worktree-activity.js';

test('initial files seed latest mtime without reporting startup as an edit; edits, additions and deletions report now', () => {
  const emitter = new EventEmitter();
  emitter.close = () => {};
  let options;
  let time = 1000;
  const changes = [];
  watchActivity('/a', (stamp) => changes.push(stamp), {
    readFile: () => '', stat: () => ({ isDirectory: () => false, isFile: () => true }),
    watch: (_path, opts) => { options = opts; return emitter; }, now: () => time,
  });
  assert.equal(options.ignoreInitial, false);
  emitter.emit('add', 'old', { mtimeMs: 100 });
  emitter.emit('add', 'new', { mtimeMs: 600 });
  assert.deepEqual(changes, []);
  emitter.emit('ready');
  assert.deepEqual(changes, [600]);
  time = 2000;
  emitter.emit('change', 'old');
  emitter.emit('add', 'fresh');
  emitter.emit('unlink', 'new');
  assert.deepEqual(changes, [600, 2000, 2000, 2000]);
  assert.equal(activityIgnored('/a/.git/index'), true);
  for (const path of ['/a/node_modules/foo', '/a/.venv/lib.py', '/a/dist/bundle.js', '/a/build/config.js', '/a/coverage/report.json', '/a/src/file.js']) {
    assert.equal(activityIgnored(path), false, path);
  }
  assert.equal(activityIgnored('/a/.github/workflows/ci.yml'), false);
});

test('excluded initial mtimes and later events never count as activity, in either mode', () => {
  for (const ignoreGitignore of [true, false]) {
    const emitter = Object.assign(new EventEmitter(), { close() {} });
    const changes = [];
    let options;
    watchActivity('/linked', (time) => changes.push(time), {
      ignoreGitignore, now: () => 1000,
      readFile: (file) => file === '/linked/.gitignore' ? 'deps/\n' : '',
      stat: () => ({ isDirectory: () => false, isFile: () => true }),
      watch: (_path, opts) => { options = opts; return emitter; },
    });
    assert.equal(options.ignored('/linked/deps', { isDirectory: () => true }), ignoreGitignore);
    emitter.emit('add', '.git/index', { mtimeMs: 9000 });
    emitter.emit('add', 'deps/bundle', { mtimeMs: 500 });
    emitter.emit('add', 'src/file', { mtimeMs: 100 });
    emitter.emit('ready');
    assert.deepEqual(changes, [ignoreGitignore ? 100 : 500]);
    for (const event of ['add', 'change', 'unlink']) {
      emitter.emit(event, '.git/index');
      emitter.emit(event, 'deps/bundle');
      emitter.emit(event, 'src/file');
    }
    assert.deepEqual(changes, [ignoreGitignore ? 100 : 500, ...Array(ignoreGitignore ? 3 : 6).fill(1000)]);
  }
});

test('mtime-only initial stats use the same directory and symlink classification as the scan predicate', () => {
  const emitter = Object.assign(new EventEmitter(), { close() {} });
  const changes = [];
  let options;
  watchActivity('/a', (stamp) => changes.push(stamp), {
    readFile: (file) => file === '/a/.gitignore' ? 'deps/\nlinked/\n' : '',
    stat: (file) => ({
      isFile: () => file.endsWith('/.gitignore'),
      isDirectory: () => file === '/a/deps',
      isSymbolicLink: () => file === '/a/linked',
    }),
    watch: (_path, opts) => { options = opts; return emitter; },
  });
  assert.equal(options.ignored('/a/deps'), true);
  assert.equal(options.ignored('/a/linked'), false);
  emitter.emit('add', 'deps', { mtimeMs: 9000 });
  emitter.emit('add', 'linked', { mtimeMs: 500 });
  emitter.emit('ready');
  assert.deepEqual(changes, [500]);
});

test('policy IO diagnostics preserve initial and later activity without signaling a failed watcher', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const operation of ['read', 'stat']) {
    const emitter = Object.assign(new EventEmitter(), { close() {} });
    const changes = [];
    const errors = [];
    watchActivity('/a', (stamp) => changes.push(stamp), {
      now: () => 1000, onError: (err) => errors.push(err),
      stat: (file) => {
        if (file === '/a/.gitignore' && operation === 'read') return { isFile: () => true };
        throw Object.assign(new Error('cannot stat path'), { code: 'EACCES' });
      },
      readFile: () => { throw Object.assign(new Error('cannot read rules'), { code: 'EISDIR' }); },
      watch: () => emitter,
    });
    emitter.emit('add', 'saved.txt', { mtimeMs: 500 });
    emitter.emit('ready');
    assert.deepEqual(changes, [500]);
    for (const event of ['add', 'change', 'unlink']) {
      assert.doesNotThrow(() => emitter.emit(event, 'saved.txt'));
    }
    assert.deepEqual(changes, [500, 1000, 1000, 1000]);
    assert.deepEqual(errors, [], 'rule configuration failure is not a scan failure');
  }
  assert.equal(console.error.mock.callCount(), 4, 'one diagnostic per failed path and cached rule file');
});

test('watcher errors report failure and invalidate an incomplete initial scan', (t) => {
  t.mock.method(console, 'error', () => {});
  const emitter = new EventEmitter();
  emitter.close = () => {};
  const changes = [];
  const errors = [];
  watchActivity('/a', (stamp) => changes.push(stamp), {
    readFile: () => '', stat: () => ({ isDirectory: () => false, isFile: () => true }),
    watch: () => emitter, onError: (err) => errors.push(err),
  });
  emitter.emit('add', 'old', { mtimeMs: 500 });
  const failure = new Error('watch failed');
  emitter.emit('error', failure);
  emitter.emit('add', 'later', { mtimeMs: 900 });
  emitter.emit('ready');
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(changes, [], 'an incomplete scan cannot seed a healthy timestamp');
});

test('a failed watcher clears only its worktree timestamp and publishes unknown', () => {
  let listChanged;
  const watchers = new Map();
  const feed = createActivityFeed(() => [], {
    poll: (_list, callback) => { listChanged = callback; return { close() {} }; },
    watchActivity: (path, change, { onError }) => {
  const watcher = { change, fail: onError, close() {} };
      watchers.set(path, watcher);
      return watcher;
    },
  });
  const snapshots = [];
  const unsubscribe = feed.subscribe((snapshot) => snapshots.push(snapshot));
  listChanged([{ path: '/a' }, { path: '/b' }]);
  watchers.get('/a').change(400);
  watchers.get('/b').change(500);
  watchers.get('/b').fail(new Error('permission denied'));
  assert.deepEqual(snapshots.at(-1), { '/a': 400, '/b': null });
  const removed = watchers.get('/b');
  listChanged([{ path: '/a' }]);
  listChanged([{ path: '/a' }, { path: '/b' }]);
  watchers.get('/b').change(600);
  removed.fail(new Error('old watcher'));
  assert.deepEqual(snapshots.at(-1), { '/a': 400, '/b': 600 });
  unsubscribe();
});

test('activity feed tracks every non-bare worktree, retains timestamps on list changes, closes removed watchers and replays snapshot', () => {
  let listChanged;
  const watchers = new Map();
  let pollClosed = false;
  const feed = createActivityFeed(() => [], {
    poll: (_list, callback) => { listChanged = callback; return { close: () => { pollClosed = true; } }; },
    watchActivity: (path, callback) => {
      const watcher = { callback, closed: false, close() { this.closed = true; } };
      watchers.set(path, watcher);
      return watcher;
    },
  });
  const first = [];
  const unsubscribe = feed.subscribe((snapshot) => first.push(snapshot));
  listChanged([{ path: '/a' }, { path: '/b' }, { path: '/bare', bare: true }]);
  watchers.get('/b').callback(500);
  assert.deepEqual(first.at(-1), { '/a': null, '/b': 500 });
  const second = [];
  const unsubSecond = feed.subscribe((snapshot) => second.push(snapshot));
  assert.deepEqual(second, [{ '/a': null, '/b': 500 }]);
  listChanged([{ path: '/b', branch: 'new' }, { path: '/c' }]);
  assert.equal(watchers.get('/a').closed, true);
  const removed = watchers.get('/a');
  removed.callback(9999);
  assert.deepEqual(first.at(-1), { '/b': 500, '/c': null });
  unsubSecond();
  unsubscribe();
  assert.equal(watchers.get('/b').closed, true);
  assert.equal(watchers.get('/c').closed, true);
  assert.equal(pollClosed, true);
  const afterReconnect = [];
  const closeAgain = feed.subscribe((snapshot) => afterReconnect.push(snapshot));
  listChanged([{ path: '/b' }, { path: '/c' }]);
  assert.deepEqual(afterReconnect.at(-1), { '/b': 500, '/c': null });
  closeAgain();
});

test('activity modes have independent snapshots and watchers but share worktree polling', () => {
  let listChanged;
  let polls = 0;
  let pollClosed = 0;
  const watchers = [];
  const feed = createActivityFeed(() => [], {
    poll: (_list, callback) => { polls++; listChanged = callback; return { close: () => pollClosed++ }; },
    watchActivity: (path, change, options) => {
      const watcher = { path, change, ...options, closed: false, close() { this.closed = true; } };
      watchers.push(watcher);
      return watcher;
    },
  });
  const filtered = [];
  const all = [];
  const closeFiltered = feed.subscribe((snapshot) => filtered.push(snapshot));
  listChanged([{ path: '/linked' }]);
  const closeAll = feed.subscribe((snapshot) => all.push(snapshot), { ignoreGitignore: false });
  assert.equal(polls, 1);
  assert.equal(watchers.length, 2);
  assert.equal(watchers[0].ignoreGitignore, true);
  assert.equal(watchers[1].ignoreGitignore, false);
  watchers[0].change(100);
  watchers[1].change(900);
  assert.deepEqual(filtered.at(-1), { '/linked': 100 });
  assert.deepEqual(all.at(-1), { '/linked': 900 });
  watchers[0].close = function () { this.closed = true; this.change(5000); };
  closeFiltered();
  assert.equal(watchers[0].closed, true);
  assert.equal(watchers[1].closed, false);
  const returned = [];
  const closeReturned = feed.subscribe((snapshot) => returned.push(snapshot));
  assert.deepEqual(returned.at(-1), { '/linked': 100 });
  watchers[0].change(5000);
  watchers[0].onError(new Error('stale'));
  assert.deepEqual(returned.at(-1), { '/linked': 100 });
  closeAll();
  assert.equal(pollClosed, 0);
  closeReturned();
  assert.equal(pollClosed, 1);
  assert.ok(watchers.every((watcher) => watcher.closed));
});
