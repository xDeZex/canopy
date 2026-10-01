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

test('watcher errors report failure and invalidate an incomplete initial scan', (t) => {
  t.mock.method(console, 'error', () => {});
  const emitter = new EventEmitter();
  emitter.close = () => {};
  const changes = [];
  const errors = [];
  watchActivity('/a', (stamp) => changes.push(stamp), {
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
