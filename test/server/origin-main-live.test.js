import test from 'node:test';
import assert from 'node:assert/strict';
import { createListWorktrees } from '../../server/default-deps.js';
import { pollWorktrees } from '../../server/worktree-watch.js';
import { createFanOut } from '../../server/fan-out.js';
import { createRequestHandler } from '../../server/handle-request.js';
import { listCommits } from '../../server/commits.js';

const porcelain = 'worktree /main\nHEAD bbb\nbranch refs/heads/main\n\nworktree /linked\nHEAD bbb\nbranch refs/heads/topic\n';
const log = 'bbb\x1fLocal\x1f2026-01-02T00:00:00Z\naaa\x1fPushed\x1f2026-01-01T00:00:00Z';
const refSnapshot = (worktrees) => worktrees.map(({ path, head, branch, originMainSha }) => ({ path, head, branch, originMainSha }));

function fixture() {
  let origin = 'aaa';
  let shared = 'aaa';
  let shadow = null;
  let pending = null;
  const delays = [];
  const gitCalls = [];
  const git = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'rev-parse') {
      if (shadow !== null && args.at(-1) === 'origin/main^{commit}') return `${shadow}\n`;
      if (origin === null) throw new Error('missing ref');
      return `${origin}\n`;
    }
    if (args[0] === 'merge-base') {
      if (shadow !== null && args.at(-1) === 'origin/main') return `${shadow}\n`;
      if (origin === null) throw new Error('missing ref');
      if (shared === 'outside-history') throw new Error('no common ancestor');
      return `${shared}\n`;
    }
    if (args[0] === 'log') return log;
    throw new Error(`Unexpected Git command: ${args}`);
  };
  const getWorktrees = createListWorktrees('/linked', git);
  const subscribeToWorktreeChanges = createFanOut((onChange, options) =>
    pollWorktrees(getWorktrees, onChange, {
      ...options,
      setTimer(callback, delay) { pending = callback; delays.push(delay); return 'timer'; },
      clearTimer() { pending = null; },
    }));
  const handle = createRequestHandler({
    getWorktrees, subscribeToWorktreeChanges,
    getCommits: (path, file) => listCommits(path, file, git),
  });
  const request = (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    return handle({ method: 'GET', pathname, searchParams });
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    request, gitCalls, delays, settle,
    setOrigin: (sha, sharedSha = sha) => { origin = sha; shared = sharedSha; },
    setShadow: (sha) => { shadow = sha; },
    async tick() { const callback = pending; pending = null; await callback(); },
  };
}

test('local origin/main movement is streamed at normal cadence with unchanged HEAD in a linked worktree', async (t) => {
  const f = fixture();
  const initial = refSnapshot(JSON.parse((await f.request('/api/worktrees')).body));
  assert.deepEqual(initial, [
    { path: '/linked', head: 'bbb', branch: 'topic', originMainSha: 'aaa' },
    { path: '/main', head: 'bbb', branch: 'main', originMainSha: 'aaa' },
  ]);
  const response = await f.request('/api/watch-worktrees');
  const frames = [];
  t.after(response.stream.subscribe((frame) => frames.push(frame)));
  await f.settle();
  await f.tick();
  assert.equal(frames.length, 1, 'unchanged local refs do not emit again');
  f.setOrigin('bbb');
  await f.tick();
  assert.deepEqual(frames.map((frame) => refSnapshot(JSON.parse(frame.slice(6)))), [
    initial,
    [
      { path: '/linked', head: 'bbb', branch: 'topic', originMainSha: 'bbb' },
      { path: '/main', head: 'bbb', branch: 'main', originMainSha: 'bbb' },
    ],
  ]);
  assert.deepEqual(f.delays, [2000, 2000, 2000]);
  const commits = JSON.parse((await f.request('/api/commits?worktree=/linked')).body);
  assert.deepEqual(commits.map(({ sha, isOriginMain }) => [sha, isOriginMain]), [['bbb', true], ['aaa', false]]);
  assert.ok(f.gitCalls.every(({ cwd }) => cwd === '/linked'), 'Git resolves the shared ref from the launch worktree');
  assert.ok(f.gitCalls.every(({ args }) => ['worktree', 'rev-parse', 'merge-base', 'log'].includes(args[0])), 'only local read commands');
});

test('advanced origin/main tips stream changes even when the latest shared commit stays unchanged', async (t) => {
  const f = fixture();
  f.setOrigin('ccc', 'aaa');
  const response = await f.request('/api/watch-worktrees');
  const frames = [];
  t.after(response.stream.subscribe((frame) => frames.push(frame)));
  await f.settle();
  const commits = async () => JSON.parse((await f.request('/api/commits?worktree=/linked')).body);
  const expected = [
    { sha: 'bbb', message: 'Local', date: '2026-01-02T00:00:00Z', isOriginMain: false },
    { sha: 'aaa', message: 'Pushed', date: '2026-01-01T00:00:00Z', isOriginMain: true },
  ];
  assert.deepEqual(await commits(), expected);
  f.setOrigin('ddd', 'aaa');
  await f.tick();
  assert.deepEqual(await commits(), expected);
  assert.deepEqual(frames.map((frame) => refSnapshot(JSON.parse(frame.slice(6)))), [
    [
      { path: '/linked', head: 'bbb', branch: 'topic', originMainSha: 'ccc' },
      { path: '/main', head: 'bbb', branch: 'main', originMainSha: 'ccc' },
    ],
    [
      { path: '/linked', head: 'bbb', branch: 'topic', originMainSha: 'ddd' },
      { path: '/main', head: 'bbb', branch: 'main', originMainSha: 'ddd' },
    ],
  ]);
  await f.tick();
  assert.equal(frames.length, 2, 'unchanged remote tip does not emit again');
  assert.deepEqual(f.delays, [2000, 2000, 2000]);
});

test('a same-named tag cannot replace the local remote-tracking origin/main ref', async () => {
  const f = fixture();
  f.setOrigin('bbb');
  f.setShadow('aaa');
  const worktrees = JSON.parse((await f.request('/api/worktrees')).body);
  assert.deepEqual(worktrees.map(({ originMainSha }) => originMainSha), ['bbb', 'bbb']);
  const commits = JSON.parse((await f.request('/api/commits?worktree=/linked')).body);
  assert.deepEqual(commits.map(({ sha, isOriginMain }) => [sha, isOriginMain]), [['bbb', true], ['aaa', false]]);
});

test('ref creation, deletion and movement to unrelated history stream changes without inventing a divider', async (t) => {
  const f = fixture();
  f.setOrigin(null);
  const response = await f.request('/api/watch-worktrees');
  const frames = [];
  t.after(response.stream.subscribe((frame) => frames.push(frame)));
  await f.settle();
  const markers = async () => JSON.parse((await f.request('/api/commits?worktree=/linked')).body)
    .filter((commit) => commit.isOriginMain).map((commit) => commit.sha);
  assert.deepEqual(await markers(), []);
  f.setOrigin('aaa');
  await f.tick();
  assert.deepEqual(await markers(), ['aaa']);
  f.setOrigin('outside-history');
  await f.tick();
  assert.deepEqual(await markers(), []);
  f.setOrigin(null);
  await f.tick();
  assert.deepEqual(await markers(), []);
  await f.tick();
  assert.deepEqual(frames.map((frame) => JSON.parse(frame.slice(6)).map(({ originMainSha }) => originMainSha)),
    [[null, null], ['aaa', 'aaa'], ['outside-history', 'outside-history'], [null, null]]);
});
