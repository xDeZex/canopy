import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveUpdates } from '../../public/live-updates.js';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { createTreeExpansionStore } from '../../public/tree-state.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { createViewModeStore } from '../../public/view-mode.js';

function fixture() {
  const sources = [];
  const requests = [];
  const activity = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closeCount = 0;
      this.listeners = new Map();
      sources.push(this);
    }

    close() {
      this.closeCount++;
      this.onClose?.();
    }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    open() { this.onopen?.(); }
    message(body) { this.onmessage?.({ data: JSON.stringify(body) }); }
    event(name, body) { this.listeners.get(name)?.({ data: JSON.stringify(body) }); }
  }

  let liveUpdates;
  const workspace = createWorkspaceStore({
    viewModeStore: createViewModeStore({ getItem: () => null, setItem: () => {} }),
    commitLock: createCommitLockStore(),
    fetch(url) {
      requests.push(url);
      return new Promise(() => {});
    },
    onChange: () => {},
    onActivePathChanged: (path) => liveUpdates.connectActive(path),
  });
  const treeExpansion = createTreeExpansionStore();
  liveUpdates = createLiveUpdates({ workspace, treeExpansion, EventSource: FakeEventSource,
    onActivity: (snapshot) => activity.push(snapshot) });
  const list = (...paths) => paths.map((path) => ({ path }));
  return { sources, requests, activity, workspace, treeExpansion, liveUpdates, list };
}

test('switching ignore mode replaces both streams immediately, clears activity and reconciles files', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a'));
  f.workspace.selectFile('open');
  f.liveUpdates.connectWorktrees();
  f.liveUpdates.connectActivity();
  const [file, repo, activity] = f.sources;
  assert.equal(file.url, '/api/watch?worktree=%2Fa&ignoreGitignore=true');
  assert.equal(activity.url, '/api/watch-activity?ignoreGitignore=true');
  activity.message({ '/a': 500 });
  file.onClose = () => file.message({ paths: ['open'] });
  activity.onClose = () => activity.message({ '/a': 900 });
  const before = f.requests.length;
  f.liveUpdates.setIgnoreGitignore(false);
  assert.equal(file.closeCount, 1);
  assert.equal(activity.closeCount, 1);
  assert.equal(repo.closeCount, 0);
  assert.deepEqual(f.sources.slice(3).map((source) => source.url), [
    '/api/watch?worktree=%2Fa&ignoreGitignore=false', '/api/watch-activity?ignoreGitignore=false',
  ]);
  assert.deepEqual(f.activity, [{ '/a': 500 }, {}]);
  assert.deepEqual(f.requests.slice(before), ['/api/files?worktree=%2Fa', '/api/file-content?worktree=%2Fa&file=open']);
  file.open();
  file.message({ paths: ['open'] });
  activity.message({ '/a': 1000 });
  assert.equal(f.requests.length, before + 2);
  f.sources[4].message({ '/a': 100 });
  assert.deepEqual(f.activity.at(-1), { '/a': 100 }, 'new snapshot may be earlier than previous mode');
  f.liveUpdates.setIgnoreGitignore(false);
  assert.equal(f.sources.length, 5, 'unchanged mode does not reconnect');
  f.liveUpdates.setIgnoreGitignore(true);
  f.sources[4].message({ '/a': 2000 });
  assert.deepEqual(f.activity.at(-1), {});
  f.liveUpdates.dispose();
  f.liveUpdates.setIgnoreGitignore(false);
  assert.equal(f.sources.length, 7, 'disposed mode changes cannot reopen');
});

test('file stream reconnect refreshes tree and selected content without paths or worktree replay', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a', head: 'unchanged' }]);
  f.workspace.selectFile('open');
  const source = f.sources[0];
  const before = f.requests.length;
  source.open();
  assert.equal(f.requests.length, before, 'initial open uses the already requested workspace');
  source.open();
  assert.deepEqual(f.requests.slice(before), [
    '/api/files?worktree=%2Fa', '/api/file-content?worktree=%2Fa&file=open',
  ]);
  source.open();
  assert.deepEqual(f.requests.slice(before + 2), f.requests.slice(before, before + 2));
  assert.equal(f.sources.length, 1, 'EventSource owns reconnection, with no replacement stream');
});

test('reconnect without selection fetches only tree and old opens stay stale through close, return and disposal', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a', '/b'));
  const old = f.sources[0];
  old.open();
  const before = f.requests.length;
  old.open();
  assert.deepEqual(f.requests.slice(before), ['/api/files?worktree=%2Fa']);
  old.onClose = () => old.open();
  f.workspace.selectWorktree('/b');
  const current = f.sources[1];
  current.open();
  const switched = f.requests.length;
  old.open();
  assert.equal(f.requests.length, switched, 'closing and old streams cannot reconcile the new worktree');
  current.open();
  assert.deepEqual(f.requests.slice(switched), ['/api/files?worktree=%2Fb']);
  f.workspace.selectWorktree('/a');
  const returned = f.requests.length;
  old.open();
  f.sources[2].open();
  assert.equal(f.requests.length, returned, 'returned path has a fresh initial open');
  f.sources[2].onClose = () => f.sources[2].open();
  f.liveUpdates.dispose();
  f.sources[2].open();
  assert.equal(f.requests.length, returned);
  assert.ok(f.sources.every((source) => source.closeCount === 1));
});

test('activity stream opens once, forwards snapshots and ignores delivery during close or after disposal', () => {
  const f = fixture();
  f.liveUpdates.connectActivity();
  const activitySource = f.sources[0];
  assert.equal(activitySource.url, '/api/watch-activity?ignoreGitignore=true');
  f.liveUpdates.connectActivity();
  assert.equal(f.sources.length, 1);
  activitySource.message({ '/a': 123, '/b': null });
  assert.deepEqual(f.activity, [{ '/a': 123, '/b': null }]);
  activitySource.onClose = () => activitySource.message({ '/a': 456 });
  f.liveUpdates.dispose();
  activitySource.message({ '/a': 789 });
  f.liveUpdates.connectActivity();
  assert.equal(activitySource.closeCount, 1);
  assert.deepEqual(f.activity, [{ '/a': 123, '/b': null }]);
  assert.equal(f.sources.length, 1);
});

test('removed active worktree falls back and re-scopes the file watch; expansion is pruned', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a', '/b'));
  f.liveUpdates.connectWorktrees();
  const first = f.sources[0];
  const repo = f.sources[1];
  assert.equal(first.url, '/api/watch?worktree=%2Fa&ignoreGitignore=true');
  assert.equal(repo.url, '/api/watch-worktrees');

  f.workspace.selectWorktree('/b');
  const second = f.sources[2];
  assert.equal(first.closeCount, 1);
  assert.equal(second.url, '/api/watch?worktree=%2Fb&ignoreGitignore=true');
  f.treeExpansion.toggle('/a', 'src');
  f.treeExpansion.toggle('/b', 'src');

  repo.message(f.list('/a'));
  assert.equal(f.workspace.getState().activePath, '/a');
  assert.equal(second.closeCount, 1);
  assert.equal(f.sources[3].url, '/api/watch?worktree=%2Fa&ignoreGitignore=true');
  assert.equal(f.treeExpansion.isExpanded('/a', 'src'), true);
  assert.equal(f.treeExpansion.isExpanded('/b', 'src'), false);
  assert.equal(repo.closeCount, 0);
  f.liveUpdates.connectWorktrees();
  assert.equal(f.sources.length, 4, 'repo-wide watch is opened only once');

  repo.message([]);
  assert.equal(f.workspace.getState().activePath, null);
  assert.equal(f.sources[3].closeCount, 1);
  assert.equal(repo.closeCount, 0, 'repo-wide watch remains open even without worktrees');
  repo.message(f.list('/new path'));
  assert.equal(f.workspace.getState().activePath, '/new path');
  assert.equal(f.sources[4].url, '/api/watch?worktree=%2Fnew%20path&ignoreGitignore=true');
});

test('same active path does not reopen; events from closed file streams are ignored', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a', '/b'));
  const old = f.sources[0];
  f.liveUpdates.connectActive('/a');
  assert.equal(f.sources.length, 1);
  f.workspace.selectWorktree('/b');
  const current = f.sources[1];
  const before = f.requests.length;
  old.message({ paths: ['old.txt'] });
  assert.equal(f.requests.length, before);
  current.message({ paths: ['current.txt'] });
  assert.equal(f.requests.length, before + 1);
  assert.equal(f.requests.at(-1), '/api/files?worktree=%2Fb');

  f.liveUpdates.dispose();
  f.liveUpdates.dispose();
  assert.equal(current.closeCount, 1);
  current.message({ paths: ['later.txt'] });
  f.liveUpdates.connectActive('/a');
  f.liveUpdates.connectWorktrees();
  assert.equal(f.requests.length, before + 1);
  assert.equal(f.sources.length, 2, 'disposed wiring cannot reconnect');
});

test('status invalidations fetch only the active tree and reject closing, stale and disposed streams', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a', '/b'));
  f.workspace.selectFile('open');
  const old = f.sources[0];
  const before = f.requests.length;
  old.event('status-invalidated', {});
  assert.deepEqual(f.requests.slice(before), ['/api/files?worktree=%2Fa']);
  assert.equal(f.workspace.getState().activeFile, 'open');
  old.onClose = () => old.event('status-invalidated', {});
  f.workspace.selectWorktree('/b');
  const current = f.sources[1];
  const switched = f.requests.length;
  old.event('status-invalidated', {});
  assert.equal(f.requests.length, switched);
  current.event('status-invalidated', {});
  assert.equal(f.requests.at(-1), '/api/files?worktree=%2Fb');
  assert.equal(f.requests.length, switched + 1);
  f.workspace.selectWorktree('/a');
  const returned = f.requests.length;
  old.event('status-invalidated', {});
  assert.equal(f.requests.length, returned, 'returning to the path does not revive its old stream');
  f.sources[2].onClose = () => f.sources[2].event('status-invalidated', {});
  f.liveUpdates.dispose();
  f.sources[2].event('status-invalidated', {});
  assert.equal(f.requests.length, returned);
});

test('a closing source cannot deliver a change during re-scoping or after returning to its path', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a', '/b'));
  const old = f.sources[0];
  old.onClose = () => old.message({ paths: ['during-close.txt'] });
  const before = f.requests.length;
  f.workspace.selectWorktree('/b');
  assert.equal(f.requests.length, before + 2, 'only the fallback tree and commits were fetched');
  f.workspace.selectWorktree('/a');
  const afterReturn = f.requests.length;
  old.message({ paths: ['after-return.txt'] });
  assert.equal(f.requests.length, afterReturn, 'old source stays stale even for the same path');
});

test('repo-wide events survive selection changes, but closed or disposed sources cannot update', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a', '/b'));
  f.liveUpdates.connectWorktrees();
  const repo = f.sources[1];
  f.workspace.selectWorktree('/b');
  repo.message(f.list('/a', '/b', '/c'));
  assert.equal(f.workspace.getState().activePath, '/b');
  assert.deepEqual(f.workspace.getState().worktrees, f.list('/a', '/b', '/c'));
  assert.equal(f.sources.length, 3, 'unchanged selection keeps its watch');

  f.liveUpdates.dispose();
  assert.equal(repo.closeCount, 1);
  assert.equal(f.sources[2].closeCount, 1);
  repo.message(f.list('/c'));
  assert.equal(f.workspace.getState().activePath, '/b');
  assert.deepEqual(f.workspace.getState().worktrees, f.list('/a', '/b', '/c'));
});

test('poll error is logged, without changing selection or closing the repo-wide stream', () => {
  const f = fixture();
  f.workspace.updateWorktrees(f.list('/a'));
  f.liveUpdates.connectWorktrees();
  const repo = f.sources[1];
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    repo.event('worktree-poll-error', { message: 'git unavailable' });
    assert.deepEqual(logs, [['canopy: worktree list live-update failed:', 'git unavailable']]);
    assert.equal(f.workspace.getState().activePath, '/a');
    assert.equal(repo.closeCount, 0);
    repo.message(f.list('/b'));
    assert.equal(f.workspace.getState().activePath, '/b', 'polling continues after an error');
    f.liveUpdates.dispose();
    repo.event('worktree-poll-error', { message: 'late failure' });
    assert.equal(logs.length, 1);
  } finally {
    console.error = original;
  }
});
