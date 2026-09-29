import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceUI } from '../../public/workspace-ui.js';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { createViewModeStore } from '../../public/view-mode.js';
import { createAutoScrollStore } from '../../public/auto-scroll.js';
import { Element } from './fake-dom.js';

function fixture() {
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
    treeExpansion: { isExpanded: () => false, toggle() {} },
    computeTabScrollAffordance: () => ({ showLeft: false, showRight: false }),
    formatRelativeTime: () => 'recently', DIFF_RENDER_MODES: ['inline', 'side-by-side', 'collapsed'],
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

test('toolbar controls survive commit updates and reset on worktree change', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  const oldPicker = f.toolbarEl.querySelector('.commit-picker');
  oldPicker.querySelector('.commit-picker__trigger').click();
  await f.reply(f.requests[1], [{ sha: '12345678', message: 'commit' }]);
  assert.equal(f.toolbarEl.querySelector('.commit-picker'), oldPicker);
  assert.equal(oldPicker.querySelector('.commit-picker__menu').classList.contains('is-open'), true);
  f.tabsEl.children[1].click();
  assert.notEqual(f.toolbarEl.querySelector('.commit-picker'), oldPicker);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
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
  assert.deepEqual(rows.map((row) => row.textContent), ['a.txt', 'src/b.js']);
  assert.equal(rows[0].classList.contains('status-added'), true);
  assert.equal(rows[1].classList.contains('status-deleted'), true);

  rows[1].click();
  assert.equal(f.workspace.getState().activeFile, 'src/b.js');
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
  assert.deepEqual(f.railEl.querySelectorAll('.changed-files__file').map((row) => row.textContent), ['a.txt']);
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

test('without an origin/main flag the commit dropdown shows no divider', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[1], [{ sha: '1111111aaa', message: 'one', date: '2025-01-01' }]);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__divider'), null);
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
  assert.equal(pathLabel.textContent, 'a.txt');

  f.viewModeStore.setMode('file');
  f.ui.renderToolbar();
  assert.equal(f.toolbarEl.querySelector('.view-toggle--diff'), diffToggle);
  assert.notEqual(diffToggle.hidden, true);
  assert.equal(diffToggle.classList.contains('is-concealed'), true);
});
