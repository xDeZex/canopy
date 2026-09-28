// Canopy client shell: fetches the repo's real worktrees and renders them
// as a tab bar, with a file rail (variant D's shape) showing the active
// worktree's real file tree and live git status. Clicking a tab switches
// the active worktree and re-fetches its file tree. Clicking a file fetches
// its HEAD/working content and renders it via Monaco, either as a full-file
// diff (Diff mode, itself switchable between inline/side-by-side/collapsed
// via the diff-mode toggle, #6) or plain content (File mode), toggled per
// variant D's Diff/File toggle. A commit dropdown in the worktree toolbar (also
// variant D's shape) can lock the diff's comparison base to an older commit
// instead of HEAD, scoped per worktree (#5) — see commit-lock.js. No build step;
// loaded directly as an ES module by index.html. Monaco wiring itself
// (monaco-view.js) is thin third-party glue, left to manual/visual
// verification — see that file's header comment.
//
// Auto-update: an EventSource subscribes to the active worktree's
// `/api/watch` SSE stream (server/app.js + server/watcher.js). On a change
// event the workspace store decides what to re-fetch (tested in
// workspace-state.test.js). Switching worktrees closes the old EventSource
// and opens a new one, matching the server scoping one watcher per connection.
// EventSource/Monaco wiring remains for manual verification (edit a tracked
// file on disk while the app is open; switch worktrees and confirm the old
// one stops updating).
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
//
// Tab bar scroll affordance (#14): with more worktrees than fit on screen,
// the tab bar scrolls (`overflow-x: auto`) but showed no hint that it does.
// `computeTabScrollAffordance` (tab-scroll.js) is a pure function of the tab
// bar's scroll geometry; this file just re-runs it on render/scroll/resize
// and toggles edge-fade classes on the wrapper (styles.css).

import { mountDiffEditor, mountEditor, languageForPath, DIFF_RENDER_MODES } from './monaco-view.js';
import { createViewModeStore } from './view-mode.js';
import { createCommitLockStore } from './commit-lock.js';
import { formatRelativeTime } from './relative-time.js';
import { createTreeExpansionStore } from './tree-state.js';
import { computeTabScrollAffordance } from './tab-scroll.js';
import { createWorkspaceStore } from './workspace-state.js';

const tabsWrapperEl = document.getElementById('tabs-wrapper');
const tabsEl = document.getElementById('tabs');
const railEl = document.getElementById('rail');
const toolbarEl = document.getElementById('toolbar');
const mainEl = document.getElementById('main');

let diffRenderMode = 'inline'; // one of DIFF_RENDER_MODES, Diff mode only (#6)
let currentView = null; // Monaco controller for the mounted editor, or null
let watchSource = null; // EventSource subscribed to the active worktree's changes, or null
let toolbarPath = null; // DOM controls belong to this worktree until it changes
let toolbarCommits = null;
let toolbarCommitsError = null;
let toolbarLockedSha = null;

const commitLock = createCommitLockStore(); // per-worktree locked sha, or Auto
const viewModeStore = createViewModeStore();
const workspace = createWorkspaceStore({
  viewModeStore,
  commitLock,
  fetch: (url) => fetch(url),
  onActivePathChanged: connectWatch,
  onChange: (part) => {
    if (part === 'render') render();
    if (part === 'rail') renderRail();
    if (part === 'main') renderMain();
    if (part === 'toolbar') renderToolbar();
  },
});

const treeExpansion = createTreeExpansionStore(); // per-worktree expanded folder paths (#13)

async function init() {
  let worktrees;
  try {
    const res = await fetch('/api/worktrees');
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    worktrees = await res.json();
  } catch (err) {
    renderError(err);
    return;
  }

  treeExpansion.pruneToKnownWorktrees(workspace.updateWorktrees(worktrees));
  connectWorktreesWatch();
}

// Opened once, for the app's lifetime: the worktree list is repo-wide, not
// scoped to the active worktree, so unlike connectWatch() this never needs
// to be re-opened when the active worktree changes.
function connectWorktreesWatch() {
  const worktreesWatchSource = new EventSource('/api/watch-worktrees');
  worktreesWatchSource.onmessage = (event) => {
    handleWorktreesChanged(JSON.parse(event.data));
  };
  worktreesWatchSource.addEventListener('worktree-poll-error', (event) => {
    // The poll behind this channel failed (e.g. `git` unavailable, a
    // corrupted repo) but the connection itself is still open and will keep
    // retrying; surfaced to the console rather than left silent, matching
    // the visibility the initial `/api/worktrees` fetch's error path has.
    console.error('canopy: worktree list live-update failed:', JSON.parse(event.data).message);
  });
}

function handleWorktreesChanged(newWorktrees) {
  treeExpansion.pruneToKnownWorktrees(workspace.updateWorktrees(newWorktrees));
}

// Scopes live-update watching to a single worktree at a time, matching the
// server's one-watcher-per-connection model: closes any previous stream
// before opening the new one, so switching worktrees re-scopes what's
// watched instead of accumulating open connections.
function connectWatch(worktreePath) {
  watchSource?.close();
  watchSource = null;
  if (!worktreePath) return;

  const source = new EventSource(`/api/watch?worktree=${encodeURIComponent(worktreePath)}`);
  watchSource = source;
  source.onmessage = (event) => {
    if (source !== watchSource) return;
    const { paths } = JSON.parse(event.data);
    workspace.remoteChange(paths);
  };
}

function disposeCurrentView() {
  currentView?.dispose();
  currentView = null;
}

function setViewMode(mode) {
  const { activeFile } = workspace.getState();
  if (mode === viewModeStore.getMode()) return;
  viewModeStore.setMode(mode);
  renderToolbar();
  if (activeFile) renderMain();
}

function setDiffRenderMode(mode) {
  if (mode === diffRenderMode) return;
  diffRenderMode = mode;
  renderToolbar();
  if (workspace.getState().activeFile) renderMain();
}

// Re-fetches the tree against the new lock state, even with no file open.
// Re-fetches the selected file's content too when one is open.
function onCommitLockChanged() {
  workspace.loadFileTree();
  const { activeFile } = workspace.getState();
  renderToolbar();
  if (activeFile) workspace.loadFileContent();
}

function render() {
  renderTabs();
  renderToolbar();
  renderMain();
}

function renderTabs() {
  const { worktrees, activePath } = workspace.getState();
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
      tab.addEventListener('click', () => workspace.selectWorktree(worktree.path));

      return tab;
    })
  );
  updateTabScrollAffordance();
}

// Toggles edge-fade classes on the tab bar's wrapper (#14) so a tab bar with
// more worktrees than fit on screen shows a visual hint that it scrolls,
// instead of relying on silent `overflow-x: auto`. The geometry math itself
// (computeTabScrollAffordance) is unit-tested; this is thin DOM glue around
// it, re-run on render, scroll, and viewport resize.
function updateTabScrollAffordance() {
  if (!tabsWrapperEl) return;
  const { showLeft, showRight } = computeTabScrollAffordance({
    scrollLeft: tabsEl.scrollLeft,
    scrollWidth: tabsEl.scrollWidth,
    clientWidth: tabsEl.clientWidth,
  });
  tabsWrapperEl.classList.toggle('has-scroll-left', showLeft);
  tabsWrapperEl.classList.toggle('has-scroll-right', showRight);
}

tabsEl.addEventListener('scroll', updateTabScrollAffordance);
window.addEventListener('resize', updateTabScrollAffordance);

function renderMain() {
  const { activeFile, worktrees, activePath, fileContent, fileContentError } = workspace.getState();
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
  mainEl.replaceChildren(editorContainer);

  mountViewer(editorContainer).catch((err) => {
    console.error('Failed to mount file viewer', err);
  });
}

// The controls and their open menu persist across file and commit-list updates.
// Only switching worktrees tears them down; the editor lives entirely in #main.
function renderToolbar() {
  const { activePath, activeFile, commits, commitsError } = workspace.getState();
  toolbarEl.hidden = !activePath;
  if (!activePath) {
    toolbarEl.replaceChildren();
    toolbarPath = null;
    toolbarCommits = null;
    return;
  }
  if (toolbarPath !== activePath) {
    toolbarPath = activePath;
    toolbarCommits = null;
    toolbarEl.replaceChildren(createToolbar());
  }
  const pathLabel = toolbarEl.querySelector('.viewer__path');
  pathLabel.hidden = !activeFile;
  pathLabel.textContent = activeFile ?? '';
  pathLabel.title = activeFile ?? '';

  updateCommitPicker(activePath, commits, commitsError);
  toolbarEl.querySelectorAll('.view-toggle__btn').forEach((button) => {
    const selected = button.parentElement.classList.contains('view-toggle--mode')
      ? viewModeStore.getMode() : diffRenderMode;
    button.classList.toggle('is-active', button.dataset.mode === selected);
  });
  toolbarEl.querySelector('.view-toggle--diff').hidden = viewModeStore.getMode() !== 'diff';
}

function updateCommitPicker(activePath, commits, commitsError) {
  const lockedSha = commitLock.getLockedCommit(activePath);
  if (toolbarCommits === commits && toolbarCommitsError === commitsError && toolbarLockedSha === lockedSha) return;
  toolbarCommits = commits;
  toolbarCommitsError = commitsError;
  toolbarLockedSha = lockedSha;
  const lockedCommit = commits.find((commit) => commit.sha === lockedSha) ?? null;
  const picker = toolbarEl.querySelector('.commit-picker');
  picker.querySelector('.commit-picker__trigger-sha').textContent = lockedCommit ? lockedCommit.sha.slice(0, 7) : 'HEAD';
  picker.querySelector('.commit-picker__trigger-label').textContent = lockedCommit ? 'locked' : 'since last commit';
  const menu = picker.querySelector('.commit-picker__menu');
  const autoItem = document.createElement('div');
  autoItem.className = `commit-picker__item${lockedCommit ? '' : ' is-selected'}`;
  autoItem.textContent = 'Auto (since last commit)';
  autoItem.addEventListener('click', () => {
    commitLock.setAuto(activePath);
    menu.classList.remove('is-open');
    onCommitLockChanged();
  });
  menu.replaceChildren(autoItem, ...commits.map((commit) => renderCommitMenuItem(commit, commit.sha === lockedSha, menu)));
  if (commitsError) {
    const message = document.createElement('div');
    message.className = 'commit-picker__item commit-picker__item--error';
    message.textContent = `Failed to load commits: ${commitsError.message}`;
    menu.append(message);
  }
}

function createToolbar() {
  const toolbar = document.createDocumentFragment();
  const pathLabel = document.createElement('span');
  pathLabel.className = 'viewer__path';

  const toggle = document.createElement('div');
  toggle.className = 'view-toggle view-toggle--mode';
  toggle.append(renderToggleButton('diff', 'Diff'), renderToggleButton('file', 'File'));

  toolbar.append(pathLabel, renderCommitPicker(), toggle, renderDiffModeToggle());
  return toolbar;
}

const DIFF_RENDER_MODE_LABELS = {
  inline: 'Inline',
  'side-by-side': 'Side-by-side',
  collapsed: 'Collapsed',
};

// Inline / side-by-side / collapsed toggle (#6), only meaningful in Diff
// mode since File mode has no diff to render.
function renderDiffModeToggle() {
  const toggle = document.createElement('div');
  toggle.className = 'view-toggle view-toggle--diff';
  toggle.append(
    ...DIFF_RENDER_MODES.map((mode) => renderDiffModeButton(mode, DIFF_RENDER_MODE_LABELS[mode]))
  );
  return toggle;
}

function renderDiffModeButton(mode, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `view-toggle__btn${diffRenderMode === mode ? ' is-active' : ''}`;
  button.dataset.mode = mode;
  button.textContent = label;
  button.addEventListener('click', () => setDiffRenderMode(mode));
  return button;
}

// Commit picker (variant D's shape): a trigger showing the current lock
// state, opening a dropdown of the active worktree's commits plus "Auto".
// Picking an item locks/unlocks and re-fetches the open file's diff against
// the new base (#5). Menu open/close is plain DOM class toggling, not a
// re-render, so it doesn't disturb the mounted Monaco editor.
function renderCommitPicker() {
  const wrapper = document.createElement('div');
  wrapper.className = 'commit-picker';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'commit-picker__trigger';

  const shaEl = document.createElement('span');
  shaEl.className = 'commit-picker__trigger-sha';

  const labelEl = document.createElement('span');
  labelEl.className = 'commit-picker__trigger-label';

  trigger.append(shaEl, labelEl);

  const menu = document.createElement('div');
  menu.className = 'commit-picker__menu';
  trigger.addEventListener('click', () => menu.classList.toggle('is-open'));

  wrapper.append(trigger, menu);
  return wrapper;
}

function renderCommitMenuItem(commit, isSelected, menu) {
  const { activePath } = workspace.getState();
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
  button.className = `view-toggle__btn${viewModeStore.getMode() === mode ? ' is-active' : ''}`;
  button.dataset.mode = mode;
  button.textContent = label;
  button.addEventListener('click', () => setViewMode(mode));
  return button;
}

async function mountViewer(container) {
  const { activeFile, fileContent } = workspace.getState();
  disposeCurrentView();
  const language = languageForPath(activeFile);

  if (viewModeStore.getMode() === 'file' && fileContent.working === null) {
    // Deleted on disk: there's nothing to show as "current content".
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = 'This file was deleted from the working tree.';
    container.replaceChildren(message);
    return;
  }

  currentView =
    viewModeStore.getMode() === 'file'
      ? await mountEditor(container, { content: fileContent.working, language })
      : await mountDiffEditor(container, {
          original: fileContent.head ?? '',
          modified: fileContent.working ?? '',
          language,
          mode: diffRenderMode,
        });
}

function renderRail() {
  const { fileTree, fileTreeError } = workspace.getState();
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
  const { activePath } = workspace.getState();
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

  const file = renderFileRow(node);
  file.style.paddingLeft = `${depth * 12 + 10}px`;
  return file;
}

function renderFileRow(node) {
  const { activeFile } = workspace.getState();
  const file = document.createElement('div');
  const isActive = node.path === activeFile;
  file.className = `rail__file status-${node.status}${isActive ? ' is-active' : ''}`;
  file.title = node.path;
  file.textContent = node.name;
  file.addEventListener('click', () => workspace.selectFile(node.path));
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
  toolbarEl.hidden = true;
  mainEl.replaceChildren(message);
}

init();
