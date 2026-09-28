import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeListsEqual, pollWorktrees } from '../../server/worktree-watch.js';

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

// pollWorktrees is driven with a fake list source and a hand-cranked
// scheduler, so no test spawns git or waits on a real timer.
function fakeScheduler() {
  let pending = null;
  return {
    setTimer: (fn) => {
      pending = fn;
      return 'timer';
    },
    clearTimer: () => {
      pending = null;
    },
    hasPending: () => pending !== null,
    // Fires the scheduled tick and waits for it to finish.
    async fire() {
      const fn = pending;
      pending = null;
      await fn();
    },
  };
}

// Lets the immediate first tick (not awaited by pollWorktrees) settle.
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function listSource(...lists) {
  let call = 0;
  return async () => lists[Math.min(call++, lists.length - 1)];
}

const main = { path: '/main', branch: 'main' };
const linked = { path: '/linked', branch: 'wip' };

test('pollWorktrees reports the initial snapshot right away', async (t) => {
  const scheduler = fakeScheduler();
  const changes = [];
  const poll = pollWorktrees(listSource([main]), (list) => changes.push(list), scheduler);
  t.after(() => poll.close());
  await settle();

  assert.deepEqual(changes, [[main]]);
});

test('a worktree added between polls is reported', async (t) => {
  const scheduler = fakeScheduler();
  const changes = [];
  const poll = pollWorktrees(listSource([main], [main, linked]), (list) => changes.push(list), scheduler);
  t.after(() => poll.close());
  await settle();
  await scheduler.fire();

  assert.deepEqual(changes, [[main], [main, linked]]);
});

test('a worktree removed between polls is reported', async (t) => {
  const scheduler = fakeScheduler();
  const changes = [];
  const poll = pollWorktrees(listSource([main, linked], [main]), (list) => changes.push(list), scheduler);
  t.after(() => poll.close());
  await settle();
  await scheduler.fire();

  assert.deepEqual(changes, [[main, linked], [main]]);
});

test('an unchanged list is not reported again', async (t) => {
  const scheduler = fakeScheduler();
  const changes = [];
  const poll = pollWorktrees(listSource([main], [{ ...main }]), (list) => changes.push(list), scheduler);
  t.after(() => poll.close());
  await settle();
  await scheduler.fire();
  await scheduler.fire();

  assert.equal(changes.length, 1);
});

test('the next tick is not scheduled until a slow getWorktrees call settles', async (t) => {
  // Regression test for a race where `setInterval` could start a new tick
  // before the previous tick's `getWorktrees()` had resolved, letting two
  // calls race on `previous`. Ticks must be strictly sequential.
  const scheduler = fakeScheduler();
  let calls = 0;
  let finish;
  const slowGetWorktrees = () => {
    calls++;
    return new Promise((resolve) => {
      finish = () => resolve([main]);
    });
  };

  const poll = pollWorktrees(slowGetWorktrees, () => {}, scheduler);
  t.after(() => poll.close());
  await settle();

  assert.equal(calls, 1);
  assert.equal(scheduler.hasPending(), false, 'a tick was scheduled while getWorktrees was still in flight');

  finish();
  await settle();
  assert.equal(scheduler.hasPending(), true);
});

test('a persistent getWorktrees failure is reported via onError on every tick', async (t) => {
  const scheduler = fakeScheduler();
  const errors = [];
  const failingGetWorktrees = async () => {
    throw new Error('git worktree list failed');
  };

  const poll = pollWorktrees(failingGetWorktrees, () => {}, { ...scheduler, onError: (err) => errors.push(err) });
  t.after(() => poll.close());
  await settle();
  await scheduler.fire();
  await scheduler.fire();

  assert.equal(errors.length, 3);
  assert.equal(errors[0].message, 'git worktree list failed');
});

test('close() stops further polling', async () => {
  const scheduler = fakeScheduler();
  const changes = [];
  const poll = pollWorktrees(listSource([main], [main, linked]), (list) => changes.push(list), scheduler);
  await settle();
  poll.close();

  assert.equal(scheduler.hasPending(), false);
  assert.equal(changes.length, 1);
});
