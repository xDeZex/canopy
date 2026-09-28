import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchWorktree, IGNORE_GIT_DIR } from '../../server/watcher.js';

// A stand-in for a chokidar watcher: tests emit 'add'/'change'/'unlink'
// themselves, and time only moves when `fire()` runs the pending timer.
function fakeWatch() {
  const watcher = Object.assign(new EventEmitter(), { closed: false, close: async () => { watcher.closed = true; } });
  let pending = null;
  return {
    watcher,
    options: {
      watch: (path, chokidarOptions) => {
        watcher.watchedWith = { path, chokidarOptions };
        return watcher;
      },
      setTimer: (fn) => {
        pending = fn;
        return 'timer';
      },
      clearTimer: () => {
        pending = null;
      },
    },
    hasPending: () => pending !== null,
    fire() {
      const fn = pending;
      pending = null;
      fn();
    },
  };
}

function recorder() {
  const calls = [];
  const fn = (paths) => calls.push(paths);
  fn.calls = calls;
  return fn;
}

test('watches the worktree with relative paths, skipping the initial scan', () => {
  const fake = fakeWatch();
  watchWorktree('/wt', recorder(), fake.options);

  assert.equal(fake.watcher.watchedWith.path, '/wt');
  assert.equal(fake.watcher.watchedWith.chokidarOptions.cwd, '/wt');
  assert.equal(fake.watcher.watchedWith.chokidarOptions.ignoreInitial, true);
});

test('an edit, add or delete reports its relative path after the debounce', () => {
  for (const event of ['change', 'add', 'unlink']) {
    const fake = fakeWatch();
    const onChange = recorder();
    watchWorktree('/wt', onChange, fake.options);

    fake.watcher.emit(event, 'src/a.txt');
    assert.deepEqual(onChange.calls, [], 'reported before the debounce elapsed');
    fake.fire();

    assert.deepEqual(onChange.calls, [['src/a.txt']], event);
  }
});

test('rapid repeated edits to the same file collapse into one call', () => {
  const fake = fakeWatch();
  const onChange = recorder();
  watchWorktree('/wt', onChange, fake.options);

  fake.watcher.emit('change', 'a.txt');
  fake.watcher.emit('change', 'a.txt');
  fake.watcher.emit('change', 'a.txt');
  fake.fire();

  assert.deepEqual(onChange.calls, [['a.txt']]);
});

test('edits to different files within the debounce window batch into one call', () => {
  const fake = fakeWatch();
  const onChange = recorder();
  watchWorktree('/wt', onChange, fake.options);

  fake.watcher.emit('change', 'a.txt');
  fake.watcher.emit('add', 'b.txt');
  fake.fire();

  assert.deepEqual(onChange.calls, [['a.txt', 'b.txt']]);
});

test('each event restarts the debounce, and a later burst is reported separately', () => {
  const fake = fakeWatch();
  const onChange = recorder();
  watchWorktree('/wt', onChange, fake.options);

  fake.watcher.emit('change', 'a.txt');
  fake.fire();
  fake.watcher.emit('change', 'b.txt');
  fake.fire();

  assert.deepEqual(onChange.calls, [['a.txt'], ['b.txt']]);
});

test('paths under .git are ignored, other paths are not', () => {
  const fake = fakeWatch();
  watchWorktree('/wt', recorder(), fake.options);
  const ignored = fake.watcher.watchedWith.chokidarOptions.ignored;

  assert.equal(ignored, IGNORE_GIT_DIR);
  for (const path of ['.git', '.git/index', 'sub/.git/HEAD', '.git\\index']) {
    assert.equal(IGNORE_GIT_DIR.test(path), true, path);
  }
  for (const path of ['a.txt', '.gitignore', '.github/workflows/ci.yml', 'my.git/file']) {
    assert.equal(IGNORE_GIT_DIR.test(path), false, path);
  }
});

test('close() cancels a pending report and closes the underlying watcher', async () => {
  const fake = fakeWatch();
  const onChange = recorder();
  const watcher = watchWorktree('/wt', onChange, fake.options);

  fake.watcher.emit('change', 'a.txt');
  await watcher.close();

  assert.equal(fake.hasPending(), false);
  assert.equal(fake.watcher.closed, true);
  assert.deepEqual(onChange.calls, []);
});

test('ready resolves when the initial scan is done', async () => {
  const fake = fakeWatch();
  const watcher = watchWorktree('/wt', recorder(), fake.options);

  fake.watcher.emit('ready');

  await watcher.ready;
});

test('a watcher error is logged, not thrown, and rejects ready', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fake = fakeWatch();
  const watcher = watchWorktree('/wt', recorder(), fake.options);

  fake.watcher.emit('error', new Error('directory vanished'));

  await assert.rejects(watcher.ready, /directory vanished/);
  assert.equal(console.error.mock.callCount(), 1);
});
