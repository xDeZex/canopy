import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeListsEqual, pollWorktrees } from '../../server/worktree-watch.js';
import { createFanOut } from '../../server/fan-out.js';

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

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
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

test('reconnecting to a shared poll catches additions, removals, and HEAD changes immediately', async () => {
  const scheduler = fakeScheduler();
  const snapshots = [[main], [main, linked], [main], [{ ...main, head: 'new-head' }]];
  let calls = 0;
  let starts = 0;
  let closes = 0;
  const subscribe = createFanOut((onChange, options) => {
    starts++;
    const poll = pollWorktrees(async () => snapshots[calls++], onChange, { ...options, ...scheduler });
    return { close() { closes++; poll.close(); } };
  });
  const keeper = [];
  const leaveKeeper = subscribe({ onChange: (value) => keeper.push(value) });
  await settle();
  let reconnect = [];
  let leaveReconnect = subscribe({ onChange: (value) => reconnect.push(value) });
  assert.deepEqual(reconnect, [[main]]);

  for (const expected of snapshots.slice(1)) {
    leaveReconnect();
    await scheduler.fire();
    reconnect = [];
    leaveReconnect = subscribe({ onChange: (value) => reconnect.push(value) });
    assert.deepEqual(reconnect, [expected]);
    assert.equal(calls, snapshots.indexOf(expected) + 1, 'reconnecting must not run another Git query');
  }

  assert.deepEqual(keeper, snapshots);
  assert.equal(starts, 1);
  leaveReconnect();
  assert.equal(closes, 0);
  assert.equal(scheduler.hasPending(), true);
  leaveKeeper();
  assert.equal(closes, 1);
  assert.equal(scheduler.hasPending(), false);
});

test('subscriptions before and after a pending poll receive snapshots in order without duplicates', async () => {
  const scheduler = fakeScheduler();
  const initial = deferred();
  const next = deferred();
  let calls = 0;
  const latest = [main, linked];
  const getWorktrees = () => {
    calls++;
    if (calls === 1) return initial.promise;
    if (calls === 2) return next.promise;
    return Promise.resolve(latest);
  };
  const subscribe = createFanOut((onChange, options) => pollWorktrees(getWorktrees, onChange, { ...options, ...scheduler }));
  const first = [];
  const early = [];
  const leaveFirst = subscribe({ onChange: (value) => first.push(value) });
  const leaveEarly = subscribe({ onChange: (value) => early.push(value) });
  assert.deepEqual(first, []);
  assert.deepEqual(early, []);
  assert.equal(calls, 1);
  initial.resolve([main]);
  await settle();
  assert.deepEqual(first, [[main]]);
  assert.deepEqual(early, [[main]]);

  const pendingTick = scheduler.fire();
  const during = [];
  const leaveDuring = subscribe({ onChange: (value) => during.push(value) });
  assert.deepEqual(during, [[main]]);
  next.resolve(latest);
  await pendingTick;
  assert.deepEqual(during, [[main], latest]);
  const after = [];
  const leaveAfter = subscribe({ onChange: (value) => after.push(value) });
  assert.deepEqual(after, [latest]);
  await scheduler.fire();
  assert.deepEqual(after, [latest]);
  assert.deepEqual(during, [[main], latest]);
  assert.equal(calls, 3);

  leaveAfter();
  leaveDuring();
  leaveEarly();
  leaveFirst();
  assert.equal(scheduler.hasPending(), false);
});

test('closing the shared poll during a Git query prevents stale replay into a restarted poll', async () => {
  const scheduler = fakeScheduler();
  const oldQuery = deferred();
  const newQuery = deferred();
  let calls = 0;
  const subscribe = createFanOut((onChange, options) => pollWorktrees(() => {
    calls++;
    return calls === 1 ? oldQuery.promise : newQuery.promise;
  }, onChange, { ...options, ...scheduler }));
  const old = [];
  const leaveOld = subscribe({ onChange: (value) => old.push(value) });
  leaveOld();
  const current = [];
  const leaveCurrent = subscribe({ onChange: (value) => current.push(value) });
  oldQuery.resolve([main]);
  await settle();
  assert.deepEqual(old, []);
  assert.deepEqual(current, []);
  assert.equal(scheduler.hasPending(), false);

  newQuery.resolve([linked]);
  await settle();
  const late = [];
  const leaveLate = subscribe({ onChange: (value) => late.push(value) });
  assert.deepEqual(current, [[linked]]);
  assert.deepEqual(late, [[linked]]);
  assert.equal(calls, 2);
  leaveLate();
  leaveCurrent();
  assert.equal(scheduler.hasPending(), false);
});
