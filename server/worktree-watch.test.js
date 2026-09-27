import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { worktreeListsEqual, pollWorktrees } from './worktree-watch.js';
import { parseWorktreeList } from './porcelain.js';

const execFileAsync = promisify(execFile);

test('two empty lists are equal', () => {
  assert.equal(worktreeListsEqual([], []), true);
});

test('lists of different length are not equal', () => {
  assert.equal(worktreeListsEqual([{ path: '/a' }], []), false);
});

test('lists with the same single worktree are equal', () => {
  const a = [{ path: '/a', branch: 'main' }];
  const b = [{ path: '/a', branch: 'main' }];
  assert.equal(worktreeListsEqual(a, b), true);
});

test('a changed field (e.g. branch after a checkout) makes lists unequal', () => {
  const a = [{ path: '/a', branch: 'main' }];
  const b = [{ path: '/a', branch: 'wip' }];
  assert.equal(worktreeListsEqual(a, b), false);
});

test('a different set of paths (added/removed worktree) makes lists unequal', () => {
  const a = [{ path: '/a' }];
  const b = [{ path: '/a' }, { path: '/b' }];
  assert.equal(worktreeListsEqual(a, b), false);
});

// pollWorktrees integration: a disposable scratch git repo (not this
// project's own repo), matching the pattern in watcher.test.js, so we can
// run real `git worktree add`/`remove` commands and observe the poll react,
// rather than mocking `git` output.
let repoDir;
let worktreeDir;

before(async () => {
  repoDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-worktree-watch-'));
  const run = (args, cwd = repoDir) => execFileAsync('git', args, { cwd });

  await run(['init', '-q']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Canopy Test']);
  await run(['commit', '--allow-empty', '-q', '-m', 'initial commit']);

  worktreeDir = path.join(os.tmpdir(), `canopy-worktree-watch-wt-${process.pid}`);
});

after(async () => {
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repoDir }).catch(() => {});
  await rm(repoDir, { recursive: true, force: true });
  await rm(worktreeDir, { recursive: true, force: true });
});

async function realWorktreeList() {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir });
  return parseWorktreeList(stdout);
}

function recordingCallback() {
  let resolve;
  const next = () =>
    new Promise((r) => {
      resolve = r;
    });
  let pending = next();
  const calls = [];
  const fn = (list) => {
    calls.push(list);
    resolve(list);
    pending = next();
  };
  fn.calls = calls;
  fn.waitForNext = () => pending;
  return fn;
}

test('pollWorktrees reports the initial snapshot right away', async (t) => {
  const onChange = recordingCallback();
  const poll = pollWorktrees(realWorktreeList, onChange, { intervalMs: 20 });
  t.after(() => poll.close());

  const list = await onChange.waitForNext();
  assert.equal(list.length, 1);
});

test('running `git worktree add` is reflected by the poll', async (t) => {
  const onChange = recordingCallback();
  const poll = pollWorktrees(realWorktreeList, onChange, { intervalMs: 20 });
  t.after(() => poll.close());
  await onChange.waitForNext(); // initial snapshot

  const nextChange = onChange.waitForNext();
  await execFileAsync('git', ['worktree', 'add', '-b', 'poll-add-branch', worktreeDir], { cwd: repoDir });

  const list = await nextChange;
  assert.equal(list.length, 2);
  assert.ok(list.some((w) => w.path === worktreeDir));
});

test('running `git worktree remove` is reflected by the poll', async (t) => {
  const onChange = recordingCallback();
  const poll = pollWorktrees(realWorktreeList, onChange, { intervalMs: 20 });
  t.after(() => poll.close());
  await onChange.waitForNext(); // initial snapshot (still has the worktree from the previous test)

  const nextChange = onChange.waitForNext();
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repoDir });

  const list = await nextChange;
  assert.equal(list.length, 1);
  assert.ok(!list.some((w) => w.path === worktreeDir));
});

test('a slow getWorktrees call never overlaps with the next tick', async (t) => {
  // Regression test for a race where `setInterval` could start a new tick
  // before the previous tick's `getWorktrees()` had resolved. A `getWorktrees`
  // that's slower than `intervalMs` would previously let two calls be
  // in-flight at once, racing on `previous`; this asserts calls are strictly
  // sequential instead (no new call starts until the last one settled).
  let inFlight = 0;
  let overlapped = false;
  let callCount = 0;

  const slowGetWorktrees = async () => {
    callCount++;
    inFlight++;
    if (inFlight > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight--;
    return [{ path: '/a', call: callCount }];
  };

  const poll = pollWorktrees(slowGetWorktrees, () => {}, { intervalMs: 5 });
  t.after(() => poll.close());

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(overlapped, false, 'a new tick started before the previous one settled');
  assert.ok(callCount >= 2, 'expected more than one tick to have run');
});

test('a persistent getWorktrees failure is reported via onError on every tick', async (t) => {
  const errors = [];
  const failingGetWorktrees = async () => {
    throw new Error('git worktree list failed');
  };

  const poll = pollWorktrees(failingGetWorktrees, () => {}, {
    intervalMs: 10,
    onError: (err) => errors.push(err),
  });
  t.after(() => poll.close());

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(errors.length >= 2, 'expected onError to fire on more than one failed tick');
  assert.equal(errors[0].message, 'git worktree list failed');
});

test('close() stops further polling', async (t) => {
  const onChange = recordingCallback();
  const poll = pollWorktrees(realWorktreeList, onChange, { intervalMs: 20 });
  await onChange.waitForNext(); // initial snapshot
  poll.close();

  const callsAtClose = onChange.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(onChange.calls.length, callsAtClose);
});
