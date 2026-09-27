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

import { mountDiffEditor, mountEditor, languageForPath } from './monaco-view.js';
import { defaultViewMode } from './view-mode.js';
import { createCommitLockStore } from './commit-lock.js';
import { formatRelativeTime } from './relative-time.js';

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

const commitLock = createCommitLockStore(); // per-worktree locked sha, or Auto
let commits = []; // active worktree's commit history, newest first
let commitsError = null;

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
  await Promise.all([loadFileTree(), loadCommits()]);
}

async function loadFileTree() {
  if (!activePath) {
    fileTree = [];
    fileTreeError = null;
    fileStatusByPath = new Map();
    renderRail();
    return;
  }

  try {
    const res = await fetch(`/api/files?worktree=${encodeURIComponent(activePath)}`);
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    fileTree = await res.json();
    fileTreeError = null;
    fileStatusByPath = indexStatuses(fileTree);
  } catch (err) {
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
  try {
    const lockedSha = commitLock.getLockedCommit(activePath);
    const refParam = lockedSha ? `&ref=${encodeURIComponent(lockedSha)}` : '';
    const res = await fetch(
      `/api/file-content?worktree=${encodeURIComponent(activePath)}&file=${encodeURIComponent(activeFile)}${refParam}`
    );
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    fileContent = await res.json();
    fileContentError = null;
  } catch (err) {
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
    const label = document.createElement('div');
    label.className = 'rail__dir';
    label.style.paddingLeft = `${depth * 12 + 10}px`;
    label.textContent = node.name;

    const group = document.createElement('div');
    group.className = 'rail__group';
    group.append(label, ...node.children.map((child) => renderNode(child, depth + 1)));
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
