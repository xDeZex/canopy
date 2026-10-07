import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceUI } from '../../public/workspace-ui.js';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { createViewModeStore } from '../../public/view-mode.js';
import { createAutoScrollStore } from '../../public/auto-scroll.js';
import { DIFF_RENDER_MODES } from '../../public/monaco-view.js';
import { formatRelativeTime } from '../../public/relative-time.js';
import { Element } from './fake-dom.js';
import { createTreeExpansionStore } from '../../public/tree-state.js';
import { createWatchPreferenceStore } from '../../public/watch-preference.js';
import { computeTabScrollAffordance } from '../../public/tab-scroll.js';
import { parseWorktrees } from '../../public/workspace-contracts.js';
import type { OutsideClick } from '../../public/workspace-dom.js';
import type { JsonResponse } from '../../public/workspace-contracts.js';

interface Request { url: string; resolve(response: JsonResponse): void }
function parent(element: Element): Element {
  assert.ok(element.parentElement, 'expected a mounted control');
  return element.parentElement;
}
function last<T>(values: T[]): T {
  const value = values.at(-1);
  assert.ok(value, 'expected a queued value');
  return value;
}
interface FixtureOptions {
  now?: () => number;
  relativeTime?: typeof formatRelativeTime;
}

function fixture({ now = () => 1000, relativeTime = () => 'recently' }: FixtureOptions = {}) {
  const documentListeners = new Set<(event: OutsideClick) => void>();
  const document = {
    createElement: (tag: string) => new Element(tag),
    addEventListener: (_event: 'click', listener: (event: OutsideClick) => void) => documentListeners.add(listener),
    removeEventListener: (_event: 'click', listener: (event: OutsideClick) => void) => documentListeners.delete(listener),
  };
  const clickOn = (target: Element) => {
    const path: Element[] = [];
    for (let node: Element | null = target; node; node = node.parentElement) path.push(node);
    [...documentListeners].forEach((listener) => listener({ composedPath: () => path }));
  };
  const windowListeners = new Map<string, () => void>();
  const window = { addEventListener: (event: string, listener: () => void) => windowListeners.set(event, listener) };
  const tabsWrapperEl = new Element('div');
  const tabsEl = new Element('div');
  const railEl = new Element('div');
  const toolbarEl = new Element('div');
  toolbarEl.isRoot = true;
  const commitLock = createCommitLockStore();
  const treeExpansion = createTreeExpansionStore();
  const preferences = new Map<string, string>();
  const storage = { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => { preferences.set(key, value); } };
  const viewModeStore = createViewModeStore(storage);
  const autoScrollStore = createAutoScrollStore(storage);
  const watchPreferenceStore = createWatchPreferenceStore(storage);
  let diffMode: typeof DIFF_RENDER_MODES[number] = 'inline';
  const deleteCalls: (string | null)[] = [];
  let wrap = true;
  const navCalls: string[] = [];
  const requests: Request[] = [];
  // File-scoped commit refetches (issued on file selection) are tracked apart
  // so tests can keep addressing tree/content requests by position.
  const fileCommitRequests: Request[] = [];
  const commentRequests: Request[] = [];
  let ui: ReturnType<typeof createWorkspaceUI<Element>>;
  const workspace = createWorkspaceStore({
    commitLock, viewModeStore,
    fetch(url) {
      const isFileCommits = url.startsWith('/api/commits') && url.includes('&file=');
      const target = url.startsWith('/api/comments') ? commentRequests : isFileCommits ? fileCommitRequests : requests;
      return new Promise<JsonResponse>((resolve) => { target.push({ url, resolve }); });
    },
    onActivePathChanged() {},
    onChange(part) {
      if (part === 'render') {
        ui.renderTabs();
        ui.renderToolbar();
      }
      if (part === 'toolbar') ui.renderToolbar();
      if (part === 'rail') ui.renderRail();
      if (part === 'comments' || part === 'comments-refresh') ui.refreshComments();
    },
  });
  ui = createWorkspaceUI({
    tabsWrapperEl, tabsEl, railEl, toolbarEl, workspace, commitLock, viewModeStore, autoScrollStore,
    treeExpansion,
    computeTabScrollAffordance,
    formatRelativeTime: relativeTime, DIFF_RENDER_MODES,
    formatEditTime: (timestamp, now) => timestamp == null ? 'No edit time' : `${now - timestamp}ms ago`,
    now,
    onViewModeChanged: (mode) => { viewModeStore.setMode(mode); ui.renderToolbar(); },
    onDiffRenderModeChanged: (mode) => { diffMode = mode; ui.renderToolbar(); }, getDiffRenderMode: () => diffMode,
    onNextChange: () => navCalls.push('next'), onPrevChange: () => navCalls.push('prev'),
    onToggleHelp: () => navCalls.push('help'),
    onAutoScrollChanged: (enabled) => { autoScrollStore.setEnabled(enabled); ui.renderToolbar(); },
    getWrap: () => wrap,
    onWrapChanged: () => { wrap = !wrap; ui.renderToolbar(); },
    onDeleteWorktree: (path) => { deleteCalls.push(path); },
    getIgnoreGitignore: () => watchPreferenceStore.isEnabled(),
    onIgnoreGitignoreChanged: (enabled) => { watchPreferenceStore.setEnabled(enabled); ui.renderToolbar(); },
    document, window,
  });
  const reply = async (request: Request | undefined, body: unknown) => {
    assert.ok(request, 'expected a queued request');
    request.resolve({ ok: true, json: async () => body });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ui, workspace, treeExpansion, commitLock, viewModeStore, autoScrollStore, watchPreferenceStore, preferences, storage, deleteCalls, windowListeners, navCalls, tabsWrapperEl, tabsEl, railEl, toolbarEl, requests, fileCommitRequests, commentRequests, reply, clickOn, documentListeners };
}

test('sidebar comments refresh and navigate even with an empty file tree', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  f.railEl.require('.comment-index__button').click();
  assert.equal(f.workspace.getState().mainView, 'general');
  await f.reply(f.commentRequests[0], { threads: [{ id: 't', file: 'missing.js', side: 'modified', line_range: { start: 2, end: 4 },
    resolved: false, created_at: '2026-10-01T12:00:00Z', messages: [{ id: 'm', author: 'user', created_at: '2026-10-01T12:00:00Z', text: 'Hidden from sidebar' }] }], warning: null });
  const buttons = f.railEl.querySelectorAll('.comment-index__button');
  assert.deepEqual(buttons.map((button) => button.textContent), ['Comments without a file', 'missing.js:2–4']);
  buttons[1].click();
  assert.equal(f.workspace.getState().activeFile, 'missing.js');
  assert.equal(f.workspace.getState().selectedThreadId, 't');
  const mounted = f.railEl.querySelectorAll('.comment-index__button')[1];
  mounted.click();
  assert.equal(f.railEl.querySelectorAll('.comment-index__button')[1], mounted, 'same-file reveals preserve the focused sidebar button');
});

test('Diff layout toggle exposes only Inline and Side-by-side, and is concealed in File mode', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  const toggle = f.toolbarEl.require('.view-toggle--diff');
  const buttons = toggle.querySelectorAll('.view-toggle__btn');
  assert.deepEqual(buttons.map((button) => button.dataset.mode), ['inline', 'side-by-side']);
  assert.deepEqual(buttons.map((button) => button.textContent), ['Inline', 'Side-by-side']);
  f.viewModeStore.setMode('file');
  f.ui.renderToolbar();
  assert.equal(toggle.classList.contains('is-concealed'), true);
});

test('Wrap button toggles the file viewer setting in both Diff and File modes', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  const button = f.toolbarEl.require('.viewer__wrap');
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
  assert.equal(a.require('.tabs__edit-time').textContent, 'No edit time');
  assert.equal(b.require('.tabs__edit-time').textContent, 'No edit time');
  f.ui.setEditTimes({ '/a': 500, '/b': 800 });
  assert.equal(a.require('.tabs__edit-time').textContent, '500ms ago');
  assert.equal(b.require('.tabs__edit-time').textContent, '200ms ago');
  f.ui.updateEditTimes(2000);
  assert.equal(f.tabsEl.children[1], b);
  assert.equal(b.require('.tabs__edit-time').textContent, '1200ms ago');
  assert.equal(a['aria-selected'], 'true');
  assert.equal(b.require('.tabs__branch').textContent, 'feature');
});

test('toolbar keeps the filename separate from the dimmed directory and preserves the full path', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{
    type: 'dir', name: 'src', path: 'src', children: [
      { type: 'file', name: 'readme.md', path: 'src/readme.md', status: 'modified' },
    ],
  }]);
  f.railEl.require('.rail__dir').click();
  f.railEl.require('.rail__file').click();
  const path = f.toolbarEl.require('.viewer__path');
  assert.equal(path.require('.viewer__directory').textContent, 'src/');
  assert.equal(path.require('.viewer__filename').textContent, 'readme.md');
  assert.equal(path.title, 'src/readme.md');
});

test('commit dropdown closes on an outside click, stays open on inside clicks, and drops its listener when replaced', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  const picker = f.toolbarEl.require('.commit-picker');
  const menu = picker.require('.commit-picker__menu');
  picker.require('.commit-picker__trigger').click();
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
  const menu = f.toolbarEl.require('.commit-picker__menu');
  f.toolbarEl.require('.commit-picker__trigger').click();
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
  const picker = f.toolbarEl.require('.commit-picker');
  const menu = picker.require('.commit-picker__menu');
  const children = [...menu.children];
  const labels = menu.querySelectorAll('.commit-picker__item-time');
  assert.deepEqual(labels.map((label) => label.textContent), ['just now', '1 hour ago']);
  picker.require('.commit-picker__trigger').click();
  const state = f.workspace.getState();
  const requests = f.requests.length;
  const fileCommitRequests = f.fileCommitRequests.length;
  for (const [elapsed, expected] of [
    [60_000, '1 minute ago'], [120_000, '2 minutes ago'],
    [3_600_000, '1 hour ago'], [7_200_000, '2 hours ago'], [86_400_000, '1 day ago'],
  ] as const) {
    currentTime = timestamp + elapsed;
    f.ui.updateEditTimes();
    assert.equal(labels[0].textContent, expected);
    assert.equal(f.toolbarEl.require('.commit-picker'), picker);
    assert.equal(picker.require('.commit-picker__menu'), menu);
    assert.equal(menu.children.length, children.length);
    children.forEach((child, index) => assert.equal(menu.children[index], child));
    labels.forEach((label, index) => assert.equal(menu.querySelectorAll('.commit-picker__item-time')[index], label));
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(parent(labels[0]).classList.contains('is-selected'), true);
    assert.equal(parent(labels[0]).classList.contains('commit-picker__item--touches-file'), true);
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
  const picker = f.toolbarEl.require('.commit-picker');
  const menu = picker.require('.commit-picker__menu');
  const children = [...menu.children];
  const label = menu.require('.commit-picker__item-time');
  const state = f.workspace.getState();
  const requests = f.requests.length;
  const fileCommitRequests = f.fileCommitRequests.length;
  assert.equal(label.textContent, 'just now');
  for (const [elapsed, expected] of [[60_000, '1 minute ago'], [3_600_000, '1 hour ago']] as const) {
    currentTime = timestamp + elapsed;
    picker.require('.commit-picker__trigger').click();
    assert.equal(label.textContent, expected);
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(f.toolbarEl.require('.commit-picker'), picker);
    assert.equal(picker.require('.commit-picker__menu'), menu);
    assert.equal(menu.require('.commit-picker__item-time'), label);
    assert.equal(menu.children.length, children.length);
    children.forEach((child, index) => assert.equal(menu.children[index], child));
    assert.equal(parent(label).classList.contains('is-selected'), true);
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
  assert.equal(f.tabsEl.require('.tabs__branch').textContent, 'main');
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.require('.rail__file').click();
  assert.equal(f.workspace.getState().activeFile, 'a.txt');
  const sha = 'abcdef123456';
  await f.reply(f.fileCommitRequests[0], [{ sha, message: 'Earlier version', date: '2025-01-01' }]);
  const picker = f.toolbarEl.require('.commit-picker');
  picker.require('.commit-picker__trigger').click();
  assert.equal(picker.require('.commit-picker__menu').classList.contains('is-open'), true);
  parent(picker.require('.commit-picker__item-sha')).click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), sha);
  assert.equal(f.requests[3].url, `/api/files?worktree=%2Frepo&ref=${sha}`);
  assert.equal(f.requests[4].url, `/api/file-content?worktree=%2Frepo&file=a.txt&ref=${sha}`);
  assert.equal(f.toolbarEl.require('.commit-picker'), picker, 'editor controls stay mounted');
  assert.equal(picker.require('.commit-picker__menu').classList.contains('is-open'), false);
  assert.equal(picker.require('.commit-picker__trigger-title').textContent, 'Earlier version');
  assert.equal(picker.require('.commit-picker__trigger-title').title, 'Earlier version');
  assert.equal(picker.require('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(picker.require('.commit-picker__item-time').textContent, 'recently');

  picker.require('.commit-picker__menu').children[0].click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), null);
  assert.equal(f.requests[5].url, '/api/files?worktree=%2Frepo');
  assert.equal(f.requests[6].url, '/api/file-content?worktree=%2Frepo&file=a.txt');
  assert.equal(picker.require('.commit-picker__trigger-title').textContent, 'HEAD');
  assert.equal(picker.require('.commit-picker__trigger-label').textContent, 'since last commit');
});

test('a stored lock absent from the log stays visible and sends its SHA until explicit Auto', async () => {
  const f = fixture();
  const sha = 'abcdef1234567890';
  f.commitLock.lockCommit('/repo', sha);
  f.workspace.updateWorktrees([{ path: '/repo', head: 'new-head' }]);
  const picker = f.toolbarEl.require('.commit-picker');
  const menu = picker.require('.commit-picker__menu');
  assert.equal(picker.require('.commit-picker__trigger-title').textContent, 'abcdef1');
  assert.equal(picker.require('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(menu.children[0].classList.contains('is-selected'), false);
  assert.equal(f.requests[0].url, `/api/files?worktree=%2Frepo&ref=${sha}`);

  await f.reply(f.requests[1], [{ sha: 'new-head', message: 'Current history' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.require('.rail__file').click();
  await f.reply(f.fileCommitRequests[0], []);
  assert.equal(f.requests[2].url, `/api/file-content?worktree=%2Frepo&file=a.txt&ref=${sha}`);
  assert.equal(picker.require('.commit-picker__trigger-title').textContent, 'abcdef1');
  assert.equal(picker.require('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(menu.children[0].classList.contains('is-selected'), false);
  assert.equal(f.commitLock.getLockedCommit('/repo'), sha);

  menu.children[0].click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), null);
  assert.equal(f.requests[3].url, '/api/files?worktree=%2Frepo');
  assert.equal(f.requests[4].url, '/api/file-content?worktree=%2Frepo&file=a.txt');
  assert.equal(picker.require('.commit-picker__trigger-title').textContent, 'HEAD');
  assert.equal(picker.require('.commit-picker__trigger-label').textContent, 'since last commit');
  assert.equal(menu.children[0].classList.contains('is-selected'), true);
});

test('history changes and working edits preserve an off-log lock, file and open menu while rejecting stale responses', async () => {
  const f = fixture();
  const sha = 'abcdef1234567890';
  await openFile(f);
  await f.reply(f.fileCommitRequests[0], [{ sha, message: 'Base' }]);
  parent(f.toolbarEl.require('.commit-picker__item-sha')).click();
  await f.reply(f.requests[3], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  await f.reply(f.requests[4], { head: 'locked base', working: 'initial working' });
  const picker = f.toolbarEl.require('.commit-picker');
  const menu = picker.require('.commit-picker__menu');
  picker.require('.commit-picker__trigger').click();

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
    assert.equal(f.toolbarEl.require('.commit-picker'), picker);
    assert.equal(picker.require('.commit-picker__menu'), menu);
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(menu.children[0].classList.contains('is-selected'), false);
    assert.equal(picker.require('.commit-picker__trigger-title').textContent, 'abcdef1');
    assert.equal(picker.require('.commit-picker__trigger-label').textContent, 'locked');
  }
});

test('toolbar controls survive commit updates and reset on worktree change', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  const oldPicker = f.toolbarEl.require('.commit-picker');
  oldPicker.require('.commit-picker__trigger').click();
  await f.reply(f.requests[1], [{ sha: '12345678', message: 'commit', isOriginMain: true }]);
  assert.equal(f.toolbarEl.require('.commit-picker'), oldPicker);
  assert.equal(oldPicker.require('.commit-picker__trigger').className, 'commit-picker__trigger commit-picker__trigger--at');
  assert.equal(oldPicker.require('.commit-picker__menu').classList.contains('is-open'), true);
  f.tabsEl.children[1].click();
  assert.notEqual(f.toolbarEl.require('.commit-picker'), oldPicker);
  assert.equal(f.toolbarEl.require('.commit-picker__trigger-title').textContent, 'HEAD');
  assert.equal(f.toolbarEl.require('.commit-picker__trigger').className, 'commit-picker__trigger');
  assert.equal(f.toolbarEl.require('.commit-picker__trigger').title, '');
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
  parent(f.toolbarEl.require('.commit-picker__item-sha')).click();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].url, '/api/files?worktree=%2Fa&ref=12345678');
  assert.equal(f.toolbarEl.require('.commit-picker__trigger-title').textContent, 'base');
});

test('commit dropdown marks only commits that touched the open file, keeping all in order', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.require('.rail__file').click();
  await f.reply(f.fileCommitRequests[0], [
    { sha: '1111111aaa', message: 'touched', date: '2025-01-01', touchesFile: true },
    { sha: '2222222bbb', message: 'unrelated', date: '2025-01-01', touchesFile: false },
  ]);
  const items = f.toolbarEl.require('.commit-picker__menu').children.slice(1);
  assert.deepEqual(items.map((i) => i.classList.contains('commit-picker__item--touches-file')), [true, false]);
  assert.deepEqual(items.map((i) => i.require('.commit-picker__item-sha').textContent), ['1111111', '2222222']);
});

test('with no file open the commit dropdown applies no marking', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[1], [
    { sha: '1111111aaa', message: 'one', date: '2025-01-01' },
    { sha: '2222222bbb', message: 'two', date: '2025-01-01' },
  ]);
  const items = f.toolbarEl.require('.commit-picker__menu').children.slice(1);
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
  assert.deepEqual(rows.map((row) => row.require('.changed-files__path').textContent), ['a.txt', 'src/b.js']);
  assert.equal(rows[0].classList.contains('status-added'), true);
  assert.equal(rows[1].classList.contains('status-deleted'), true);

  rows[1].click();
  assert.equal(f.workspace.getState().activeFile, 'src/b.js');
});

test('renamed files show full old → new labels and titles in both rail views and open the destination', async () => {
  const f = fixture();
  f.treeExpansion.toggle('/repo', 'new dir');
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{
    type: 'dir', name: 'new dir', path: 'new dir', children: [
      { type: 'file', name: 'new -> name.js', path: 'new dir/new -> name.js', status: 'renamed', oldPath: 'old dir/old -> name.js', mtimeMs: 500 },
      { type: 'file', name: 'ordinary.js', path: 'new dir/ordinary.js', status: 'modified' },
    ],
  }]);
  const treeRows = f.railEl.require('.rail__tree').querySelectorAll('.rail__file');
  const changedRows = f.railEl.querySelectorAll('.changed-files__file');
  const label = 'old dir/old -> name.js → new dir/new -> name.js';
  assert.equal(treeRows[0].textContent, label);
  assert.equal(changedRows[0].require('.changed-files__path').textContent, label);
  assert.equal(changedRows[0].require('.changed-files__age').textContent, '500ms ago');
  for (const row of [treeRows[0], changedRows[0]]) {
    assert.equal(row.title, label);
    assert.equal(row.classList.contains('status-renamed'), true);
    row.click();
    assert.equal(f.workspace.getState().activeFile, 'new dir/new -> name.js');
  }
  assert.equal(f.requests[2].url, '/api/file-content?worktree=%2Frepo&file=new%20dir%2Fnew%20-%3E%20name.js&oldFile=old%20dir%2Fold%20-%3E%20name.js');
  assert.equal(treeRows[1].textContent, 'ordinary.js');
  assert.equal(treeRows[1].title, 'new dir/ordinary.js');
  assert.equal(changedRows[1].require('.changed-files__path').textContent, 'new dir/ordinary.js');
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
  assert.deepEqual(rows.map((row) => row.require('.changed-files__path').textContent),
    ['gone.txt', 'new.txt', 'src/edited.js', 'unknown.txt']);
  assert.equal(rows[0].querySelector('.changed-files__age'), null);
  assert.equal(rows[1].require('.changed-files__age').textContent, '200ms ago');
  assert.equal(rows[2].require('.changed-files__age').textContent, '500ms ago');
  assert.equal(rows[3].querySelector('.changed-files__age'), null);
  assert.equal(rows[2].require('.changed-files__age').title, `Last saved edit: ${new Date(500).toLocaleString()}`);
  rows[2].click();
  const selected = f.railEl.querySelectorAll('.changed-files__file')[2];
  assert.equal(selected.classList.contains('is-active'), true);
  f.ui.updateEditTimes(2000);
  assert.equal(f.railEl.querySelectorAll('.changed-files__file')[2], selected);
  assert.equal(selected.require('.changed-files__age').textContent, '1500ms ago');
  assert.equal(f.workspace.getState().activeFile, 'src/edited.js');
});

test('changed-files list stays visible with an empty state when nothing changed, the tree is empty, or loading failed', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'clean' }]);
  assert.equal(f.railEl.require('.changed-files__empty').textContent, 'No changed files');

  f.workspace.remoteChange([]);
  await f.reply(f.requests.at(-1), []);
  assert.equal(f.railEl.require('.rail__message').textContent, 'No files.');
  assert.equal(f.railEl.require('.changed-files__empty').textContent, 'No changed files');

  f.workspace.remoteChange([]);
  last(f.requests).resolve({ ok: false, status: 503 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(f.railEl.require('.rail__message').textContent, /^Failed to load files/);
  assert.equal(f.railEl.require('.changed-files__empty').textContent, 'No changed files');
});

test('changed-files list updates when a watcher event refetches the tree', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'clean' }]);
  assert.equal(f.railEl.querySelectorAll('.changed-files__file').length, 0);

  f.workspace.remoteChange(['a.txt']);
  await f.reply(f.requests.at(-1), [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  assert.deepEqual(f.railEl.querySelectorAll('.changed-files__file').map((row) => row.require('.changed-files__path').textContent), ['a.txt']);
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
  const rows = f.toolbarEl.require('.commit-picker__menu').children.slice(1);
  assert.deepEqual(rows.map((r) => r.classList.contains('commit-picker__divider') ? 'divider' : r.require('.commit-picker__item-sha').textContent),
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
  parent(f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[2]).click();
  const trigger = f.toolbarEl.require('.commit-picker__trigger');
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
  const trigger = f.toolbarEl.require('.commit-picker__trigger');
  parent(f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[1]).click();
  parent(f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[0]).click();
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
  const trigger = f.toolbarEl.require('.commit-picker__trigger');
  parent(f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[1]).click();
  parent(f.toolbarEl.querySelectorAll('.commit-picker__item-sha')[0]).click();
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
    const trigger = f.toolbarEl.require('.commit-picker__trigger');
    assert.equal(trigger.className, `commit-picker__trigger commit-picker__trigger--${expected}`);
    assert.equal(trigger.title, tooltip);
    parent(last(f.toolbarEl.querySelectorAll('.commit-picker__item-sha'))).click();
    assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--behind');
    f.toolbarEl.require('.commit-picker__menu').children[0].click();
    assert.equal(trigger.className, `commit-picker__trigger commit-picker__trigger--${expected}`);
    assert.equal(trigger.title, tooltip);
    assert.equal(trigger.require('.commit-picker__trigger-title').textContent, 'HEAD');
    assert.equal(trigger.require('.commit-picker__trigger-label').textContent, 'since last commit');
  }
});

test('missing selected commits, missing divergence markers and empty logs clear stale accents and tooltips', async () => {
  for (const [commits, expectedTitle] of [
    [[{ sha: 'other', message: 'Other history', isOriginMain: true }], 'base'],
    [[{ sha: 'base', message: 'No known divergence' }], 'No known divergence'],
    [[], 'base'],
  ]) {
    const f = fixture();
    f.commitLock.lockCommit('/repo', 'base');
    f.workspace.updateWorktrees([{ path: '/repo' }]);
    const trigger = f.toolbarEl.require('.commit-picker__trigger');
    assert.equal(trigger.className, 'commit-picker__trigger');
    assert.equal(trigger.title, '');
    await f.reply(f.requests[1], [{ sha: 'base', message: 'Divergence', isOriginMain: true }]);
    assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
    f.workspace.loadCommits();
    await f.reply(f.requests.at(-1), commits);
    assert.equal(f.toolbarEl.require('.commit-picker__trigger'), trigger);
    assert.equal(trigger.className, 'commit-picker__trigger');
    assert.equal(trigger.title, '');
    assert.equal(trigger.require('.commit-picker__trigger-title').textContent, expectedTitle);
    assert.equal(trigger.require('.commit-picker__trigger-label').textContent, 'locked');
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
  const picker = f.toolbarEl.require('.commit-picker');
  const trigger = picker.require('.commit-picker__trigger');
  const menu = picker.require('.commit-picker__menu');
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
    assert.equal(f.toolbarEl.require('.commit-picker'), picker);
    assert.equal(picker.require('.commit-picker__trigger'), trigger);
    assert.equal(picker.require('.commit-picker__menu'), menu);
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
  const trigger = f.toolbarEl.require('.commit-picker__trigger');
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
  f.workspace.loadCommits();
  last(f.requests).resolve({ ok: false, status: 503 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(trigger.className, 'commit-picker__trigger');
  assert.equal(trigger.title, '');
  assert.equal(trigger.require('.commit-picker__trigger-title').textContent, 'base');
  assert.equal(f.commitLock.getLockedCommit('/repo'), 'base');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__divider'), null);
  assert.equal(f.toolbarEl.require('.commit-picker__item--error').textContent,
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
  const trigger = f.toolbarEl.require('.commit-picker__trigger');
  assert.equal(trigger.className, 'commit-picker__trigger');
  assert.equal(trigger.title, '');
  await f.reply(f.requests[1], [{ sha: 'base', message: 'Divergence', isOriginMain: true }]);
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--at');
  f.workspace.updateWorktrees([{ path: '/repo', head: 'newest' }]);
  await f.reply(f.requests.at(-1), [
    { sha: 'newest', message: 'New HEAD' },
    { sha: 'base', message: 'Divergence', isOriginMain: true },
  ]);
  assert.equal(f.toolbarEl.require('.commit-picker__trigger'), trigger);
  assert.equal(trigger.className, 'commit-picker__trigger commit-picker__trigger--ahead');
  assert.equal(trigger.title, 'Selected commit is ahead of the origin/main divergence');
  f.workspace.loadCommits();
  await f.reply(f.requests.at(-1), []);
  assert.equal(trigger.className, 'commit-picker__trigger');
  assert.equal(trigger.title, '');
  assert.equal(trigger.require('.commit-picker__trigger-title').textContent, 'HEAD');
});

test('without an origin/main flag the commit dropdown shows no divider', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[1], [{ sha: '1111111aaa', message: 'one', date: '2025-01-01' }]);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__divider'), null);
  assert.equal(f.toolbarEl.require('.commit-picker__trigger').className, 'commit-picker__trigger');
  assert.equal(f.toolbarEl.require('.commit-picker__trigger').title, '');
});

async function openFile(f: ReturnType<typeof fixture>) {
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.require('.rail__file').click();
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
  const right = f.toolbarEl.require('.viewer__toolbar-right');
  const button = right.require('.help-button');
  assert.equal(right.children.at(-1), button);
  button.click();
  assert.deepEqual(f.navCalls, ['help']);
});

test('auto-scroll toggle reflects and flips the global preference', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  const auto = f.toolbarEl.require('.change-nav__auto');
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
  const pathLabel = f.toolbarEl.require('.viewer__path');
  const diffToggle = f.toolbarEl.require('.view-toggle--diff');
  assert.notEqual(pathLabel.hidden, true);

  await openFile(f);
  assert.equal(f.toolbarEl.require('.viewer__path'), pathLabel);
  assert.notEqual(pathLabel.hidden, true);
  assert.equal(pathLabel.require('.viewer__filename').textContent, 'a.txt');

  f.viewModeStore.setMode('file');
  f.ui.renderToolbar();
  assert.equal(f.toolbarEl.require('.view-toggle--diff'), diffToggle);
  assert.notEqual(diffToggle.hidden, true);
  assert.equal(diffToggle.classList.contains('is-concealed'), true);
});

test('a worktree tab flashes when its edit time advances, not on initial seeding', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  const [a, b] = f.tabsEl.children;
  f.ui.setEditTimes({ '/a': 500, '/b': 800 });
  assert.equal(a.classList.contains('is-flashing'), false);
  f.ui.setEditTimes({ '/a': 900, '/b': 800 });
  assert.equal(a.classList.contains('is-flashing'), true);
  assert.equal(b.classList.contains('is-flashing'), false);
});

test('a flashing tab keeps flashing after the tabs re-render', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  f.ui.setEditTimes({ '/a': 500 });
  f.ui.setEditTimes({ '/a': 900 });
  f.ui.renderTabs();
  assert.equal(f.tabsEl.children[0].classList.contains('is-flashing'), true);
});

test('folder expansion belongs to each worktree and survives a live tree refetch', async () => {
  const f = fixture();
  const tree = [{ type: 'dir', path: 'src', name: 'src', children: [
    { type: 'file', path: 'src/a.js', name: 'a.js', status: 'modified' },
  ] }];
  const treeRows = () => f.railEl.require('.rail__tree').querySelectorAll('.rail__file');
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  await f.reply(f.requests[0], tree);
  assert.equal(treeRows().length, 0);
  f.railEl.require('.rail__dir').click();
  assert.equal(treeRows().length, 1);
  f.workspace.remoteChange(['src/a.js']);
  await f.reply(last(f.requests), tree);
  assert.equal(treeRows().length, 1);
  f.tabsEl.children[1].click();
  await f.reply(f.requests.at(-2), tree);
  assert.equal(treeRows().length, 0, 'the other worktree starts collapsed');
  f.railEl.require('.rail__dir').click();
  f.railEl.require('.rail__dir').click();
  assert.equal(treeRows().length, 0);
  f.tabsEl.children[0].click();
  await f.reply(f.requests.at(-2), tree);
  assert.equal(treeRows().length, 1, 'the first worktree remembers its expansion');
});

test('deletion presentation retains controls, explains protection and sends the current path without a file', () => {
  const f = fixture();
  f.workspace.updateWorktrees(parseWorktrees([{ path: '/a', deletionReason: 'Main worktree cannot be deleted' }, { path: '/b' }]));
  const protectedButton = f.toolbarEl.require('.viewer__delete-worktree');
  assert.equal(protectedButton.disabled, true);
  assert.equal(protectedButton.title, 'Main worktree cannot be deleted');
  f.tabsEl.children[1].click();
  const button = f.toolbarEl.require('.viewer__delete-worktree');
  const status = f.toolbarEl.require('.viewer__deletion-status');
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'Delete this worktree and its local branch');
  assert.equal(status.role, 'status');
  assert.equal(status.hidden, true);
  button.click();
  assert.deepEqual(f.deleteCalls, ['/b']);
  f.ui.setDeletionState(true, 'Checking risks…');
  assert.equal(f.toolbarEl.require('.viewer__delete-worktree'), button);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Deleting…');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Checking risks…');
  f.ui.setDeletionState(false, 'Branch removal failed');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Delete worktree');
  assert.equal(status.textContent, 'Branch removal failed');
  f.ui.setDeletionState(false);
  assert.equal(status.hidden, true);
  assert.equal(status.textContent, '');
  f.workspace.updateWorktrees([]);
  assert.equal(f.toolbarEl.querySelector('.viewer__delete-worktree'), null);
  assert.equal(f.toolbarEl.hidden, false);
  assert.equal(f.toolbarEl.children.length, 1);
});

test('toolbar clicks change real mode and watch preferences, including the empty workspace', () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  const file = f.toolbarEl.require('.view-toggle--mode').querySelectorAll('.view-toggle__btn')[1];
  file.click();
  assert.equal(f.viewModeStore.getMode(), 'file');
  assert.equal(file.classList.contains('is-active'), true);
  assert.equal(createViewModeStore(f.storage).getMode(), 'file');
  f.toolbarEl.require('.view-toggle--diff').querySelectorAll('.view-toggle__btn')[1].click();
  assert.equal(f.toolbarEl.require('.view-toggle--diff').querySelectorAll('.view-toggle__btn')[1].classList.contains('is-active'), true);
  f.toolbarEl.require('.watch-ignore').click();
  assert.equal(f.watchPreferenceStore.isEnabled(), false);
  assert.equal(createWatchPreferenceStore(f.storage).isEnabled(), false);
  assert.equal(f.toolbarEl.require('.watch-ignore')['aria-pressed'], 'false');
  f.workspace.updateWorktrees([]);
  f.toolbarEl.require('.watch-ignore').click();
  assert.equal(f.watchPreferenceStore.isEnabled(), true);
});

test('tabs preserve branch fallbacks, native scroll affordances and flash completion', () => {
  const f = fixture();
  f.tabsEl.scrollWidth = 300;
  f.tabsEl.clientWidth = 100;
  f.workspace.updateWorktrees([{ path: '/a', bare: true }, { path: '/b', detached: true, head: 'abcdef123' }, { path: '/c' }]);
  assert.deepEqual(f.tabsEl.children.map((tab) => tab.require('.tabs__branch').textContent), ['(bare)', 'detached @ abcdef1', '(unknown)']);
  assert.equal(f.tabsWrapperEl.classList.contains('has-scroll-right'), true);
  f.tabsEl.scrollLeft = 200;
  f.tabsEl.events.scroll();
  assert.equal(f.tabsWrapperEl.classList.contains('has-scroll-left'), true);
  assert.equal(f.tabsWrapperEl.classList.contains('has-scroll-right'), false);
  f.tabsEl.scrollLeft = 0;
  f.windowListeners.get('resize')?.();
  assert.equal(f.tabsWrapperEl.classList.contains('has-scroll-left'), false);
  f.ui.setEditTimes({ '/a': 100 });
  f.ui.setEditTimes({ '/a': 200 });
  const tab = f.tabsEl.children[0];
  tab.events.animationend();
  assert.equal(tab.classList.contains('is-flashing'), false);
  f.ui.renderTabs();
  assert.equal(f.tabsEl.children[0].classList.contains('is-flashing'), false);
});

test('malformed resource JSON follows existing rail, comparison and retained-comment errors', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo' }]);
  await f.reply(f.commentRequests[0], { threads: [{ id: 'general', messages: [] }], warning: null });
  await f.reply(f.requests[0], [{ type: 'dir', path: 'src', name: 'src', children: [{ type: 'file', path: 42, name: 'bad', status: 'modified' }] }]);
  assert.equal(f.railEl.require('.rail__message').textContent, 'Failed to load files: Invalid file tree response');
  assert.equal(f.railEl.require('.changed-files__empty').textContent, 'No changed files');
  await f.reply(f.requests[1], [{ sha: 'base', isOriginMain: 'yes' }]);
  assert.equal(f.toolbarEl.require('.commit-picker__item--error').textContent, 'Failed to load commits: Invalid commits response');
  const refresh = f.workspace.loadComments();
  await f.reply(last(f.commentRequests), { threads: [{ id: 'bad', file: 'a.js', messages: [] }] });
  await refresh;
  assert.equal(f.workspace.getState().comments.warning, 'Failed to load comments: Invalid comments response');
  assert.equal(f.workspace.getState().comments.threads[0].id, 'general');
  assert.equal(f.railEl.require('.comment-index').querySelectorAll('.comment-index__button').length, 1);
});

test('unknown worktree JSON cannot turn malformed deletion reasons into trusted presentation', () => {
  for (const deletionReason of [42, false, {}, []]) {
    assert.throws(() => parseWorktrees([{ path: '/repo', deletionReason }]), /Invalid worktrees response/);
  }
  assert.deepEqual(parseWorktrees([{ path: '/repo', deletionReason: null }]), [{ path: '/repo', deletionReason: null }]);
});
