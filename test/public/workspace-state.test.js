import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { createViewModeStore } from '../../public/view-mode.js';

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
  const commentRequests = [];
  const postRequests = [];
  const changes = [];
  const watches = [];
  const commitLock = createCommitLockStore();
  const viewModeStore = createViewModeStore({ getItem: () => savedMode, setItem: () => {} });
  const store = createWorkspaceStore({
    commitLock, viewModeStore,
    fetch(url, options) {
      const pending = deferred();
      if (options?.method === 'POST') {
        postRequests.push({ url, options, ...pending });
        return pending.promise;
      }
      if (url.startsWith('/api/comments')) {
        commentRequests.push({ url, ...pending });
        return pending.promise;
      }
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
  return { store, requests, fileCommitRequests, commentRequests, postRequests, changes, watches, commitLock, viewModeStore, reply };
}

const tree = (name, status = 'modified') => [{ type: 'file', path: name, name, status }];
const list = (paths) => paths.map((path) => ({ path }));

test('resolution conflicts wait for superseding watch refreshes, retry the chosen flag and block unreadable or cross-worktree saves', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a', '/b']));
  await f.reply(f.commentRequests[0], { threads: [{ id: 't', resolved: false, messages: ['seen'] }], revision: 'r1', warning: null });
  let settled = false;
  const saved = f.store.setThreadResolved({ threadId: 't', resolved: true });
  const rejected = assert.rejects(saved, /Comments changed/).then(() => { settled = true; });
  assert.deepEqual(JSON.parse(f.postRequests[0].options.body), { action: 'set-resolved', threadId: 't', resolved: true, revision: 'r1' });
  f.postRequests[0].resolve({ ok: false, status: 409, json: async () => ({ error: 'Comments changed', conflict: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  f.store.remoteChange(['.canopy/comments.yaml']);
  await f.reply(f.commentRequests[1], { threads: [{ id: 't', resolved: false, messages: ['stale'] }], revision: 'stale', warning: null });
  assert.equal(settled, false, 'retry stays pending until the latest watch refresh completes');
  await f.reply(f.commentRequests[2], { threads: [{ id: 't', resolved: false, messages: ['seen', 'agent'] }], revision: 'r2', warning: null });
  await rejected;
  const retry = f.store.setThreadResolved({ threadId: 't', resolved: true });
  assert.equal(JSON.parse(f.postRequests[1].options.body).revision, 'r2');
  f.postRequests[1].resolve({ ok: true, status: 201 });
  await new Promise((resolve) => setImmediate(resolve));
  await f.reply(f.commentRequests[3], { threads: [{ id: 't', resolved: true, messages: ['seen', 'agent'] }], revision: 'r3', warning: null });
  await retry;
  assert.equal(f.store.getState().comments.threads[0].resolved, true);
  const reopen = f.store.setThreadResolved({ threadId: 't', resolved: false });
  f.postRequests[2].resolve({ ok: false, status: 409, json: async () => ({ error: 'Comments changed' }) });
  const failed = assert.rejects(reopen, /Comments changed/);
  await new Promise((resolve) => setImmediate(resolve));
  f.commentRequests[4].reject(new Error('offline'));
  await failed;
  await assert.rejects(f.store.setThreadResolved({ threadId: 't', resolved: false }), /cannot be read/);
  f.store.selectWorktree('/b');
  await assert.rejects(f.store.setThreadResolved({ threadId: 't', resolved: true, worktree: '/a' }), /worktree changed/);
  assert.equal(f.postRequests.length, 3);
});

test('reply conflict waits for refreshed conversation before retry and never posts against a failed refresh', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a', '/b']));
  await f.reply(f.commentRequests[0], { threads: [{ id: 't', messages: ['seen'] }], revision: 'r1', warning: null });
  let settled = false;
  const saved = f.store.addReply({ threadId: 't', text: 'my draft' });
  const rejected = assert.rejects(saved, /Comments changed/).then(() => { settled = true; });
  assert.deepEqual(JSON.parse(f.postRequests[0].options.body), { threadId: 't', text: 'my draft', revision: 'r1' });
  f.postRequests[0].resolve({ ok: false, status: 409, json: async () => ({ error: 'Comments changed', conflict: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await f.reply(f.commentRequests[1], { threads: [{ id: 't', messages: ['seen', 'incoming'] }], revision: 'r2', warning: null });
  await rejected;
  assert.deepEqual(f.store.getState().comments.threads[0].messages, ['seen', 'incoming']);
  const retry = f.store.addReply({ threadId: 't', text: 'my draft' });
  assert.equal(JSON.parse(f.postRequests[1].options.body).revision, 'r2');
  f.postRequests[1].resolve({ ok: false, status: 409, json: async () => ({ error: 'Comments changed', conflict: true }) });
  const failed = assert.rejects(retry, /Comments changed/);
  await new Promise((resolve) => setImmediate(resolve));
  f.commentRequests[2].reject(new Error('offline'));
  await failed;
  await assert.rejects(f.store.addReply({ threadId: 't', text: 'my draft' }), /cannot be read/);
  assert.equal(f.postRequests.length, 2, 'failed refresh cannot let a retry overwrite unseen messages');
  f.store.selectWorktree('/b');
  await f.reply(f.commentRequests.at(-1), { threads: [], revision: 'absent', warning: null });
  await assert.rejects(f.store.addReply({ threadId: 't', text: 'my draft', worktree: '/a' }), /worktree/);
  assert.equal(f.postRequests.length, 2);
});

test('reply success refreshes all messages before resolving and worktree round trips invalidate pending saves', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a', '/b']));
  await f.reply(f.commentRequests[0], { threads: [{ id: 't', messages: [] }], revision: 'r1', warning: null });
  const saved = f.store.addReply({ threadId: 't', text: 'reply' });
  f.postRequests[0].resolve({ ok: true, status: 201 });
  await new Promise((resolve) => setImmediate(resolve));
  await f.reply(f.commentRequests[1], { threads: [{ id: 't', messages: ['reply'] }], revision: 'r2', warning: null });
  await saved;
  const late = f.store.addReply({ threadId: 't', text: 'late' });
  const rejected = assert.rejects(late, /worktree/);
  f.store.selectWorktree('/b');
  f.store.selectWorktree('/a');
  f.postRequests[1].resolve({ ok: false, status: 409, json: async () => ({ error: 'conflict' }) });
  await rejected;
});

test('comment navigation distinguishes general from unavailable anchors, preserves same-file content and clears removed selections', async () => {
  const f = fixture('file');
  f.store.updateWorktrees(list(['/a', '/b']));
  const anchored = { id: 't', file: 'one', unavailable: 'missing', line_range: { start: 4, end: 8 } };
  await f.reply(f.commentRequests[0], { threads: [anchored, { id: 'general' }], warning: null });
  f.store.selectThread('t');
  assert.equal(f.store.getState().activeFile, 'one');
  assert.equal(f.store.getState().selectedThreadId, 't');
  assert.equal(f.store.getState().mainView, 'file');
  await f.reply(f.requests[2], { head: '', working: 'content' });
  const content = f.store.getState().fileContent;
  const count = f.requests.length;
  f.changes.length = 0;
  f.store.selectThread('t');
  assert.equal(f.store.getState().fileContent, content);
  assert.equal(f.requests.length, count);
  assert.deepEqual(f.changes, ['comments']);
  f.store.showGeneralComments();
  assert.equal(f.store.getState().mainView, 'general');
  assert.equal(f.viewModeStore.getMode(), 'file');
  f.store.selectFile('one');
  assert.equal(f.store.getState().mainView, 'file');
  assert.equal(f.store.getState().selectedThreadId, null);
  assert.equal(f.store.getState().fileContent, content);
  f.store.selectThread('t');
  f.store.loadComments();
  await f.reply(f.commentRequests.at(-1), { threads: [], warning: null });
  assert.equal(f.store.getState().selectedThreadId, null);
  f.store.showGeneralComments();
  f.store.selectWorktree('/b');
  assert.equal(f.store.getState().mainView, 'file');
  assert.equal(f.store.getState().selectedThreadId, null);
});

test('refreshing a selected thread follows changed file attachment without accepting stale file content', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a']));
  const anchored = { id: 't', file: 'one', line_range: { start: 1, end: 2 } };
  await f.reply(f.commentRequests[0], { threads: [anchored], warning: null });
  f.store.selectThread('t');
  const oldContent = f.requests[2];
  f.store.loadComments();
  await f.reply(f.commentRequests.at(-1), { threads: [{ ...anchored, file: 'two' }], warning: null });
  assert.equal(f.store.getState().activeFile, 'two');
  assert.equal(f.store.getState().selectedThreadId, 't');
  await f.reply(oldContent, { head: '', working: 'stale one' });
  assert.equal(f.store.getState().fileContent, null);
  await f.reply(f.requests.at(-1), { head: '', working: 'current two' });
  f.store.loadComments();
  await f.reply(f.commentRequests.at(-1), { threads: [{ id: 't' }], warning: null });
  assert.equal(f.store.getState().mainView, 'general');
  assert.equal(f.store.getState().selectedThreadId, null);
});

test('comments load per worktree and reject old responses after switch away/back, reload and reconnect; a warning payload carries no threads', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a', '/b']));
  assert.equal(f.commentRequests[0].url, '/api/comments?worktree=%2Fa');
  await f.reply(f.commentRequests[0], { threads: [{ id: 'a' }], warning: null });
  assert.deepEqual(f.store.getState().comments.threads, [{ id: 'a' }]);
  f.store.loadComments();
  const oldA = f.commentRequests.at(-1);
  f.store.selectWorktree('/b');
  assert.deepEqual(f.store.getState().comments, { threads: [], warning: null });
  const oldB = f.commentRequests.at(-1);
  f.store.selectWorktree('/a');
  const oldReturn = f.commentRequests.at(-1);
  f.store.remoteChange();
  const reconnect = f.commentRequests.at(-1);
  f.store.remoteChange(['.canopy/comments.yaml']);
  await f.reply(f.commentRequests.at(-1), { threads: [], warning: 'warning' });
  f.changes.length = 0;
  await f.reply(oldA, { threads: [{ id: 'stale' }], warning: null });
  oldB.reject(new Error('old error'));
  await f.reply(oldReturn, { threads: [], warning: null });
  await f.reply(reconnect, { threads: [], warning: null });
  assert.deepEqual(f.store.getState().comments, { threads: [], warning: 'warning' });
  assert.deepEqual(f.changes, []);
  f.store.updateWorktrees([]);
  assert.deepEqual(f.store.getState().comments, { threads: [], warning: null });
});

test('tree arrival reconciles conversation visibility and current comment failures remain visible until reload', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a']));
  await f.reply(f.commentRequests[0], { threads: [{ id: 't', file: 'a.js' }], warning: null });
  f.changes.length = 0;
  await f.reply(f.requests[0], tree('a.js'));
  assert.deepEqual(f.changes, ['rail', 'comments-refresh']);
  const pending = f.store.loadComments();
  f.commentRequests.at(-1).reject(new Error('offline'));
  await pending;
  assert.match(f.store.getState().comments.warning, /offline/);
  const reload = f.store.loadComments();
  await f.reply(f.commentRequests.at(-1), { threads: [], warning: null });
  await reload;
  assert.deepEqual(f.store.getState().comments, { threads: [], warning: null });
});

test('identical refreshed content preserves its identity and does not notify the mounted viewer', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('open');
  await f.reply(f.requests[2], { head: 'base', working: 'disk' });
  const content = f.store.getState().fileContent;
  f.changes.length = 0;
  f.store.remoteChange();
  await f.reply(f.requests[4], { working: 'disk', head: 'base' });
  assert.equal(f.store.getState().fileContent, content);
  assert.deepEqual(f.changes, []);

  f.store.remoteChange();
  await f.reply(f.requests[6], { head: 'different base', working: 'disk' });
  assert.deepEqual(f.changes, ['main'], 'either comparison side changing refreshes the viewer');
  f.changes.length = 0;
  f.store.remoteChange();
  f.requests[8].resolve({ ok: false, status: 503 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.changes, ['main']);
  f.changes.length = 0;
  f.store.remoteChange();
  await f.reply(f.requests[10], { head: 'different base', working: 'disk' });
  assert.equal(f.store.getState().fileContentError, null);
  assert.deepEqual(f.changes, ['main'], 'success following an error restores the viewer');
});

test('no-path reconciliation rejects older successes and errors after reconnect, file events and selection transitions', async () => {
  for (const transition of ['reconnect', 'event', 'file', 'worktree', 'return', 'removal']) {
    for (const staleResult of ['success', 'error']) {
      const f = fixture('diff');
      f.store.updateWorktrees(list(['/a', '/b']));
      f.store.selectFile('one');
      f.store.remoteChange(); // 3 tree, 4 content
      const stale = [f.requests[0], f.requests[2], f.requests[3], f.requests[4]];
      if (transition === 'removal') {
        f.store.updateWorktrees([]);
      } else {
        if (transition === 'file') f.store.selectFile('two');
        if (['worktree', 'return'].includes(transition)) {
          f.store.selectWorktree('/b');
          if (transition === 'return') f.store.selectWorktree('/a');
          f.store.selectFile('two');
        }
        if (transition === 'event') f.store.remoteChange(['one']);
        else f.store.remoteChange();
        await f.reply(f.requests.at(-2), tree('latest', 'added'));
        await f.reply(f.requests.at(-1), { head: 'latest base', working: 'latest disk' });
      }
      const expected = f.store.getState();
      f.changes.length = 0;
      for (const request of stale) {
        if (staleResult === 'success') {
          await f.reply(request, request.url.startsWith('/api/files')
            ? tree('stale', 'deleted') : { head: 'stale base', working: 'stale disk' });
        } else request.reject(new Error('stale reconnect failure'));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(f.store.getState(), expected, `${transition}: ${staleResult}`);
      assert.deepEqual(f.changes, [], 'stale responses never notify the viewer or rail');
    }
  }
});

test('status invalidation reconciles the API tree only, preserving content, selection, commits and lock', async () => {
  const f = fixture('diff');
  f.commitLock.lockCommit('/a', 'locked');
  f.store.updateWorktrees([{ path: '/a', head: 'same' }]);
  await f.reply(f.requests[0], tree('open', 'clean'));
  f.store.selectFile('open');
  await f.reply(f.requests[2], { head: 'same base', working: 'same disk' });
  await f.reply(f.fileCommitRequests[0], [{ sha: 'same', touchesFile: true }]);
  const before = f.store.getState();
  f.changes.length = 0;

  const pending = f.store.invalidateStatus();
  assert.equal(f.requests.length, 4, 'only one additional tree request');
  assert.equal(f.requests[3].url, '/api/files?worktree=%2Fa&ref=locked');
  assert.equal(f.fileCommitRequests.length, 1);
  await f.reply(f.requests[3], tree('open', 'deleted'));
  await pending;

  assert.deepEqual(f.store.getState().fileTree, tree('open', 'deleted'));
  assert.equal(f.store.getState().activeFile, 'open');
  assert.equal(f.store.getState().fileContent, before.fileContent);
  assert.equal(f.store.getState().commits, before.commits);
  assert.equal(f.commitLock.getLockedCommit('/a'), 'locked');
  assert.equal(f.viewModeStore.getMode(), 'diff');
  assert.deepEqual(f.changes, ['rail']);
});

test('status refresh does not seed an unresolved viewer and older trees cannot overwrite it', async () => {
  const f = fixture();
  f.store.updateWorktrees(list(['/a']));
  f.store.selectFile('open');
  await f.reply(f.requests[2], { working: 'same disk' });
  f.changes.length = 0;
  f.store.invalidateStatus();
  f.store.invalidateStatus();
  await f.reply(f.requests[4], tree('open', 'clean'));
  assert.equal(f.viewModeStore.getMode(), 'diff', 'status-only refresh leaves the mounted mode alone');
  assert.deepEqual(f.changes, ['rail']);
  f.changes.length = 0;
  await f.reply(f.requests[0], tree('old', 'added'));
  f.requests[3].reject(new Error('older status failure'));
  await Promise.resolve();
  assert.deepEqual(f.store.getState().fileTree, tree('open', 'clean'));
  assert.equal(f.store.getState().fileTreeError, null);
  assert.deepEqual(f.changes, []);
});

test('status responses stay stale across worktree switches, even after returning to the same path', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a', '/b']));
  f.store.invalidateStatus(); // 2 old /a status
  f.store.selectWorktree('/b'); // 3 tree, 4 commits
  f.store.invalidateStatus(); // 5 old /b status
  f.store.selectWorktree('/a'); // 6 tree, 7 commits
  await f.reply(f.requests[6], tree('current', 'clean'));
  f.changes.length = 0;
  await f.reply(f.requests[2], tree('old-a', 'added'));
  f.requests[5].reject(new Error('old-b failure'));
  await Promise.resolve();
  assert.deepEqual(f.store.getState().fileTree, tree('current', 'clean'));
  assert.equal(f.store.getState().fileTreeError, null);
  assert.deepEqual(f.changes, []);
});

test('origin/main-only changes refresh file-scoped commits without reloading or disturbing the workspace', async () => {
  const f = fixture('file');
  f.store.updateWorktrees([{ path: '/a', head: 'bbb', originMainSha: 'aaa' }]);
  await f.reply(f.requests[0], tree('open'));
  f.store.selectFile('open');
  await f.reply(f.requests[2], { working: 'unchanged', head: 'locked base' });
  await f.reply(f.fileCommitRequests[0], [{ sha: 'bbb' }, { sha: 'aaa', isOriginMain: true }]);
  f.commitLock.lockCommit('/a', 'aaa');
  const before = f.store.getState();
  f.changes.length = 0;

  f.store.updateWorktrees([{ path: '/a', head: 'bbb', originMainSha: 'bbb' }]);
  assert.equal(f.fileCommitRequests.length, 2, 'ref movement refreshes commits');
  assert.equal(f.fileCommitRequests[1].url, '/api/commits?worktree=%2Fa&file=open');
  assert.deepEqual(f.changes, [], 'ref-only notification must not remount the viewer or redraw tabs');
  await f.reply(f.fileCommitRequests[1], [{ sha: 'bbb', isOriginMain: true }, { sha: 'aaa', isOriginMain: false }]);
  const after = f.store.getState();
  assert.equal(after.activePath, '/a');
  assert.equal(after.activeFile, 'open');
  assert.equal(after.fileTree, before.fileTree);
  assert.equal(after.fileContent, before.fileContent);
  assert.equal(f.commitLock.getLockedCommit('/a'), 'aaa');
  assert.equal(f.viewModeStore.getMode(), 'file');
  assert.deepEqual(f.watches, ['/a']);
  assert.equal(f.requests.length, 3, 'no tree or content request');
  assert.deepEqual(f.changes, ['toolbar']);
  f.store.updateWorktrees([{ path: '/a', head: 'bbb', originMainSha: 'bbb' }]);
  assert.equal(f.fileCommitRequests.length, 2, 'unchanged ref does not refresh again');
});

test('origin/main refresh with no open file is unmarked and a simultaneous HEAD change reloads resources only once', async () => {
  const f = fixture();
  f.store.updateWorktrees([{ path: '/a', head: 'old', originMainSha: null }]);
  f.changes.length = 0;
  f.store.updateWorktrees([{ path: '/a', head: 'old', originMainSha: 'aaa' }]);
  assert.deepEqual(f.requests.slice(2).map(({ url }) => url), ['/api/commits?worktree=%2Fa']);
  await f.reply(f.requests[2], [{ sha: 'aaa', isOriginMain: true }]);
  assert.deepEqual(f.changes, ['toolbar']);
  assert.equal(f.commitLock.getLockedCommit('/a'), null);
  f.store.updateWorktrees([{ path: '/a', head: 'new', originMainSha: 'new' }]);
  assert.deepEqual(f.requests.slice(3).map(({ url }) => url), [
    '/api/files?worktree=%2Fa', '/api/commits?worktree=%2Fa',
  ]);
  assert.equal(f.fileCommitRequests.length, 0);
  assert.equal(f.store.getState().activeFile, null);
});

test('stale origin/main refresh successes and errors cannot overwrite a newer refresh, file, worktree or removal', async () => {
  for (const transition of ['refresh', 'file', 'worktree', 'removal']) {
    for (const staleResult of ['success', 'error']) {
      const f = fixture();
      const snapshot = (originMainSha) => ['/a', '/b'].map((path) => ({ path, head: 'bbb', originMainSha }));
      f.store.updateWorktrees(snapshot('aaa'));
      f.store.selectFile('one');
      f.store.updateWorktrees(snapshot('bbb'));
      const stale = [f.requests[1], ...f.fileCommitRequests];
      let current;
      if (transition === 'refresh') {
        f.store.updateWorktrees(snapshot(null));
        current = f.fileCommitRequests.at(-1);
      } else if (transition === 'file') {
        f.store.selectFile('two');
        current = f.fileCommitRequests.at(-1);
      } else if (transition === 'worktree') {
        f.store.selectWorktree('/b');
        current = f.requests.at(-1);
      } else {
        f.store.updateWorktrees([]);
      }
      const expected = current ? [{ sha: 'latest', isOriginMain: true }] : [];
      if (current) await f.reply(current, expected);
      f.changes.length = 0;
      for (const request of stale) {
        if (staleResult === 'success') await f.reply(request, [{ sha: 'stale', isOriginMain: true, touchesFile: true }]);
        else request.reject(new Error('stale ref failure'));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(f.store.getState().commits, expected, `${transition}: ${staleResult}`);
      assert.equal(f.store.getState().commitsError, null);
      assert.deepEqual(f.changes, [], 'stale commits never notify the toolbar');
      assert.equal(f.store.getState().activePath, transition === 'removal' ? null : transition === 'worktree' ? '/b' : '/a');
      assert.equal(f.store.getState().activeFile, transition === 'file' ? 'two' : ['removal', 'worktree'].includes(transition) ? null : 'one');
    }
  }
});

test('active HEAD change in Auto reloads commits, tree and open content without changing selection', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees([{ path: '/a', head: 'old' }]);
  await f.reply(f.requests[0], tree('src/open.txt'));
  f.store.selectFile('src/open.txt');
  await f.reply(f.fileCommitRequests[0], [{ sha: 'old', touchesFile: true }]);
  await f.reply(f.requests[2], { working: 'before', base: 'old base' });
  f.changes.length = 0;

  assert.deepEqual(f.store.updateWorktrees([{ path: '/a', head: 'new' }]), ['/a']);
  assert.equal(f.requests.length, 5, 'HEAD change reloads tree and open content');
  assert.equal(f.fileCommitRequests.length, 2, 'HEAD change reloads file-scoped commits');
  assert.equal(f.requests[3].url, '/api/files?worktree=%2Fa');
  assert.equal(f.requests[4].url, '/api/file-content?worktree=%2Fa&file=src%2Fopen.txt');
  assert.equal(f.fileCommitRequests[1].url, '/api/commits?worktree=%2Fa&file=src%2Fopen.txt');
  assert.deepEqual(f.watches, ['/a'], 'same path keeps the existing watch');
  assert.equal(f.store.getState().activePath, '/a');
  assert.equal(f.store.getState().activeFile, 'src/open.txt');
  assert.equal(f.commitLock.getLockedCommit('/a'), null);
  assert.equal(f.viewModeStore.getMode(), 'diff');

  await f.reply(f.requests[3], tree('src/open.txt', 'clean'));
  await f.reply(f.fileCommitRequests[1], [{ sha: 'new', touchesFile: false }]);
  await f.reply(f.requests[4], { working: 'after', base: 'new base' });
  assert.deepEqual(f.store.getState().fileTree, tree('src/open.txt', 'clean'));
  assert.deepEqual(f.store.getState().commits, [{ sha: 'new', touchesFile: false }]);
  assert.deepEqual(f.store.getState().fileContent, { working: 'after', base: 'new base' });
  assert.equal(f.viewModeStore.getMode(), 'diff', 'refreshed status does not reset the chosen mode');
  assert.deepEqual(f.changes, ['metadata', 'rail', 'toolbar', 'main']);
});

test('unchanged active HEAD and inactive HEAD changes do not refetch workspace resources', () => {
  const f = fixture();
  f.store.updateWorktrees([{ path: '/a', head: 'a' }, { path: '/b', head: 'b' }]);
  f.store.selectFile('open');
  f.changes.length = 0;
  f.store.updateWorktrees([{ path: '/a', head: 'a' }, { path: '/b', head: 'b' }]);
  f.store.updateWorktrees([{ path: '/a', head: 'a', branch: 'renamed' }, { path: '/b', head: 'new-b' }]);
  assert.equal(f.requests.length, 3);
  assert.equal(f.fileCommitRequests.length, 1);
  assert.deepEqual(f.watches, ['/a']);
  assert.deepEqual(f.changes, ['metadata']);
  assert.equal(f.store.getState().activeFile, 'open');
});

test('active HEAD change with no open file reloads only tree and unmarked commits', async () => {
  const f = fixture();
  f.store.updateWorktrees([{ path: '/a', head: 'old' }]);
  f.store.updateWorktrees([{ path: '/a', head: 'new' }]);
  assert.deepEqual(f.requests.slice(2).map(({ url }) => url), [
    '/api/files?worktree=%2Fa', '/api/commits?worktree=%2Fa',
  ]);
  assert.equal(f.fileCommitRequests.length, 0);
  await f.reply(f.requests[2], tree('new'));
  await f.reply(f.requests[3], [{ sha: 'new' }]);
  assert.deepEqual(f.store.getState().fileTree, tree('new'));
  assert.deepEqual(f.store.getState().commits, [{ sha: 'new' }]);
  assert.equal(f.store.getState().activeFile, null);
  assert.equal(f.store.getState().fileContent, null);
  assert.deepEqual(f.watches, ['/a']);
  f.store.updateWorktrees([{ path: '/a', head: 'new' }]);
  assert.equal(f.requests.length, 4, 'repeated new HEAD snapshot does not refresh again');
});

test('active HEAD change preserves the locked ref for refreshed tree and open content', async () => {
  const f = fixture('file');
  f.commitLock.lockCommit('/a b', 'sha:1');
  f.store.updateWorktrees([{ path: '/a b', head: 'old' }]);
  f.store.selectFile('space name');
  f.store.updateWorktrees([{ path: '/a b', head: 'new' }]);
  assert.equal(f.requests[3].url, '/api/files?worktree=%2Fa%20b&ref=sha%3A1');
  assert.equal(f.requests[4].url, '/api/file-content?worktree=%2Fa%20b&file=space%20name&ref=sha%3A1');
  assert.equal(f.fileCommitRequests[1].url, '/api/commits?worktree=%2Fa%20b&file=space%20name');
  await f.reply(f.requests[3], tree('space name'));
  await f.reply(f.requests[4], { working: 'new working', base: 'locked base' });
  await f.reply(f.fileCommitRequests[1], [{ sha: 'new' }, { sha: 'sha:1' }]);
  assert.equal(f.commitLock.getLockedCommit('/a b'), 'sha:1');
  assert.equal(f.viewModeStore.getMode(), 'file');
  assert.equal(f.store.getState().activePath, '/a b');
  assert.equal(f.store.getState().activeFile, 'space name');
  assert.deepEqual(f.store.getState().fileContent, { working: 'new working', base: 'locked base' });
  assert.deepEqual(f.store.getState().commits, [{ sha: 'new' }, { sha: 'sha:1' }]);
  assert.deepEqual(f.watches, ['/a b']);
});

test('pre-HEAD tree, commit and content responses cannot overwrite the refreshed workspace', async () => {
  for (const staleResult of ['success', 'error']) {
    const f = fixture();
    f.store.updateWorktrees([{ path: '/a', head: 'old' }]);
    f.store.selectFile('open');
    f.store.updateWorktrees([{ path: '/a', head: 'new' }]);
    await f.reply(f.requests[3], tree('open'));
    await f.reply(f.fileCommitRequests[1], [{ sha: 'new', touchesFile: false }]);
    await f.reply(f.requests[4], { working: 'new', base: 'new base' });
    f.changes.length = 0;
    if (staleResult === 'success') {
      await f.reply(f.requests[0], tree('old', 'clean'));
      await f.reply(f.requests[1], [{ sha: 'old unmarked' }]);
      await f.reply(f.fileCommitRequests[0], [{ sha: 'old', touchesFile: true }]);
      await f.reply(f.requests[2], { working: 'old', base: 'old base' });
    } else {
      for (const request of [f.requests[0], f.requests[1], f.fileCommitRequests[0], f.requests[2]]) {
        request.reject(new Error('stale pre-HEAD failure'));
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(f.store.getState().fileTree, tree('open'), staleResult);
    assert.deepEqual(f.store.getState().commits, [{ sha: 'new', touchesFile: false }], staleResult);
    assert.deepEqual(f.store.getState().fileContent, { working: 'new', base: 'new base' }, staleResult);
    assert.equal(f.store.getState().fileTreeError, null);
    assert.equal(f.store.getState().commitsError, null);
    assert.equal(f.store.getState().fileContentError, null);
    assert.deepEqual(f.changes, [], 'stale responses do not rerender');
  }
});

test('worktree fallback with a changed HEAD fetches the new path only once', async () => {
  const f = fixture();
  f.store.updateWorktrees([{ path: '/a', head: 'old-a' }, { path: '/b', head: 'old-b' }]);
  f.store.selectFile('open');
  f.store.updateWorktrees([{ path: '/b', head: 'new-b' }]);
  assert.deepEqual(f.requests.slice(3).map(({ url }) => url), [
    '/api/files?worktree=%2Fb', '/api/commits?worktree=%2Fb',
  ]);
  assert.equal(f.fileCommitRequests.length, 1, 'switch clears the file rather than reloading it');
  assert.equal(f.store.getState().activePath, '/b');
  assert.equal(f.store.getState().activeFile, null);
  assert.deepEqual(f.watches, ['/a', '/b']);
  await f.reply(f.requests[3], tree('b'));
  await f.reply(f.requests[4], [{ sha: 'new-b' }]);
  assert.deepEqual(f.store.getState().fileTree, tree('b'));
  assert.deepEqual(f.store.getState().commits, [{ sha: 'new-b' }]);
});

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

test('a renamed file loads its content with the old path, and a pairing found later reloads it', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a']));
  await f.reply(f.requests[0], [{ type: 'file', path: 'new.js', name: 'new.js', status: 'renamed', oldPath: 'old.js' }]);
  f.store.selectFile('new.js');
  assert.equal(f.requests[2].url, '/api/file-content?worktree=%2Fa&file=new.js&oldFile=old.js');

  const g = fixture('diff');
  g.store.updateWorktrees(list(['/a']));
  await g.reply(g.requests[0], [{ type: 'file', path: 'moved.js', name: 'moved.js', status: 'added' }]);
  g.store.selectFile('moved.js');
  assert.equal(g.requests[2].url, '/api/file-content?worktree=%2Fa&file=moved.js');
  g.store.remoteChange();
  await g.reply(g.requests[3], [{ type: 'file', path: 'moved.js', name: 'moved.js', status: 'renamed', oldPath: 'gone.js' }]);
  assert.ok(g.requests.some((request) => request.url === '/api/file-content?worktree=%2Fa&file=moved.js&oldFile=gone.js'));
});

test('adding a comment posts the loaded revision to the active worktree and reloads comments on success', async () => {
  const f = fixture('file');
  f.store.updateWorktrees(list(['/a']));
  await f.reply(f.commentRequests[0], { threads: [], warning: null, revision: 'absent' });
  const saved = f.store.addComment({ file: 'one', line: 3, text: 'Why?' });
  const [post] = f.postRequests;
  assert.equal(post.url, '/api/comments?worktree=%2Fa');
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.options.body), { file: 'one', line: 3, text: 'Why?', revision: 'absent' });
  post.resolve({ ok: true, json: async () => ({ revision: 'r2' }) });
  await saved;
  assert.equal(f.commentRequests.length, 2);
  await f.reply(f.commentRequests[1], { threads: [{ id: 'new' }], warning: null, revision: 'r2' });
  assert.deepEqual(f.store.getState().comments.threads, [{ id: 'new' }]);
});

test('a range save sends its end line with the revision it was composed against', async () => {
  const f = fixture('file');
  f.store.updateWorktrees(list(['/a']));
  await f.reply(f.commentRequests[0], { threads: [], warning: null, revision: 'r1' });
  const saved = f.store.addComment({ file: 'one', line: 3, endLine: 5, text: 'Why?' });
  assert.deepEqual(JSON.parse(f.postRequests[0].options.body), { file: 'one', line: 3, endLine: 5, text: 'Why?', revision: 'r1' });
  f.postRequests[0].resolve({ ok: false, status: 409, json: async () => ({ error: 'Comments changed', conflict: true }) });
  await assert.rejects(saved, /Comments changed/);
});

test('a stale or failed save rejects with the server message and reloads the latest comments', async () => {
  const f = fixture('file');
  f.store.updateWorktrees(list(['/a']));
  await f.reply(f.commentRequests[0], { threads: [], warning: null, revision: 'absent' });
  const saved = f.store.addComment({ file: 'one', line: 3, text: 'Why?' });
  f.postRequests[0].resolve({ ok: false, status: 409, json: async () => ({ error: 'Comments changed', conflict: true, revision: 'r9' }) });
  await assert.rejects(saved, /Comments changed/);
  assert.equal(f.commentRequests.length, 2, 'latest comments are reloaded');
  const failed = f.store.addComment({ file: 'one', line: 3, text: 'Why?' });
  f.postRequests[1].resolve({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
  await assert.rejects(failed, /status 500/);
});

test('saving is refused before comments have loaded, without a request', async () => {
  const f = fixture('file');
  f.store.updateWorktrees(list(['/a']));
  await assert.rejects(f.store.addComment({ file: 'one', line: 3, text: 'Why?' }), /still loading/);
  assert.deepEqual(f.postRequests, []);
});

test('saving explains an unreadable sidecar instead of claiming comments are loading', async () => {
  const f = fixture('file');
  f.store.updateWorktrees(list(['/a']));
  await f.reply(f.commentRequests[0], { threads: [], warning: 'Cannot load comments: Symlink', revision: null });
  await assert.rejects(f.store.addComment({ file: 'one', line: 3, text: 'Why?' }), /Symlink/);
  assert.deepEqual(f.postRequests, []);
});

test('a malformed external write keeps the last valid conversation with a warning until a valid write recovers', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a']));
  const thread = { id: 't', file: 'a.js', resolved: false };
  await f.reply(f.commentRequests[0], { threads: [thread], warning: null, revision: 'r1' });
  f.store.remoteChange(['.canopy/comments.yaml']);
  await f.reply(f.commentRequests.at(-1), { threads: [], warning: 'Cannot load comments: bad', revision: null });
  assert.deepEqual(f.store.getState().comments, { threads: [thread], warning: 'Cannot load comments: bad', revision: null });
  f.store.remoteChange(['.canopy/comments.yaml']);
  const resolved = { ...thread, resolved: true };
  await f.reply(f.commentRequests.at(-1), { threads: [resolved], warning: null, revision: 'r2' });
  assert.deepEqual(f.store.getState().comments, { threads: [resolved], warning: null, revision: 'r2' });
});

test('malformed data from the previous worktree never shows in the new one', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a', '/b']));
  await f.reply(f.commentRequests[0], { threads: [{ id: 'a-thread' }], warning: null });
  f.store.remoteChange();
  const staleA = f.commentRequests.at(-1);
  f.store.selectWorktree('/b');
  await f.reply(f.commentRequests.at(-1), { threads: [{ id: 'b-thread' }], warning: null });
  await f.reply(staleA, { threads: [], warning: 'Cannot load comments: bad' });
  assert.deepEqual(f.store.getState().comments, { threads: [{ id: 'b-thread' }], warning: null });
});

test('a failed comments load keeps the last valid conversation with the failure warning', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a']));
  const thread = { id: 't' };
  await f.reply(f.commentRequests[0], { threads: [thread], warning: null });
  f.store.remoteChange();
  f.commentRequests.at(-1).reject(new Error('offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.store.getState().comments, { threads: [thread], warning: 'Failed to load comments: offline' });
});

test('a live comments load reports a refresh, not a selection change, so the viewer does not scroll', async () => {
  const f = fixture('diff');
  f.store.updateWorktrees(list(['/a']));
  const thread = { id: 't', file: 'a.js', resolved: false };
  await f.reply(f.commentRequests[0], { threads: [thread], warning: null });
  f.changes.length = 0;
  f.store.remoteChange(['.canopy/comments.yaml']);
  await f.reply(f.commentRequests.at(-1), { threads: [{ ...thread, resolved: true }], warning: null });
  assert.ok(f.changes.includes('comments-refresh'));
  assert.ok(!f.changes.includes('comments'));
});
