import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceUI } from '../../public/workspace-ui.js';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { createViewModeStore } from '../../public/view-mode.js';
import { createAutoScrollStore } from '../../public/auto-scroll.js';
import { formatRelativeTime } from '../../public/relative-time.js';
import { Element } from './fake-dom.js';

function fixture({ now = () => 1000, relativeTime = () => 'recently', treeExpanded = false } = {}) {
  const documentListeners = new Set();
  const document = {
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    addEventListener: (event, listener) => documentListeners.add(listener),
    removeEventListener: (event, listener) => documentListeners.delete(listener),
  };
  const clickOn = (target) => [...documentListeners].forEach((listener) => listener({ target }));
  const window = { addEventListener() {} };
  const tabsWrapperEl = new Element('div');
  const tabsEl = new Element('div');
  const railEl = new Element('div');
  const toolbarEl = new Element('div');
  toolbarEl.isRoot = true;
  const commitLock = createCommitLockStore();
  const viewModeStore = createViewModeStore({ getItem: () => null, setItem() {} });
  const autoScrollStore = createAutoScrollStore({ getItem: () => null, setItem() {} });
  let wrap = true;
  const navCalls = [];
  const requests = [];
  // File-scoped commit refetches (issued on file selection) are tracked apart
  // so tests can keep addressing tree/content requests by position.
  const fileCommitRequests = [];
  let ui;
  const workspace = createWorkspaceStore({
    commitLock, viewModeStore,
    fetch(url) {
      const isFileCommits = url.startsWith('/api/commits') && url.includes('&file=');
      return new Promise((resolve) => { (isFileCommits ? fileCommitRequests : requests).push({ url, resolve }); });
    },
    onActivePathChanged() {},
    onChange(part) {
      if (part === 'render') {
        ui.renderTabs();
        ui.renderToolbar();
      }
      if (part === 'toolbar') ui.renderToolbar();
      if (part === 'rail') ui.renderRail();
    },
  });
  ui = createWorkspaceUI({
    tabsWrapperEl, tabsEl, railEl, toolbarEl, workspace, commitLock, viewModeStore, autoScrollStore,
    treeExpansion: { isExpanded: () => treeExpanded, toggle() {} },
    computeTabScrollAffordance: () => ({ showLeft: false, showRight: false }),
    formatRelativeTime: relativeTime, DIFF_RENDER_MODES: ['inline', 'side-by-side', 'collapsed'],
    formatEditTime: (timestamp, now) => timestamp == null ? 'No edit time' : `${now - timestamp}ms ago`,
    now,
    onViewModeChanged() {}, onDiffRenderModeChanged() {}, getDiffRenderMode: () => 'inline',
    onNextChange: () => navCalls.push('next'), onPrevChange: () => navCalls.push('prev'),
    onToggleHelp: () => navCalls.push('help'),
    onAutoScrollChanged: (enabled) => { autoScrollStore.setEnabled(enabled); ui.renderToolbar(); },
    getWrap: () => wrap,
    onWrapChanged: () => { wrap = !wrap; ui.renderToolbar(); },
    document, window,
  });
  const reply = async (request, body) => {
    request.resolve({ ok: true, json: async () => body });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ui, workspace, commitLock, viewModeStore, autoScrollStore, navCalls, tabsEl, railEl, toolbarEl, requests, fileCommitRequests, reply, clickOn, documentListeners };
}

test('Wrap button toggles the file viewer setting in both Diff and File modes', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  const button = f.toolbarEl.querySelector('.viewer__wrap');
  assert.equal(button['aria-pressed'], 'true');
  button.click();
  assert.equal(button['aria-pressed'], 'false');
  f.viewModeStore.setMode('file');
  f.ui.renderToolbar();
  button.click();
  assert.equal(button['aria-pressed'], 'true');
});

test('each worktree tab has a bottom-right edit time; updates and clock ticks preserve tab nodes and selection', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a', branch: 'main' }, { path: '/b', branch: 'feature' }]);
  const [a, b] = f.tabsEl.children;
  assert.equal(a.querySelector('.tabs__edit-time').textContent, 'No edit time');
  assert.equal(b.querySelector('.tabs__edit-time').textContent, 'No edit time');
  f.ui.setEditTimes({ '/a': 500, '/b': 800 });
  assert.equal(a.querySelector('.tabs__edit-time').textContent, '500ms ago');
  assert.equal(b.querySelector('.tabs__edit-time').textContent, '200ms ago');
  f.ui.updateEditTimes(2000);
  assert.equal(f.tabsEl.children[1], b);
  assert.equal(b.querySelector('.tabs__edit-time').textContent, '1200ms ago');
  assert.equal(a['aria-selected'], 'true');
  assert.equal(b.querySelector('.tabs__branch').textContent, 'feature');
});

test('toolbar keeps the filename separate from the dimmed directory and preserves the full path', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{
    type: 'dir', name: 'src', path: 'src', children: [
      { type: 'file', name: 'readme.md', path: 'src/readme.md', status: 'modified' },
    ],
  }]);
  f.railEl.querySelector('.rail__dir').click();
  f.railEl.querySelector('.rail__file').click();
  const path = f.toolbarEl.querySelector('.viewer__path');
  assert.equal(path.querySelector('.viewer__directory').textContent, 'src/');
  assert.equal(path.querySelector('.viewer__filename').textContent, 'readme.md');
  assert.equal(path.title, 'src/readme.md');
});

test('commit dropdown closes on an outside click, stays open on inside clicks, and drops its listener when replaced', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  const picker = f.toolbarEl.querySelector('.commit-picker');
  const menu = picker.querySelector('.commit-picker__menu');
  picker.querySelector('.commit-picker__trigger').click();
  f.clickOn(menu);
  assert.equal(menu.classList.contains('is-open'), true);
  f.clickOn(f.railEl);
  assert.equal(menu.classList.contains('is-open'), false);
  f.tabsEl.children[1].click();
  f.clickOn(f.railEl);
  assert.equal(f.documentListeners.size, 1, 'the replaced picker removed its document listener');
});

test('closeMenus closes an open commit dropdown and is safe with no toolbar', () => {
  const f = fixture();
  f.ui.closeMenus();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  const menu = f.toolbarEl.querySelector('.commit-picker__menu');
  f.toolbarEl.querySelector('.commit-picker__trigger').click();
  assert.equal(menu.classList.contains('is-open'), true);
  f.ui.closeMenus();
  assert.equal(menu.classList.contains('is-open'), false);
});

test('commit ages use the injected clock and shared edit-time ticks preserve the open picker, lock and file', async () => {
  const date = '2026-09-27T12:00:00Z';
  const timestamp = Date.parse(date);
  let currentTime = timestamp + 30_000;
  const f = fixture({ now: () => currentTime, relativeTime: formatRelativeTime });
  const sha = 'abcdef123456';
  f.commitLock.lockCommit('/repo', sha);
  await openFile(f);
  await f.reply(f.fileCommitRequests[0], [
    { sha, message: 'Base', date, touchesFile: true, isOriginMain: true },
    { sha: 'older', message: 'Older', date: '2026-09-27T11:00:00Z' },
  ]);
  const picker = f.toolbarEl.querySelector('.commit-picker');
  const menu = picker.querySelector('.commit-picker__menu');
  const children = [...menu.children];
  const labels = menu.querySelectorAll('.commit-picker__item-time');
  assert.deepEqual(labels.map((label) => label.textContent), ['just now', '1 hour ago']);
  picker.querySelector('.commit-picker__trigger').click();
  const state = f.workspace.getState();
  const requests = f.requests.length;
  const fileCommitRequests = f.fileCommitRequests.length;
  for (const [elapsed, expected] of [
    [60_000, '1 minute ago'], [120_000, '2 minutes ago'],
    [3_600_000, '1 hour ago'], [7_200_000, '2 hours ago'], [86_400_000, '1 day ago'],
  ]) {
    currentTime = timestamp + elapsed;
    f.ui.updateEditTimes();
    assert.equal(labels[0].textContent, expected);
    assert.equal(f.toolbarEl.querySelector('.commit-picker'), picker);
    assert.equal(picker.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.children.length, children.length);
    children.forEach((child, index) => assert.equal(menu.children[index], child));
    labels.forEach((label, index) => assert.equal(menu.querySelectorAll('.commit-picker__item-time')[index], label));
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(labels[0].parentElement.classList.contains('is-selected'), true);
    assert.equal(labels[0].parentElement.classList.contains('commit-picker__item--touches-file'), true);
    assert.equal(f.commitLock.getLockedCommit('/repo'), sha);
    assert.deepEqual(f.workspace.getState(), state);
    assert.equal(f.workspace.getState().activeFile, 'a.txt');
    assert.equal(f.requests.length, requests);
    assert.equal(f.fileCommitRequests.length, fileCommitRequests);
  }
});

test('opening and reopening the commit menu refreshes existing ages without a tick or requests', async () => {
  const date = '2026-09-27T12:00:00Z';
  const timestamp = Date.parse(date);
  let currentTime = timestamp + 30_000;
  const f = fixture({ now: () => currentTime, relativeTime: formatRelativeTime });
  const sha = 'abcdef123456';
  f.commitLock.lockCommit('/repo', sha);
  await openFile(f);
  await f.reply(f.fileCommitRequests[0], [{ sha, message: 'Base', date }]);
  const picker = f.toolbarEl.querySelector('.commit-picker');
  const menu = picker.querySelector('.commit-picker__menu');
  const children = [...menu.children];
  const label = menu.querySelector('.commit-picker__item-time');
  const state = f.workspace.getState();
  const requests = f.requests.length;
  const fileCommitRequests = f.fileCommitRequests.length;
  assert.equal(label.textContent, 'just now');
  for (const [elapsed, expected] of [[60_000, '1 minute ago'], [3_600_000, '1 hour ago']]) {
    currentTime = timestamp + elapsed;
    picker.querySelector('.commit-picker__trigger').click();
    assert.equal(label.textContent, expected);
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(f.toolbarEl.querySelector('.commit-picker'), picker);
    assert.equal(picker.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.querySelector('.commit-picker__item-time'), label);
    assert.equal(menu.children.length, children.length);
    children.forEach((child, index) => assert.equal(menu.children[index], child));
    assert.equal(label.parentElement.classList.contains('is-selected'), true);
    assert.equal(f.commitLock.getLockedCommit('/repo'), sha);
    assert.deepEqual(f.workspace.getState(), state);
    assert.equal(f.workspace.getState().activeFile, 'a.txt');
    assert.equal(f.requests.length, requests);
    assert.equal(f.fileCommitRequests.length, fileCommitRequests);
    f.ui.closeMenus();
    assert.equal(menu.classList.contains('is-open'), false);
  }
});

test('commit picker locks base, reloads tree and open file, then displays lock and Auto', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  assert.equal(f.tabsEl.querySelector('.tabs__branch').textContent, 'main');
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.querySelector('.rail__file').click();
  assert.equal(f.workspace.getState().activeFile, 'a.txt');
  const sha = 'abcdef123456';
  await f.reply(f.fileCommitRequests[0], [{ sha, message: 'Earlier version', date: '2025-01-01' }]);
  const picker = f.toolbarEl.querySelector('.commit-picker');
  picker.querySelector('.commit-picker__trigger').click();
  assert.equal(picker.querySelector('.commit-picker__menu').classList.contains('is-open'), true);
  picker.querySelector('.commit-picker__item-sha').parentElement.click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), sha);
  assert.equal(f.requests[3].url, `/api/files?worktree=%2Frepo&ref=${sha}`);
  assert.equal(f.requests[4].url, `/api/file-content?worktree=%2Frepo&file=a.txt&ref=${sha}`);
  assert.equal(f.toolbarEl.querySelector('.commit-picker'), picker, 'editor controls stay mounted');
  assert.equal(picker.querySelector('.commit-picker__menu').classList.contains('is-open'), false);
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'abcdef1');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(picker.querySelector('.commit-picker__item-time').textContent, 'recently');

  picker.querySelector('.commit-picker__menu').children[0].click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), null);
  assert.equal(f.requests[5].url, '/api/files?worktree=%2Frepo');
  assert.equal(f.requests[6].url, '/api/file-content?worktree=%2Frepo&file=a.txt');
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
});

test('a stored lock absent from the log stays visible and sends its SHA until explicit Auto', async () => {
  const f = fixture();
  const sha = 'abcdef1234567890';
  f.commitLock.lockCommit('/repo', sha);
  f.workspace.updateWorktrees([{ path: '/repo', head: 'new-head' }]);
  const picker = f.toolbarEl.querySelector('.commit-picker');
  const menu = picker.querySelector('.commit-picker__menu');
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'abcdef1');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(menu.children[0].classList.contains('is-selected'), false);
  assert.equal(f.requests[0].url, `/api/files?worktree=%2Frepo&ref=${sha}`);

  await f.reply(f.requests[1], [{ sha: 'new-head', message: 'Current history' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.querySelector('.rail__file').click();
  await f.reply(f.fileCommitRequests[0], []);
  assert.equal(f.requests[2].url, `/api/file-content?worktree=%2Frepo&file=a.txt&ref=${sha}`);
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'abcdef1');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(menu.children[0].classList.contains('is-selected'), false);
  assert.equal(f.commitLock.getLockedCommit('/repo'), sha);

  menu.children[0].click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), null);
  assert.equal(f.requests[3].url, '/api/files?worktree=%2Frepo');
  assert.equal(f.requests[4].url, '/api/file-content?worktree=%2Frepo&file=a.txt');
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  assert.equal(menu.children[0].classList.contains('is-selected'), true);
});

test('history changes and working edits preserve an off-log lock, file and open menu while rejecting stale responses', async () => {
  const f = fixture();
  const sha = 'abcdef1234567890';
  await openFile(f);
  await f.reply(f.fileCommitRequests[0], [{ sha, message: 'Base' }]);
  f.toolbarEl.querySelector('.commit-picker__item-sha').parentElement.click();
  await f.reply(f.requests[3], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  await f.reply(f.requests[4], { head: 'locked base', working: 'initial working' });
  const picker = f.toolbarEl.querySelector('.commit-picker');
  const menu = picker.querySelector('.commit-picker__menu');
  picker.querySelector('.commit-picker__trigger').click();

  for (const head of ['checkout-head', 'rebased-head', 'reset-head']) {
    const before = f.requests.length;
    f.workspace.updateWorktrees([{ path: '/repo', branch: 'main', head }]);
    const [historyTree, historyContent] = f.requests.slice(before);
    assert.equal(historyTree.url, `/api/files?worktree=%2Frepo&ref=${sha}`);
    assert.equal(historyContent.url, `/api/file-content?worktree=%2Frepo&file=a.txt&ref=${sha}`);
    await f.reply(f.fileCommitRequests.at(-1), [{ sha: head, message: 'New history' }]);

    f.workspace.remoteChange(['a.txt']);
    const [editTree, editContent] = f.requests.slice(before + 2);
    assert.equal(editTree.url, `/api/files?worktree=%2Frepo&ref=${sha}`);
    assert.equal(editContent.url, `/api/file-content?worktree=%2Frepo&file=a.txt&ref=${sha}`);
    const tree = [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }];
    const content = { head: 'locked base', working: `working after ${head}` };
    await f.reply(editTree, tree);
    await f.reply(editContent, content);
    if (head === 'rebased-head') {
      historyTree.resolve({ ok: false, status: 500 });
      historyContent.resolve({ ok: false, status: 500 });
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      await f.reply(historyTree, []);
      await f.reply(historyContent, { head: 'wrong base', working: 'stale working' });
    }

    assert.deepEqual(f.workspace.getState().fileTree, tree);
    assert.deepEqual(f.workspace.getState().fileContent, content);
    assert.equal(f.workspace.getState().fileTreeError, null);
    assert.equal(f.workspace.getState().fileContentError, null);
    assert.equal(f.workspace.getState().activeFile, 'a.txt');
    assert.equal(f.commitLock.getLockedCommit('/repo'), sha);
    assert.equal(f.toolbarEl.querySelector('.commit-picker'), picker);
    assert.equal(picker.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(menu.children[0].classList.contains('is-selected'), false);
    assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'abcdef1');
    assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  }
});

test('toolbar controls survive commit updates and reset on worktree change', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  const oldPicker = f.toolbarEl.querySelector('.commit-picker');
  oldPicker.querySelector('.commit-picker__trigger').click();
  await f.reply(f.requests[1], [{ sha: '12345678', message: 'commit', isOriginMain: true }]);
  assert.equal(f.toolbarEl.querySelector('.commit-picker'), oldPicker);
  assert.equal(oldPicker.querySelector('.commit-picker__trigger').className, 'commit-picker__trigger commit-picker__trigger--at');
  assert.equal(oldPicker.querySelector('.commit-picker__menu').classList.contains('is-open'), true);
  f.tabsEl.children[1].click();
  assert.notEqual(f.toolbarEl.querySelector('.commit-picker'), oldPicker);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger').className, 'commit-picker__trigger');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger').title, '');
  f.ui.renderError(new Error('unavailable'));
  assert.equal(f.tabsEl.children.length, 0);
  assert.equal(f.railEl.children.length, 0);
  assert.equal(f.toolbarEl.hidden, true);
  assert.equal(f.toolbarEl.children.length, 0);
});

test('locking without a selected file still refreshes the tree, not file content', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  await f.reply(f.requests[1], [{ sha: '12345678', message: 'base' }]);
  f.toolbarEl.querySelector('.commit-picker__item-sha').parentElement.click();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].url, '/api/files?worktree=%2Fa&ref=12345678');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger-sha').textContent, '1234567');
});

test('commit dropdown marks only commits that touched the open file, keeping all in order', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.querySelector('.rail__file').click();
  await f.reply(f.fileCommitRequests[0], [
    { sha: '1111111aaa', message: 'touched', date: '2025-01-01', touchesFile: true },
    { sha: '2222222bbb', message: 'unrelated', date: '2025-01-01', touchesFile: false },
  ]);
  const items = f.toolbarEl.querySelector('.commit-picker__menu').children.slice(1);
  assert.deepEqual(items.map((i) => i.classList.contains('commit-picker__item--touches-file')), [true, false]);
  assert.deepEqual(items.map((i) => i.querySelector('.commit-picker__item-sha').textContent), ['1111111', '2222222']);
});

test('with no file open the commit dropdown applies no marking', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[1], [
    { sha: '1111111aaa', message: 'one', date: '2025-01-01' },
    { sha: '2222222bbb', message: 'two', date: '2025-01-01' },
  ]);
  const items = f.toolbarEl.querySelector('.commit-picker__menu').children.slice(1);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => !i.classList.contains('commit-picker__item--touches-file')));
});

test('changed-files list shows full paths sorted, status-colored, and opens a file on click', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [
    { type: 'dir', name: 'src', path: 'src', children: [
      { type: 'file', name: 'b.js', path: 'src/b.js', status: 'deleted' },
      { type: 'file', name: 'ok.js', path: 'src/ok.js', status: 'clean' },
    ] },
    { type: 'file', name: 'a.txt', path: 'a.txt', status: 'added' },
  ]);

  const rows = f.railEl.querySelectorAll('.changed-files__file');
  assert.deepEqual(rows.map((row) => row.querySelector('.changed-files__path').textContent), ['a.txt', 'src/b.js']);
  assert.equal(rows[0].classList.contains('status-added'), true);
  assert.equal(rows[1].classList.contains('status-deleted'), true);

  rows[1].click();
  assert.equal(f.workspace.getState().activeFile, 'src/b.js');
});

test('renamed files show full old → new labels and titles in both rail views and open the destination', async () => {
  const f = fixture({ treeExpanded: true });
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{
    type: 'dir', name: 'new dir', path: 'new dir', children: [
      { type: 'file', name: 'new -> name.js', path: 'new dir/new -> name.js', status: 'renamed', oldPath: 'old dir/old -> name.js', mtimeMs: 500 },
      { type: 'file', name: 'ordinary.js', path: 'new dir/ordinary.js', status: 'modified' },
    ],
  }]);
  const treeRows = f.railEl.querySelector('.rail__tree').querySelectorAll('.rail__file');
  const changedRows = f.railEl.querySelectorAll('.changed-files__file');
  const label = 'old dir/old -> name.js → new dir/new -> name.js';
  assert.equal(treeRows[0].textContent, label);
  assert.equal(changedRows[0].querySelector('.changed-files__path').textContent, label);
  assert.equal(changedRows[0].querySelector('.changed-files__age').textContent, '500ms ago');
  for (const row of [treeRows[0], changedRows[0]]) {
    assert.equal(row.title, label);
    assert.equal(row.classList.contains('status-renamed'), true);
    row.click();
    assert.equal(f.workspace.getState().activeFile, 'new dir/new -> name.js');
  }
  assert.equal(f.requests[2].url, '/api/file-content?worktree=%2Frepo&file=new%20dir%2Fnew%20-%3E%20name.js');
  assert.equal(treeRows[1].textContent, 'ordinary.js');
  assert.equal(treeRows[1].title, 'new dir/ordinary.js');
  assert.equal(changedRows[1].querySelector('.changed-files__path').textContent, 'new dir/ordinary.js');
  assert.equal(changedRows[1].classList.contains('status-modified'), true);
});

test('changed-file ages appear beside saved files, not deleted or unknown files, and refresh without replacing rows', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [
    { type: 'dir', name: 'src', path: 'src', children: [
      { type: 'file', name: 'edited.js', path: 'src/edited.js', status: 'modified', mtimeMs: 500 },
    ] },
    { type: 'file', name: 'new.txt', path: 'new.txt', status: 'added', mtimeMs: 800 },
    { type: 'file', name: 'gone.txt', path: 'gone.txt', status: 'deleted', mtimeMs: 100 },
    { type: 'file', name: 'unknown.txt', path: 'unknown.txt', status: 'modified' },
  ]);
  const rows = f.railEl.querySelectorAll('.changed-files__file');
  assert.deepEqual(rows.map((row) => row.querySelector('.changed-files__path')?.textContent),
    ['gone.txt', 'new.txt', 'src/edited.js', 'unknown.txt']);
  assert.equal(rows[0].querySelector('.changed-files__age'), null);
  assert.equal(rows[1].querySelector('.changed-files__age').textContent, '200ms ago');
  assert.equal(rows[2].querySelector('.changed-files__age').textContent, '500ms ago');
  assert.equal(rows[3].querySelector('.changed-files__age'), null);
  assert.equal(rows[2].querySelector('.changed-files__age').title, `Last saved edit: ${new Date(500).toLocaleString()}`);
  rows[2].click();
  const selected = f.railEl.querySelectorAll('.changed-files__file')[2];
  assert.equal(selected.classList.contains('is-active'), true);
  f.ui.updateEditTimes(2000);
  assert.equal(f.railEl.querySelectorAll('.changed-files__file')[2], selected);
  assert.equal(selected.querySelector('.changed-files__age').textContent, '1500ms ago');
  assert.equal(f.workspace.getState().activeFile, 'src/edited.js');
});

test('changed-files list stays visible with an empty state when nothing changed, the tree is empty, or loading failed', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'clean' }]);
  assert.equal(f.railEl.querySelector('.changed-files__empty').textContent, 'No changed files');

  f.workspace.remoteChange([]);
  await f.reply(f.requests.at(-1), []);
  assert.equal(f.railEl.querySelector('.rail__message').textContent, 'No files.');
  assert.equal(f.railEl.querySelector('.changed-files__empty').textContent, 'No changed files');

  f.workspace.remoteChange([]);
  f.requests.at(-1).resolve({ ok: false, status: 503 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(f.railEl.querySelector('.rail__message').textContent, /^Failed to load files/);
  assert.equal(f.railEl.querySelector('.changed-files__empty').textContent, 'No changed files');
});

test('changed-files list updates when a watcher event refetches the tree', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'clean' }]);
  assert.equal(f.railEl.querySelectorAll('.changed-files__file').length, 0);

  f.workspace.remoteChange(['a.txt']);
  await f.reply(f.requests.at(-1), [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  assert.deepEqual(f.railEl.querySelectorAll('.changed-files__file').map((row) => row.querySelector('.changed-files__path').textContent), ['a.txt']);
  assert.equal(f.railEl.querySelector('.changed-files__empty'), null);
});

test('commit dropdown draws an origin/main divider above the flagged commit, separating local from pushed', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[1], [
    { sha: '3333333ccc', message: 'local', date: '2025-01-03', isOriginMain: false },
    { sha: '2222222bbb', message: 'pushed', date: '2025-01-02', isOriginMain: true },
    { sha: '1111111aaa', message: 'older', date: '2025-01-01', isOriginMain: false },
  ]);
  const rows = f.toolbarEl.querySelector('.commit-picker__menu').children.slice(1);
  assert.deepEqual(rows.map((r) => r.classList.contains('commit-picker__divider') ? 'divider' : r.querySelector('.commit-picker__item-sha').textContent),
    ['3333333', 'divider', '2222222', '1111111']);
  assert.equal(rows[1].textContent, 'origin/main');
});

test('selecting a commit behind the origin/main divergence accents the left edge and explains the relationship', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[1], [
    { sha: 'newest', message: 'Local' },
    { sha: 'base', message: 'Divergence', isOriginMain: true },
    { sha: 'older', message: 'Older' },
  ]);
  f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[2].parentElement.click();
  const trigger = f.toolbarEl.querySelector('.commit-picker__trigger');
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--behind');
  assert.equal(trigger.title, 'Selected commit is behind the origin/main divergence');
});

test('selecting the origin/main divergence moves the accent to the top edge', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[1], [
    { sha: 'base', message: 'Divergence', isOriginMain: true },
    { sha: 'older', message: 'Older' },
  ]);
  const trigger = f.toolbarEl.querySelector('.commit-picker__trigger');
  f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[1].parentElement.click();
  f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[0].parentElement.click();
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
  assert.equal(trigger.title, 'Selected commit is at the origin/main divergence');
});

test('selecting a commit ahead of the origin/main divergence moves the accent to the right edge', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[1], [
    { sha: 'newest', message: 'Local' },
    { sha: 'base', message: 'Divergence', isOriginMain: true },
  ]);
  const trigger = f.toolbarEl.querySelector('.commit-picker__trigger');
  f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[1].parentElement.click();
  f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[0].parentElement.click();
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--ahead');
  assert.equal(trigger.title, 'Selected commit is ahead of the origin/main divergence');
});

test('Auto uses the newest commit relationship, including after resetting a locked commit', async () => {
  for (const [commits, expected, tooltip] of [
    [[
      { sha: 'base', message: 'Divergence', isOriginMain: true },
      { sha: 'older', message: 'Older' },
    ], 'at', 'Selected commit is at the origin/main divergence'],
    [[
      { sha: 'newest', message: 'Local' },
      { sha: 'base', message: 'Divergence', isOriginMain: true },
      { sha: 'older', message: 'Older' },
    ], 'ahead', 'Selected commit is ahead of the origin/main divergence'],
  ]) {
    const f = fixture();
    f.workspace.updateWorktrees([{ path: '/repo' }]);
    await f.reply(f.requests[1], commits);
    const trigger = f.toolbarEl.querySelector('.commit-picker__trigger');
    assert.equal(trigger.className, `commit-picker__trigger commit-picker__trigger--${expected}`);
    assert.equal(trigger.title, tooltip);
    f.toolbarEl.querySelectorAll('.commit-picker__item-sha').at(-1).parentElement.click();
    assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--behind');
    f.toolbarEl.querySelector('.commit-picker__menu').children[0].click();
    assert.equal(trigger.className, `commit-picker__trigger commit-picker__trigger--${expected}`);
    assert.equal(trigger.title, tooltip);
    assert.equal(trigger.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
    assert.equal(trigger.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  }
});

test('missing selected commits, missing divergence markers and empty logs clear stale accents and tooltips', async () => {
  for (const commits of [
    [{ sha: 'other', message: 'Other history', isOriginMain: true }],
    [{ sha: 'base', message: 'No known divergence' }],
    [],
  ]) {
    const f = fixture();
    f.commitLock.lockCommit('/repo', 'base');
    f.workspace.updateWorktrees([{ path: '/repo' }]);
    const trigger = f.toolbarEl.querySelector('.commit-picker__trigger');
    assert.equal(trigger.className, 'commit-picker__trigger');
    assert.equal(trigger.title, '');
    await f.reply(f.requests[1], [{ sha: 'base', message: 'Divergence', isOriginMain: true }]);
    assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
    f.workspace.loadCommits();
    await f.reply(f.requests.at(-1), commits);
    assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger'), trigger);
    assert.equal(trigger.className, 'commit-picker__trigger');
    assert.equal(trigger.title, '');
    assert.equal(trigger.querySelector('.commit-picker__trigger-sha').textContent, 'base');
    assert.equal(trigger.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  }
});

test('refreshing the divergence marker updates the selected commit accent without replacing or closing the picker', async () => {
  const f = fixture();
  f.commitLock.lockCommit('/repo', 'middle');
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[1], [
    { sha: 'newest', message: 'Newest' },
    { sha: 'middle', message: 'Selected', isOriginMain: true },
    { sha: 'oldest', message: 'Oldest' },
  ]);
  const picker = f.toolbarEl.querySelector('.commit-picker');
  const trigger = picker.querySelector('.commit-picker__trigger');
  const menu = picker.querySelector('.commit-picker__menu');
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
  trigger.click();
  for (const [originMainSha, expected, tooltip] of [
    ['oldest', 'ahead', 'Selected commit is ahead of the origin/main divergence'],
    ['newest', 'behind', 'Selected commit is behind the origin/main divergence'],
  ]) {
    f.workspace.updateWorktrees([{ path: '/repo', originMainSha }]);
    await f.reply(f.requests.at(-1), [
      { sha: 'newest', message: 'Newest', isOriginMain: originMainSha === 'newest' },
      { sha: 'middle', message: 'Selected' },
      { sha: 'oldest', message: 'Oldest', isOriginMain: originMainSha === 'oldest' },
    ]);
    assert.equal(f.toolbarEl.querySelector('.commit-picker'), picker);
    assert.equal(picker.querySelector('.commit-picker__trigger'), trigger);
    assert.equal(picker.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(trigger.className, `commit-picker__trigger commit-picker__trigger--${expected}`);
    assert.equal(trigger.title, tooltip);
    assert.equal(f.commitLock.getLockedCommit('/repo'), 'middle');
  }
});

test('a failed commit refresh clears the divergence accent, preserves the lock and shows the existing error message', async () => {
  const f = fixture();
  f.commitLock.lockCommit('/repo', 'base');
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[1], [{ sha: 'base', message: 'Divergence', isOriginMain: true }]);
  const trigger = f.toolbarEl.querySelector('.commit-picker__trigger');
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
  f.workspace.loadCommits();
  f.requests.at(-1).resolve({ ok: false, status: 503 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(trigger.className, 'commit-picker__trigger');
  assert.equal(trigger.title, '');
  assert.equal(trigger.querySelector('.commit-picker__trigger-sha').textContent, 'base');
  assert.equal(f.commitLock.getLockedCommit('/repo'), 'base');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__divider'), null);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__item--error').textContent,
    'Failed to load commits: request failed with status 503');
  f.workspace.loadCommits();
  await f.reply(f.requests.at(-1), [{ sha: 'base', message: 'Divergence', isOriginMain: true }]);
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
  assert.equal(trigger.title, 'Selected commit is at the origin/main divergence');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__item--error'), null);
});

test('Auto follows refreshed HEAD history and becomes neutral when the history is empty', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', head: 'base' }]);
  const trigger = f.toolbarEl.querySelector('.commit-picker__trigger');
  assert.equal(trigger.className, 'commit-picker__trigger');
  assert.equal(trigger.title, '');
  await f.reply(f.requests[1], [{ sha: 'base', message: 'Divergence', isOriginMain: true }]);
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
  f.workspace.updateWorktrees([{ path: '/repo', head: 'newest' }]);
  await f.reply(f.requests.at(-1), [
    { sha: 'newest', message: 'New HEAD' },
    { sha: 'base', message: 'Divergence', isOriginMain: true },
  ]);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger'), trigger);
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--ahead');
  assert.equal(trigger.title, 'Selected commit is ahead of the origin/main divergence');
  f.workspace.loadCommits();
  await f.reply(f.requests.at(-1), []);
  assert.equal(trigger.className, 'commit-picker__trigger');
  assert.equal(trigger.title, '');
  assert.equal(trigger.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
});

test('without an origin/main flag the commit dropdown shows no divider', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[1], [{ sha: '1111111aaa', message: 'one', date: '2025-01-01' }]);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__divider'), null);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger').className, 'commit-picker__trigger');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger').title, '');
});

async function openFile(f) {
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.querySelector('.rail__file').click();
}

test('change navigation is disabled with no file open and in File mode, and enabled otherwise', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  const steps = () => f.toolbarEl.querySelectorAll('.change-nav__step');
  assert.deepEqual(steps().map((button) => button.disabled), [true, true]);

  await openFile(f);
  assert.deepEqual(steps().map((button) => button.disabled), [false, false]);

  f.viewModeStore.setMode('file');
  f.ui.renderToolbar();
  assert.deepEqual(steps().map((button) => button.disabled), [true, true]);
});

test('next and previous buttons call the change handlers', async () => {
  const f = fixture();
  await openFile(f);
  const [prev, next] = f.toolbarEl.querySelectorAll('.change-nav__step');
  next.click();
  prev.click();
  assert.deepEqual(f.navCalls, ['next', 'prev']);
});

test('the help button sits last in the toolbar and calls the help handler', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  const right = f.toolbarEl.querySelector('.viewer__toolbar-right');
  const button = right.querySelector('.help-button');
  assert.equal(right.children.at(-1), button);
  button.click();
  assert.deepEqual(f.navCalls, ['help']);
});

test('auto-scroll toggle reflects and flips the global preference', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  const auto = f.toolbarEl.querySelector('.change-nav__auto');
  assert.equal(auto.classList.contains('is-on'), false);
  assert.equal(auto['aria-pressed'], 'false');
  auto.click();
  assert.equal(f.autoScrollStore.isEnabled(), true);
  assert.equal(auto.classList.contains('is-on'), true);
  assert.equal(auto['aria-pressed'], 'true');
});

test('selecting a file or switching mode moves no toolbar element: nothing is hidden or removed', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  const pathLabel = f.toolbarEl.querySelector('.viewer__path');
  const diffToggle = f.toolbarEl.querySelector('.view-toggle--diff');
  assert.notEqual(pathLabel.hidden, true);

  await openFile(f);
  assert.equal(f.toolbarEl.querySelector('.viewer__path'), pathLabel);
  assert.notEqual(pathLabel.hidden, true);
  assert.equal(pathLabel.querySelector('.viewer__filename').textContent, 'a.txt');

  f.viewModeStore.setMode('file');
  f.ui.renderToolbar();
  assert.equal(f.toolbarEl.querySelector('.view-toggle--diff'), diffToggle);
  assert.notEqual(diffToggle.hidden, true);
  assert.equal(diffToggle.classList.contains('is-concealed'), true);
});
