// Canopy client shell: fetches the repo's real worktrees and renders them
// as a tab bar, with a file rail (variant D's shape) showing the active
// worktree's real file tree and live git status. Clicking a tab switches
// the active worktree and re-fetches its file tree. Clicking a file fetches
// its HEAD/working content and renders it via Monaco, either as a full-file
// inline diff (Diff mode) or plain content (File mode), toggled per variant
// D's Diff/File toggle. A commit dropdown in the file toolbar (also variant
// D's shape) can lock the diff's comparison base to an older commit instead
// of HEAD, scoped per worktree (#5) — see commit-lock.js. No build step;
// loaded directly as an ES module by index.html. Monaco wiring itself
// (monaco-view.js) is thin third-party glue, left to manual/visual
// verification — see that file's header comment.
//
// Auto-update: an EventSource subscribes to the active worktree's
// `/api/watch` SSE stream (server/app.js + server/watcher.js). On a change
// event the file rail is always re-fetched; if the changed path is the
// currently open file, its content is re-fetched too and the diff/file view
// is remounted. Switching worktrees closes the old EventSource and opens a
// new one, matching the server scoping one watcher per connection. This
// wiring is thin DOM/EventSource glue with no automated test — left to
// manual verification (edit a tracked file on disk while the app is open;
// switch worktrees and confirm the old one stops updating).
//
// Worktree-list auto-update (#12): a second, separate EventSource subscribes
// to `/api/watch-worktrees` (server/app.js + server/worktree-watch.js), the
// worktree list's own live channel, opened once for the app's lifetime
// (unlike the per-worktree file-watch above, this isn't scoped to the active
// worktree). Each event carries the full current worktree list; the fallback
// choice of which worktree becomes active if the current one was removed is
// `pickActiveWorktree` (worktree-select.js), a pure, independently-tested
// function. The rest of this wiring (opening the EventSource, re-rendering)
// is thin glue left to manual verification.

import { mountDiffEditor, mountEditor, languageForPath } from './monaco-view.js';
import { defaultViewMode } from './view-mode.js';
import { createCommitLockStore } from './commit-lock.js';
import { formatRelativeTime } from './relative-time.js';
import { pickActiveWorktree } from './worktree-select.js';
import { createTreeExpansionStore } from './tree-state.js';

const tabsEl = document.getElementById('tabs');
const railEl = document.getElementById('rail');
const mainEl = document.getElementById('main');

let worktrees = [];
let activePath = null;
let fileTree = [];
let fileTreeError = null;
let fileStatusByPath = new Map();

let activeFile = null; // relative path of the selected file, or null
let viewMode = 'diff'; // 'diff' | 'file'
let fileContent = null; // { path, head, working } once loaded
let fileContentError = null;
let currentView = null; // Monaco controller for the mounted editor, or null
let watchSource = null; // EventSource subscribed to the active worktree's changes, or null

const commitLock = createCommitLockStore(); // per-worktree locked sha, or Auto
let commits = []; // active worktree's commit history, newest first
let commitsError = null;

const treeExpansion = createTreeExpansionStore(); // per-worktree expanded folder paths (#13)

async function init() {
  try {
    const res = await fetch('/api/worktrees');
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    worktrees = await res.json();
  } catch (err) {
    renderError(err);
    return;
  }

  activePath = worktrees[0]?.path ?? null;
  render();
  connectWatch(activePath);
  connectWorktreesWatch();
  await Promise.all([loadFileTree(), loadCommits()]);
}

// Opened once, for the app's lifetime: the worktree list is repo-wide, not
// scoped to the active worktree, so unlike connectWatch() this never needs
// to be re-opened when the active worktree changes.
function connectWorktreesWatch() {
  const worktreesWatchSource = new EventSource('/api/watch-worktrees');
  worktreesWatchSource.onmessage = (event) => {
    handleWorktreesChanged(JSON.parse(event.data));
  };
}

function handleWorktreesChanged(newWorktrees) {
  worktrees = newWorktrees;

  const nextActivePath = pickActiveWorktree(worktrees, activePath);
  if (nextActivePath !== activePath) {
    activePath = nextActivePath;
    clearSelectedFile();
    connectWatch(activePath);
    loadFileTree();
    loadCommits();
  }

  render();
}

// Scopes live-update watching to a single worktree at a time, matching the
// server's one-watcher-per-connection model: closes any previous stream
// before opening the new one, so switching worktrees re-scopes what's
// watched instead of accumulating open connections.
function connectWatch(worktreePath) {
  watchSource?.close();
  watchSource = null;
  if (!worktreePath) return;

  watchSource = new EventSource(`/api/watch?worktree=${encodeURIComponent(worktreePath)}`);
  watchSource.onmessage = (event) => {
    const { paths } = JSON.parse(event.data);
    handleRemoteChange(paths);
  };
}

function handleRemoteChange(paths) {
  loadFileTree();
  if (activeFile && paths.includes(activeFile)) {
    loadFileContent();
  }
}

async function loadFileTree() {
  if (!activePath) {
    fileTree = [];
    fileTreeError = null;
    fileStatusByPath = new Map();
    renderRail();
    return;
  }

  // A change-triggered reload (handleRemoteChange) can be in flight when the
  // user switches worktrees; without this guard its response could land
  // after the new worktree's own fetch and clobber the rail with stale data.
  const requestedPath = activePath;

  try {
    const res = await fetch(`/api/files?worktree=${encodeURIComponent(activePath)}`);
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    const tree = await res.json();
    if (requestedPath !== activePath) return;
    fileTree = tree;
    fileTreeError = null;
    fileStatusByPath = indexStatuses(fileTree);
  } catch (err) {
    if (requestedPath !== activePath) return;
    fileTree = [];
    fileTreeError = err;
    fileStatusByPath = new Map();
  }
  renderRail();
}

async function loadCommits() {
  if (!activePath) {
    commits = [];
    commitsError = null;
    return;
  }

  try {
    const res = await fetch(`/api/commits?worktree=${encodeURIComponent(activePath)}`);
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    commits = await res.json();
    commitsError = null;
  } catch (err) {
    commits = [];
    commitsError = err;
  }
  refreshToolbarIfVisible();
}

function indexStatuses(nodes, statusByPath = new Map()) {
  for (const node of nodes) {
    if (node.type === 'file') statusByPath.set(node.path, node.status);
    else indexStatuses(node.children, statusByPath);
  }
  return statusByPath;
}

function selectWorktree(worktreePath) {
  if (worktreePath === activePath) return;
  activePath = worktreePath;
  clearSelectedFile();
  connectWatch(activePath);
  render();
  loadFileTree();
  loadCommits();
}

function clearSelectedFile() {
  activeFile = null;
  fileContent = null;
  fileContentError = null;
  disposeCurrentView();
}

function disposeCurrentView() {
  currentView?.dispose();
  currentView = null;
}

async function selectFile(filePath) {
  if (filePath === activeFile) return;
  activeFile = filePath;
  viewMode = defaultViewMode(fileStatusByPath.get(filePath));
  fileContent = null;
  fileContentError = null;
  renderRail();
  renderMain();
  await loadFileContent();
}

function setViewMode(mode) {
  if (mode === viewMode || !activeFile) return;
  viewMode = mode;
  renderMain();
}

async function loadFileContent() {
  // A change-triggered reload (handleRemoteChange) can be in flight when the
  // user switches files or worktrees; without this guard its response could
  // land after the newly-selected file's own fetch and overwrite the viewer
  // with the wrong file's content.
  const requestedPath = activePath;
  const requestedFile = activeFile;

  try {
    const lockedSha = commitLock.getLockedCommit(activePath);
    const refParam = lockedSha ? `&ref=${encodeURIComponent(lockedSha)}` : '';
    const res = await fetch(
      `/api/file-content?worktree=${encodeURIComponent(activePath)}&file=${encodeURIComponent(activeFile)}${refParam}`
    );
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    const content = await res.json();
    if (requestedPath !== activePath || requestedFile !== activeFile) return;
    fileContent = content;
    fileContentError = null;
  } catch (err) {
    if (requestedPath !== activePath || requestedFile !== activeFile) return;
    fileContent = null;
    fileContentError = err;
  }
  renderMain();
}

// Re-fetches the current file's content against the (possibly just changed)
// lock state and re-renders. Called when the commit picker's selection
// changes; a no-op when no file is open, since there's nothing to refetch.
function onCommitLockChanged() {
  if (activeFile) loadFileContent();
}

function render() {
  renderTabs();
  renderMain();
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...worktrees.map((worktree) => {
      const isActive = worktree.path === activePath;

      const branch = document.createElement('span');
      branch.className = 'tabs__branch';
      branch.textContent = branchLabel(worktree);

      const pathLabel = document.createElement('span');
      pathLabel.className = 'tabs__path';
      pathLabel.textContent = worktree.path;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `tabs__tab${isActive ? ' is-active' : ''}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(isActive));
      tab.append(branch, pathLabel);
      tab.addEventListener('click', () => selectWorktree(worktree.path));

      return tab;
    })
  );
}

function renderMain() {
  if (!activeFile) {
    disposeCurrentView();
    mainEl.classList.remove('main--viewer');
    const active = worktrees.find((worktree) => worktree.path === activePath);
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = active ? 'Select a file to view its diff.' : 'No worktrees found.';
    mainEl.replaceChildren(message);
    return;
  }

  if (fileContentError) {
    disposeCurrentView();
    mainEl.classList.remove('main--viewer');
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = `Failed to load file: ${fileContentError.message}`;
    mainEl.replaceChildren(message);
    return;
  }

  if (!fileContent) {
    disposeCurrentView();
    mainEl.classList.remove('main--viewer');
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = 'Loading file…';
    mainEl.replaceChildren(message);
    return;
  }

  mainEl.classList.add('main--viewer');
  const editorContainer = document.createElement('div');
  editorContainer.className = 'viewer__editor';
  mainEl.replaceChildren(renderViewerToolbar(), editorContainer);

  mountViewer(editorContainer).catch((err) => {
    console.error('Failed to mount file viewer', err);
  });
}

function renderViewerToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'viewer__toolbar';

  const pathLabel = document.createElement('span');
  pathLabel.className = 'viewer__path';
  pathLabel.textContent = activeFile;
  pathLabel.title = activeFile;

  const toggle = document.createElement('div');
  toggle.className = 'view-toggle';
  toggle.append(renderToggleButton('diff', 'Diff'), renderToggleButton('file', 'File'));

  toolbar.append(pathLabel, renderCommitPicker(), toggle);
  return toolbar;
}

// Refreshes just the toolbar in place (e.g. once a slower-loading commit
// list arrives) without touching the mounted Monaco editor, which would
// otherwise be needlessly disposed and remounted by a full renderMain().
function refreshToolbarIfVisible() {
  if (!activeFile) return;
  const oldToolbar = mainEl.querySelector('.viewer__toolbar');
  if (!oldToolbar) return;
  oldToolbar.replaceWith(renderViewerToolbar());
}

// Commit picker (variant D's shape): a trigger showing the current lock
// state, opening a dropdown of the active worktree's commits plus "Auto".
// Picking an item locks/unlocks and re-fetches the open file's diff against
// the new base (#5). Menu open/close is plain DOM class toggling, not a
// re-render, so it doesn't disturb the mounted Monaco editor.
function renderCommitPicker() {
  const lockedSha = commitLock.getLockedCommit(activePath);
  const lockedCommit = commits.find((commit) => commit.sha === lockedSha) ?? null;

  const wrapper = document.createElement('div');
  wrapper.className = 'commit-picker';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'commit-picker__trigger';

  const shaEl = document.createElement('span');
  shaEl.className = 'commit-picker__trigger-sha';
  shaEl.textContent = lockedCommit ? lockedCommit.sha.slice(0, 7) : 'HEAD';

  const labelEl = document.createElement('span');
  labelEl.className = 'commit-picker__trigger-label';
  labelEl.textContent = lockedCommit ? 'locked' : 'since last commit';

  trigger.append(shaEl, labelEl);

  const menu = document.createElement('div');
  menu.className = 'commit-picker__menu';
  trigger.addEventListener('click', () => menu.classList.toggle('is-open'));

  const autoItem = document.createElement('div');
  autoItem.className = `commit-picker__item${lockedCommit ? '' : ' is-selected'}`;
  autoItem.textContent = 'Auto (since last commit)';
  autoItem.addEventListener('click', () => {
    commitLock.setAuto(activePath);
    menu.classList.remove('is-open');
    onCommitLockChanged();
  });

  menu.append(
    autoItem,
    ...commits.map((commit) => renderCommitMenuItem(commit, commit.sha === lockedSha, menu))
  );
  if (commitsError) {
    const message = document.createElement('div');
    message.className = 'commit-picker__item commit-picker__item--error';
    message.textContent = `Failed to load commits: ${commitsError.message}`;
    menu.append(message);
  }

  wrapper.append(trigger, menu);
  return wrapper;
}

function renderCommitMenuItem(commit, isSelected, menu) {
  const item = document.createElement('div');
  item.className = `commit-picker__item${isSelected ? ' is-selected' : ''}`;

  const shaEl = document.createElement('span');
  shaEl.className = 'commit-picker__item-sha';
  shaEl.textContent = commit.sha.slice(0, 7);

  const messageEl = document.createElement('span');
  messageEl.className = 'commit-picker__item-message';
  messageEl.textContent = commit.message;
  messageEl.title = commit.message;

  const timeEl = document.createElement('span');
  timeEl.className = 'commit-picker__item-time';
  timeEl.textContent = formatRelativeTime(commit.date);

  item.append(shaEl, messageEl, timeEl);
  item.addEventListener('click', () => {
    commitLock.lockCommit(activePath, commit.sha);
    menu.classList.remove('is-open');
    onCommitLockChanged();
  });
  return item;
}

function renderToggleButton(mode, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `view-toggle__btn${viewMode === mode ? ' is-active' : ''}`;
  button.textContent = label;
  button.addEventListener('click', () => setViewMode(mode));
  return button;
}

async function mountViewer(container) {
  disposeCurrentView();
  const language = languageForPath(activeFile);

  if (viewMode === 'file' && fileContent.working === null) {
    // Deleted on disk: there's nothing to show as "current content".
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = 'This file was deleted from the working tree.';
    container.replaceChildren(message);
    return;
  }

  currentView =
    viewMode === 'file'
      ? await mountEditor(container, { content: fileContent.working, language })
      : await mountDiffEditor(container, {
          original: fileContent.head ?? '',
          modified: fileContent.working ?? '',
          language,
        });
}

function renderRail() {
  if (fileTreeError) {
    const message = document.createElement('p');
    message.className = 'empty rail__message';
    message.textContent = `Failed to load files: ${fileTreeError.message}`;
    railEl.replaceChildren(message);
    return;
  }

  if (fileTree.length === 0) {
    const message = document.createElement('p');
    message.className = 'empty rail__message';
    message.textContent = 'No files.';
    railEl.replaceChildren(message);
    return;
  }

  railEl.replaceChildren(...fileTree.map((node) => renderNode(node, 0)));
}

function renderNode(node, depth) {
  if (node.type === 'dir') {
    const isExpanded = treeExpansion.isExpanded(activePath, node.path);

    const caret = document.createElement('span');
    caret.className = 'rail__caret';
    caret.textContent = isExpanded ? '▾' : '▸';

    const name = document.createElement('span');
    name.textContent = node.name;

    const label = document.createElement('div');
    label.className = 'rail__dir';
    label.style.paddingLeft = `${depth * 12 + 10}px`;
    label.append(caret, name);
    label.addEventListener('click', () => {
      treeExpansion.toggle(activePath, node.path);
      renderRail();
    });

    const group = document.createElement('div');
    group.className = 'rail__group';
    group.append(label);
    if (isExpanded) {
      group.append(...node.children.map((child) => renderNode(child, depth + 1)));
    }
    return group;
  }

  const file = document.createElement('div');
  const isActive = node.path === activeFile;
  file.className = `rail__file status-${node.status}${isActive ? ' is-active' : ''}`;
  file.style.paddingLeft = `${depth * 12 + 10}px`;
  file.title = node.path;
  file.textContent = node.name;
  file.addEventListener('click', () => selectFile(node.path));
  return file;
}

function branchLabel(worktree) {
  if (worktree.branch) return worktree.branch;
  if (worktree.bare) return '(bare)';
  if (worktree.detached) return `detached @ ${worktree.head?.slice(0, 7) ?? '?'}`;
  return '(unknown)';
}

function renderError(err) {
  const message = document.createElement('p');
  message.className = 'empty';
  message.textContent = `Failed to load worktrees: ${err.message}`;
  tabsEl.replaceChildren();
  railEl.replaceChildren();
  mainEl.replaceChildren(message);
}

init();
