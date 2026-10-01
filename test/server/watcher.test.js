import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchWorktree, IGNORE_GIT_DIR } from '../../server/watcher.js';
import { watchActivity } from '../../server/worktree-activity.js';

// A stand-in for a chokidar watcher: tests emit 'add'/'change'/'unlink'
// themselves, and time only moves when `fire()` runs the pending timer.
function fakeWatch() {
  const watcher = Object.assign(new EventEmitter(), { closed: false, close: async () => { watcher.closed = true; } });
  let pending = null;
  return {
    watcher,
    options: {
      readFile: () => '',
      stat: () => ({ isDirectory: () => false, isFile: () => true }),
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

test('linked worktree index replacement invalidates status without reporting file edits', async () => {
  const files = fakeWatch();
  const index = fakeWatch();
  const gitCalls = [];
  const onChange = recorder();
  let statuses = 0;
  const watcher = watchWorktree('/linked', onChange, {
    ...files.options,
    watch: (path, options) => (path === '/linked' ? files : index).options.watch(path, options),
    runGit: async (args, cwd) => {
      gitCalls.push({ args, cwd });
      return '../main/.git/worktrees/linked/index\n';
    },
    onStatusChange: () => statuses++,
  });
  await Promise.resolve();
  assert.deepEqual(gitCalls, [{ args: ['rev-parse', '--git-path', 'index'], cwd: '/linked' }]);
  assert.equal(index.watcher.watchedWith.path, '/main/.git/worktrees/linked/index');
  assert.equal(index.watcher.watchedWith.chokidarOptions.ignoreInitial, true);
  assert.equal(index.watcher.watchedWith.chokidarOptions.ignored, undefined);
  index.watcher.emit('unlink', '/main/.git/worktrees/linked/index');
  index.watcher.emit('add', '/main/.git/worktrees/linked/index');
  index.watcher.emit('change', '/main/.git/worktrees/linked/index');
  assert.equal(statuses, 0);
  files.fire();
  assert.equal(statuses, 1);
  assert.deepEqual(onChange.calls, []);
  index.watcher.emit('change', '/main/.git/worktrees/linked/index');
  assert.equal(files.hasPending(), true);
  await watcher.close();
  assert.equal(files.hasPending(), false);
  index.watcher.emit('change', '/main/.git/worktrees/linked/index');
  assert.equal(files.hasPending(), false);
  assert.equal(statuses, 1);
  assert.equal(files.watcher.closed, true);
  assert.equal(index.watcher.closed, true);
});

test('an index watch ignores lock files and another worktree index', async () => {
  const fake = fakeWatch();
  const index = fakeWatch();
  let statuses = 0;
  const watcher = watchWorktree('/linked', recorder(), {
    ...fake.options,
    watch: (path, options) => (path === '/linked' ? fake : index).options.watch(path, options),
    runGit: async () => '/repo/.git/worktrees/linked/index\n',
    onStatusChange: () => statuses++,
  });
  await Promise.resolve();
  index.watcher.emit('change', '/repo/.git/index');
  index.watcher.emit('add', '/repo/.git/worktrees/other/index');
  index.watcher.emit('unlink', '/repo/.git/worktrees/linked/index.lock');
  assert.equal(fake.hasPending(), false);
  assert.equal(statuses, 0);
  await watcher.close();
});

test('closing during index resolution does not start a late watcher', async () => {
  const fake = fakeWatch();
  let resolveIndex;
  const pending = new Promise((resolve) => { resolveIndex = resolve; });
  const watcher = watchWorktree('/linked', recorder(), {
    ...fake.options,
    runGit: () => pending,
    onStatusChange: () => assert.fail('closed watcher delivered status'),
  });
  await watcher.close();
  resolveIndex('/repo/.git/worktrees/linked/index');
  await Promise.resolve();
  assert.equal(fake.watcher.watchedWith.path, '/linked');
  assert.equal(fake.watcher.closed, true);
  assert.equal(fake.hasPending(), false);
});

test('index readiness reconciles status once unless closed during its initial scan', async () => {
  for (const closeBeforeReady of [false, true]) {
    const files = fakeWatch();
    const index = fakeWatch();
    const onChange = recorder();
    let statuses = 0;
    const watcher = watchWorktree('/linked', onChange, {
      ...files.options,
      watch: (path, options) => (path === '/linked' ? files : index).options.watch(path, options),
      runGit: async () => '/repo/.git/worktrees/linked/index',
      onStatusChange: () => statuses++,
    });
    await Promise.resolve();
    files.watcher.emit('ready');
    assert.equal(statuses, 0, 'file readiness cannot finish index observation');
    if (closeBeforeReady) await watcher.close();
    index.watcher.emit('ready');
    index.watcher.emit('ready');
    assert.equal(statuses, closeBeforeReady ? 0 : 1);
    assert.deepEqual(onChange.calls, [], 'index readiness is not a content edit');
    assert.equal(files.hasPending(), false);
    if (!closeBeforeReady) await watcher.close();
    index.watcher.emit('ready');
    assert.equal(statuses, closeBeforeReady ? 0 : 1);
  }
});

test('index resolution and watcher errors are logged while file edits remain observable', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const failure of ['resolve', 'watch', 'event']) {
    const files = fakeWatch();
    const index = fakeWatch();
    const onChange = recorder();
    const watcher = watchWorktree('/linked', onChange, {
      ...files.options,
      runGit: async () => {
        if (failure === 'resolve') throw new Error('cannot resolve index');
        return '/repo/.git/worktrees/linked/index';
      },
      watch: (path, options) => {
        if (path === '/linked') return files.options.watch(path, options);
        if (failure === 'watch') throw new Error('cannot watch index');
        return index.options.watch(path, options);
      },
      onStatusChange: () => assert.fail('failed index delivered status'),
    });
    await Promise.resolve();
    await Promise.resolve();
    if (failure === 'event') index.watcher.emit('error', new Error('index watch failed'));
    files.watcher.emit('change', 'open.txt');
    files.fire();
    assert.deepEqual(onChange.calls, [['open.txt']], failure);
    await watcher.close();
  }
  assert.equal(console.error.mock.callCount(), 3);
});

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

  assert.equal(ignored('.git/index'), true);
  for (const path of ['.git', '.git/index', 'sub/.git/HEAD', '.git\\index']) {
    assert.equal(IGNORE_GIT_DIR.test(path), true, path);
  }
  for (const path of ['a.txt', '.gitignore', '.github/workflows/ci.yml', 'my.git/file']) {
    assert.equal(IGNORE_GIT_DIR.test(path), false, path);
  }
});

test('gitignore policy prunes dependencies and guards emitted events without losing saved edits', () => {
  const fake = fakeWatch();
  const onChange = recorder();
  watchWorktree('/linked', onChange, { ...fake.options,
    readFile: (file) => file === '/linked/.gitignore' ? 'deps/\n*.log\n!keep.log\n' : '',
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  });
  const ignored = fake.watcher.watchedWith.chokidarOptions.ignored;
  assert.equal(ignored('/linked/deps', { isDirectory: () => true }), true);
  for (const event of ['add', 'change', 'unlink']) {
    fake.watcher.emit(event, 'deps/package/file');
    fake.watcher.emit(event, 'error.log');
    fake.watcher.emit(event, '.git/index');
  }
  assert.equal(fake.hasPending(), false);
  fake.watcher.emit('change', 'keep.log');
  fake.watcher.emit('add', 'src/new.js');
  fake.watcher.emit('unlink', 'src/old.js');
  fake.fire();
  assert.deepEqual(onChange.calls, [['keep.log', 'src/new.js', 'src/old.js']]);
});

test('active and activity watchers observe directory symlinks as links, not ignored target directories', () => {
  const active = fakeWatch();
  const activity = fakeWatch();
  const edits = recorder();
  const timestamps = [];
  const options = {
    readFile: (file) => file === '/wt/.gitignore' ? 'linked/\ndeps/\n' : '',
    stat: (file) => ({ isDirectory: () => file === '/wt/deps', isSymbolicLink: () => file === '/wt/linked', isFile: () => file.endsWith('/.gitignore') }),
  };
  watchWorktree('/wt', edits, { ...active.options, ...options });
  watchActivity('/wt', (time) => timestamps.push(time), { ...activity.options, ...options });
  for (const fake of [active, activity]) {
    const watchOptions = fake.watcher.watchedWith.chokidarOptions;
    assert.equal(watchOptions.followSymlinks, false, 'never traverse symlink targets');
    assert.equal(watchOptions.ignored('/wt/linked'), false);
    assert.equal(watchOptions.ignored('/wt/deps'), true);
  }
  active.watcher.emit('add', 'linked');
  activity.watcher.emit('add', 'linked', { mtimeMs: 500 });
  activity.watcher.emit('add', 'deps/file', { mtimeMs: 9000 });
  activity.watcher.emit('ready');
  active.fire();
  assert.deepEqual(edits.calls, [['linked']]);
  assert.deepEqual(timestamps, [500]);
});

test('rule and path stat failures are logged without escaping watcher events or suppressing edits', (t) => {
  t.mock.method(console, 'error', () => {});
  const fake = fakeWatch();
  const edits = recorder();
  watchWorktree('/wt', edits, { ...fake.options,
    stat: (file) => {
      if (file.endsWith('/.gitignore')) return { isFile: () => true };
      throw Object.assign(new Error('cannot stat edit'), { code: 'EACCES' });
    },
    readFile: () => { throw Object.assign(new Error('cannot read rules'), { code: 'EACCES' }); },
  });
  const ignored = fake.watcher.watchedWith.chokidarOptions.ignored;
  assert.equal(ignored('/wt/edit.txt'), false);
  for (const event of ['add', 'change', 'unlink']) {
    assert.doesNotThrow(() => fake.watcher.emit(event, 'edit.txt'));
  }
  fake.fire();
  assert.deepEqual(edits.calls, [['edit.txt']]);
  assert.equal(console.error.mock.callCount(), 2, 'each failed path and rule file is reported once');
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
