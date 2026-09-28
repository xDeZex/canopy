import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore } from './workspace-state.js';
import { createCommitLockStore } from './commit-lock.js';
import { createViewModeStore } from './view-mode.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(savedMode = null) {
  const requests = [];
  // File-scoped commit refetches (issued on file selection) are tracked apart
  // so tree/content tests can keep addressing `requests` by position.
  const fileCommitRequests = [];
  const changes = [];
  const watches = [];
  const commitLock = createCommitLockStore();
  const viewModeStore = createViewModeStore({ getItem: () => savedMode, setItem: () => {} });
  const store = createWorkspaceStore({
    commitLock, viewModeStore,
    fetch(url) {
      const pending = deferred();
      const isFileCommits = url.startsWith('/api/commits') && url.includes('&file=');
      (isFileCommits ? fileCommitRequests : requests).push({ url, ...pending });
      return pending.promise;
    },
    onChange: (part) => changes.push(part),
    onActivePathChanged: (path) => watches.push(path),
  });
  const reply = async (request, body) => {
    request.resolve({ ok: true, json: async () => body });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { store, requests, fileCommitRequests, changes, watches, commitLock, viewModeStore, reply };
}

const tree = (name, status = 'modified') => [{ type: 'file', path: name, name, status }];
const list = (paths) => paths.map((path) => ({ path }));

test('first selected clean file seeds after tree arrives, even if content arrives first', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('clean.txt');
  assert.equal(f.viewModeStore.getMode(), 'diff', 'temporary display mode does not seed the session');
  await f.reply(f.requests[2], { working: 'content' });
  f.changes.length = 0;
  await f.reply(f.requests[0], tree('clean.txt', 'clean'));
  assert.equal(f.viewModeStore.getMode(), 'file');
  assert.deepEqual(f.changes, ['rail', 'toolbar', 'main'], 'rerender the mounted viewer and toggle');
  f.store.selectFile('modified.txt');
  assert.equal(f.viewModeStore.getMode(), 'file', 'only the first resolved selection seeds');
});

test('clean status arriving before content updates toolbar and pending viewer', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('clean.txt');
  f.changes.length = 0;
  await f.reply(f.requests[0], tree('clean.txt', 'clean'));
  assert.equal(f.viewModeStore.getMode(), 'file');
  assert.deepEqual(f.changes, ['rail', 'toolbar', 'main']);
  f.changes.length = 0;
  await f.reply(f.requests[2], { working: 'content' });
  assert.deepEqual(f.changes, ['main']);
  assert.equal(f.viewModeStore.getMode(), 'file');
});

test('latest selected file determines initial mode when tree arrives', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('clean.txt');
  f.store.selectFile('changed.txt');
  await f.reply(f.requests[0], [...tree('clean.txt', 'clean'), ...tree('changed.txt')]);
  assert.equal(f.viewModeStore.getMode(), 'diff');
  f.store.selectFile('clean.txt');
  assert.equal(f.viewModeStore.getMode(), 'diff');
});

test('saved or explicit mode selected before tree resolves wins over status', async () => {
  for (const choice of ['saved', 'explicit-file', 'explicit-diff']) {
    const f = fixture(choice === 'saved' ? 'file' : null);
    f.store.updateWorktrees(list(['/a']));
    f.store.selectFile('changed.txt');
    if (choice === 'explicit-file') f.viewModeStore.setMode('file');
    if (choice === 'explicit-diff') f.viewModeStore.setMode('diff');
    f.changes.length = 0;
    await f.reply(f.requests[0], tree('changed.txt', choice === 'explicit-diff' ? 'clean' : 'modified'));
    assert.equal(f.viewModeStore.getMode(), choice === 'explicit-diff' ? 'diff' : 'file', choice);
    assert.deepEqual(f.changes, ['rail'], 'no needless viewer remount');
  }
});

test('tree error or missing file resolves initial mode with Diff fallback', async () => {
  for (const failure of ['error', 'missing']) {
    const f = fixture();
    f.store.updateWorktrees(list(['/a']));
    f.store.selectFile('missing.txt');
    if (failure === 'error') {
      f.requests[0].reject(new Error('tree unavailable'));
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      await f.reply(f.requests[0], tree('other.txt', 'clean'));
    }
    assert.equal(f.viewModeStore.getMode(), 'diff');
    await f.reply(f.requests[2], { working: 'content' });
    f.store.selectFile('clean.txt');
    f.store.loadFileTree();
    await f.reply(f.requests.at(-1), tree('clean.txt', 'clean'));
    assert.equal(f.viewModeStore.getMode(), 'diff', 'fallback has completed seeding');
  }
});

test('switching worktrees while initial tree is pending ignores stale status', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a', '/b']));
  f.store.selectFile('first.txt'); // 2 content
  f.store.selectWorktree('/b'); // 3 tree, 4 commits
  f.store.selectFile('second.txt'); // 5 content
  await f.reply(f.requests[0], tree('first.txt', 'clean'));
  assert.equal(f.viewModeStore.getMode(), 'diff', 'stale tree cannot seed while new tree is pending');
  await f.reply(f.requests[3], tree('second.txt', 'clean'));
  assert.equal(f.viewModeStore.getMode(), 'file');
  assert.equal(f.store.getState().activeFile, 'second.txt');
});

test('switching worktrees clears file, refetches resources, and keeps lock and view mode in their stores', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a', '/b']));
  assert.deepEqual(f.watches, ['/a']);
  await f.reply(f.requests[0], tree('clean.txt', 'clean'));
  f.store.selectFile('clean.txt');
  assert.equal(f.viewModeStore.getMode(), 'file');
  assert.match(f.requests[2].url, /worktree=%2Fa&file=clean.txt$/);
  await f.reply(f.requests[2], { working: 'old' });
  f.commitLock.lockCommit('/a', 'abc');
  f.store.selectWorktree('/b');
  assert.deepEqual(f.watches, ['/a', '/b']);
  assert.equal(f.store.getState().activeFile, null);
  assert.equal(f.store.getState().fileContent, null);
  assert.equal(f.commitLock.getLockedCommit('/a'), 'abc');
  assert.equal(f.store.viewModeStore, f.viewModeStore);
  assert.equal(f.store.commitLock, f.commitLock);
  assert.match(f.requests[3].url, /worktree=%2Fb$/);
  await f.reply(f.requests[3], tree('other.txt'));
  f.store.selectFile('other.txt');
  assert.match(f.requests[5].url, /worktree=%2Fb&file=other.txt$/);
  assert.equal(f.viewModeStore.getMode(), 'file', 'first file seeds mode only once');
  assert.ok(f.changes.includes('rail'));
  assert.ok(f.changes.includes('main'));
});

test('toolbar is notified on file selection and commit arrival, independently of content', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  assert.deepEqual(f.changes.slice(0, 2), ['render', 'rail'], 'worktree renders before requests resolve');
  f.changes.length = 0;
  f.store.selectFile('open');
  assert.deepEqual(f.changes, ['rail', 'toolbar', 'main']);
  f.changes.length = 0;
  await f.reply(f.fileCommitRequests[0], [{ sha: 'abc', message: 'commit' }]);
  assert.deepEqual(f.changes, ['toolbar'], 'commit arrival must not remount the editor');
  await f.reply(f.requests[2], { working: 'content' });
  assert.deepEqual(f.changes, ['toolbar', 'main']);
});

test('out-of-order file, tree, commit and error responses cannot overwrite newer selection, even after returning to a path', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a', '/b'])); // 0 tree, 1 commits
  f.store.selectFile('one'); // 2 content
  f.store.selectFile('two'); // 3 content
  await f.reply(f.requests[3], { working: 'two' });
  await f.reply(f.requests[2], { working: 'one' });
  assert.equal(f.store.getState().fileContent.working, 'two');
  f.store.selectWorktree('/b'); // 4 tree, 5 commits
  f.store.selectWorktree('/a'); // 6 tree, 7 commits
  await f.reply(f.requests[6], tree('new'));
  await f.reply(f.requests[7], [{ sha: 'new' }]);
  f.requests[0].reject(new Error('stale'));
  await f.reply(f.requests[1], [{ sha: 'old' }]);
  await f.reply(f.requests[4], tree('b'));
  await f.reply(f.requests[5], [{ sha: 'b' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.getState().fileTree[0].path, 'new');
  assert.equal(f.store.getState().fileTreeError, null);
  assert.equal(f.store.getState().commits[0].sha, 'new');
  assert.equal(f.store.getState().activeFile, null);
});

test('remote changes always reload tree, reload content only for open file, and latest response wins', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('open'); // 2
  f.store.remoteChange(['other']); // 3 tree, no content
  assert.equal(f.requests.length, 4);
  f.store.remoteChange(['open']); // 4 tree, 5 content
  assert.equal(f.requests.length, 6);
  await f.reply(f.requests[4], tree('open', 'clean'));
  await f.reply(f.requests[5], { working: 'latest' });
  await f.reply(f.requests[3], tree('older'));
  f.requests[2].reject(new Error('stale content'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.getState().fileTree[0].path, 'open');
  assert.equal(f.store.getState().fileContent.working, 'latest');
  assert.equal(f.store.getState().fileContentError, null);
});

test('worktree removal selects fallback and prunes locks; empty list closes watch and clears state', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a', '/b']));
  f.commitLock.lockCommit('/a', 'sha');
  f.store.updateWorktrees(list(['/b']));
  assert.equal(f.commitLock.getLockedCommit('/a'), null);
  assert.equal(f.store.getState().activePath, '/b');
  f.store.updateWorktrees([]);
  assert.equal(f.store.getState().activePath, null);
  assert.deepEqual(f.store.getState().fileTree, []);
  assert.deepEqual(f.watches, ['/a', '/b', null]);
  assert.equal(f.requests.length, 4, 'no fetch for empty selection');
});

test('lock change refetch uses current ref and ignores prior response', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('space name');
  f.commitLock.lockCommit('/a', 'sha:1');
  f.store.loadFileContent();
  assert.match(f.requests[3].url, /file=space%20name&ref=sha%3A1$/);
  await f.reply(f.requests[3], { working: 'locked' });
  await f.reply(f.requests[2], { working: 'auto' });
  assert.equal(f.store.getState().fileContent.working, 'locked');
});

test('tree reload forwards encoded lock ref and rejects an earlier Auto tree and error', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a b'])); // 0 Auto tree, 1 commits
  assert.equal(f.requests[0].url, '/api/files?worktree=%2Fa%20b');
  f.commitLock.lockCommit('/a b', 'sha:1');
  f.store.loadFileTree(); // 2 locked tree
  assert.equal(f.requests[2].url, '/api/files?worktree=%2Fa%20b&ref=sha%3A1');
  await f.reply(f.requests[2], tree('locked', 'added'));
  f.requests[0].reject(new Error('stale Auto failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.getState().fileTree[0].path, 'locked');
  assert.equal(f.store.getState().fileTreeError, null);
  f.store.selectFile('locked');
  assert.equal(f.viewModeStore.getMode(), 'diff', 'latest tree status seeds the file mode');
  assert.equal(f.requests[3].url, '/api/file-content?worktree=%2Fa%20b&file=locked&ref=sha%3A1');
});

test('switching locks while a tree request is pending keeps only the latest ref result', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.commitLock.lockCommit('/a', 'first');
  f.store.loadFileTree(); // 2 first lock
  f.commitLock.lockCommit('/a', 'second');
  f.store.loadFileTree(); // 3 second lock
  assert.equal(f.requests[2].url, '/api/files?worktree=%2Fa&ref=first');
  assert.equal(f.requests[3].url, '/api/files?worktree=%2Fa&ref=second');
  await f.reply(f.requests[3], tree('second'));
  await f.reply(f.requests[2], tree('first'));
  await f.reply(f.requests[0], tree('auto'));
  assert.equal(f.store.getState().fileTree[0].path, 'second');
});

test('Auto restores the unreferenced tree and content, without accepting late locked responses', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a'])); // 0 tree, 1 commits
  f.store.selectFile('open'); // 2 Auto content
  f.commitLock.lockCommit('/a', 'sha');
  f.store.loadFileTree(); // 3 locked tree
  f.store.loadFileContent(); // 4 locked content
  f.commitLock.setAuto('/a');
  f.store.loadFileTree(); // 5 Auto tree
  f.store.loadFileContent(); // 6 Auto content
  assert.equal(f.requests[5].url, '/api/files?worktree=%2Fa');
  assert.equal(f.requests[6].url, '/api/file-content?worktree=%2Fa&file=open');
  await f.reply(f.requests[5], tree('auto'));
  await f.reply(f.requests[6], { working: 'auto' });
  await f.reply(f.requests[3], tree('locked'));
  await f.reply(f.requests[4], { working: 'locked' });
  assert.equal(f.store.getState().fileTree[0].path, 'auto');
  assert.equal(f.store.getState().fileContent.working, 'auto');
});

test('same selection reloads reject older successes and current errors remain visible', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('open');
  f.store.remoteChange(['open']); // 3 tree, 4 content
  f.requests[3].resolve({ ok: false, status: 503 });
  f.requests[4].resolve({ ok: false, status: 404 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.getState().fileTreeError.message, 'request failed with status 503');
  assert.equal(f.store.getState().fileContentError.message, 'request failed with status 404');
  await f.reply(f.requests[0], tree('stale'));
  await f.reply(f.requests[2], { working: 'stale' });
  assert.deepEqual(f.store.getState().fileTree, []);
  assert.equal(f.store.getState().fileContent, null);
  f.store.updateWorktrees(list(['/a']));
  assert.deepEqual(f.watches, ['/a'], 'unchanged worktree list does not reopen watcher');
  assert.equal(f.requests.length, 5, 'unchanged worktree list does not refetch');
});

test('opening a file refetches commits for that file; with no file open they are fetched unmarked', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  assert.match(f.requests[1].url, /^\/api\/commits\?worktree=%2Fa$/);
  f.store.selectFile('src/x.js');
  const [commitsRequest] = f.fileCommitRequests;
  assert.match(commitsRequest.url, /^\/api\/commits\?worktree=%2Fa&file=src%2Fx\.js$/);
  await f.reply(commitsRequest, [{ sha: 'abc', message: 'm', touchesFile: true }]);
  assert.deepEqual(f.store.getState().commits, [{ sha: 'abc', message: 'm', touchesFile: true }]);
});

test('marks from the previous file never linger on commits while the next file\'s commits load', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('one');
  await f.reply(f.fileCommitRequests[0], [{ sha: 'abc', message: 'm', touchesFile: true }]);
  f.store.selectFile('two');
  assert.deepEqual(f.store.getState().commits, [{ sha: 'abc', message: 'm' }], 'stale marks dropped, commit kept');
});

test('deselecting the file refetches unmarked commits', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('one');
  const before = f.requests.length;
  f.store.selectFile(null);
  assert.equal(f.requests.length, before + 1);
  assert.equal(f.requests.at(-1).url, '/api/commits?worktree=%2Fa');
});
