// Browser entry coordinator, started by main.js and the only place the
// client's owners are wired together: the workspace store owns state and
// fetching, workspace-ui.js owns the DOM controls, live-updates.js owns the SSE
// connections and viewer.js owns the mounted editor. Every browser dependency
// is injected so the whole client can be exercised without a browser.
import { createViewer } from './viewer.js';
import { createLiveUpdates } from './live-updates.js';
import { createWorkspaceUI } from './workspace-ui.js';
import { mountDiffEditor, mountEditor, languageForPath, DIFF_RENDER_MODES } from './monaco-view.js';
import { createViewModeStore } from './view-mode.js';
import { createAutoScrollStore } from './auto-scroll.js';
import { createWatchPreferenceStore } from './watch-preference.js';
import { createCommitLockStore } from './commit-lock.js';
import { formatRelativeTime } from './relative-time.js';
import { formatEditTime } from './edit-time.js';
import { createTreeExpansionStore } from './tree-state.js';
import { computeTabScrollAffordance } from './tab-scroll.js';
import { createWorkspaceStore } from './workspace-state.js';
import { shortcutAction } from './keyboard-shortcuts.js';
import { changedFiles } from './changed-files.js';
import { createRailResizer } from './rail-resize.js';

export async function startApp({
  document: doc = globalThis.document,
  window: browserWindow = globalThis.window,
  fetch: request = globalThis.fetch,
  EventSource: EventSourceClass = globalThis.EventSource,
  mountEditor: mountFileEditor = mountEditor,
  mountDiffEditor: mountDiff = mountDiffEditor,
  languageForPath: language = languageForPath,
  now = Date.now,
  setInterval: schedule = globalThis.setInterval,
  clearInterval: cancel = globalThis.clearInterval,
} = {}) {
  const tabsWrapperEl = doc.getElementById('tabs-wrapper');
  const tabsEl = doc.getElementById('tabs');
  const railEl = doc.getElementById('rail');
  const toolbarEl = doc.getElementById('toolbar');
  const mainEl = doc.getElementById('main');
  const helpEl = doc.getElementById('shortcut-help');

  let diffRenderMode = 'inline';
  let wrap = null;
  // Defer access to localStorage: even reading the property may throw when
  // storage is blocked. The store already handles failed reads and writes.
  const storage = {
    getItem: (key) => browserWindow.localStorage.getItem(key),
    setItem: (key, value) => browserWindow.localStorage.setItem(key, value),
  };
  const railResizer = createRailResizer({
    bodyEl: doc.getElementById('body'), railEl,
    dividerEl: doc.getElementById('rail-divider'), window: browserWindow, storage,
  });
  const viewModeStore = createViewModeStore(storage);
  const getWrap = () => wrap ?? (viewModeStore.getMode() === 'file' || diffRenderMode !== 'side-by-side');
  const autoScrollStore = createAutoScrollStore(storage);
  const watchPreference = createWatchPreferenceStore(storage);
  const commitLock = createCommitLockStore();
  const treeExpansion = createTreeExpansionStore();
  let viewer;
  let ui;
  let liveUpdates;

  const workspace = createWorkspaceStore({
    viewModeStore,
    commitLock,
    fetch: (url) => request(url),
    onActivePathChanged: (path) => liveUpdates.connectActive(path),
    onChange: (part) => {
      if (part === 'render' || part === 'metadata') {
        ui.renderTabs();
        ui.renderToolbar();
        if (part === 'render') viewer.render();
      }
      if (part === 'rail') ui.renderRail();
      if (part === 'main') viewer.render();
      if (part === 'toolbar') ui.renderToolbar();
    },
  });

  viewer = createViewer({
    mainEl,
    document: doc,
    getState: () => workspace.getState(),
    getViewMode: () => viewModeStore.getMode(),
    getDiffRenderMode: () => diffRenderMode,
    mountEditor: mountFileEditor,
    mountDiffEditor: mountDiff,
    languageForPath: language,
    getAutoScroll: () => autoScrollStore.isEnabled(),
    getWrap,
  });

  function onViewModeChanged(mode) {
    if (mode === viewModeStore.getMode()) return;
    viewModeStore.setMode(mode);
    ui.renderToolbar();
    if (workspace.getState().activeFile) viewer.render();
  }

  function onDiffRenderModeChanged(mode) {
    if (mode === diffRenderMode) return;
    diffRenderMode = mode;
    ui.renderToolbar();
    if (workspace.getState().activeFile) viewer.render();
  }

  function onAutoScrollChanged(enabled) {
    autoScrollStore.setEnabled(enabled);
    ui.renderToolbar();
  }

  function onIgnoreGitignoreChanged(enabled) {
    watchPreference.setEnabled(enabled);
    liveUpdates.setIgnoreGitignore(enabled);
    ui.renderToolbar();
  }

  function onWrapChanged() {
    wrap = !getWrap();
    ui.renderToolbar();
    if (workspace.getState().activeFile) viewer.render();
  }

  function toggleHelp() {
    helpEl.hidden = !helpEl.hidden;
  }

  let deletionBusy = false;
  async function onDeleteWorktree(path) {
    if (!path || deletionBusy) return;
    deletionBusy = true;
    ui.setDeletionState(true);
    let message = '';
    let mutationAttempted = false;
    const url = `/api/worktree-deletion?worktree=${encodeURIComponent(path)}`;
    async function fetchJson(url, options) {
      const response = await request(url, options);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `request failed with status ${response.status}`);
      return body;
    }
    try {
      const preview = await fetchJson(url);
      if (preview.reason) throw new Error(preview.reason);
      if (preview.path !== path || !preview.confirmation) throw new Error('Invalid deletion preview; nothing was deleted');
      const warning = [
        `Delete worktree: ${path}`,
        preview.branch ? `Also DELETE local branch: ${preview.branch}` : 'Detached worktree: no local branch to delete.',
        `Uncommitted work: ${preview.hasUncommittedWork ? 'yes (staged, unstaged or untracked files)' : 'no'}`,
        `Ignored files: ${preview.ignoredFileCount}`,
        `Local-only commits: ${preview.localOnlyCommitCount}`,
        'Commit check uses locally known remote-tracking refs only; no fetch.',
        'This is irreversible: all worktree files (including ignored files), uncommitted work and local-only commits may be lost. Delete?',
      ].join('\n\n');
      if (!browserWindow.confirm(warning)) return;
      mutationAttempted = true;
      await fetchJson(url, { method: 'DELETE', headers: { 'X-Canopy-Confirmation': preview.confirmation } });
    } catch (err) {
      message = err.message;
    } finally {
      // Reconcile even on a partial failure or a lost response: removal and
      // branch deletion are not a transaction and cannot honestly roll back.
      if (mutationAttempted) {
        try {
          treeExpansion.pruneToKnownWorktrees(workspace.updateWorktrees(await fetchJson('/api/worktrees')));
        } catch (err) {
          message = `${message ? `${message}. ` : ''}Failed to refresh worktrees: ${err.message}`;
        }
      }
      deletionBusy = false;
      ui.setDeletionState(false, message);
    }
  }

  ui = createWorkspaceUI({
    tabsWrapperEl, tabsEl, railEl, toolbarEl, workspace, treeExpansion,
    viewModeStore, autoScrollStore, commitLock, computeTabScrollAffordance, formatRelativeTime, formatEditTime, now,
    DIFF_RENDER_MODES, onViewModeChanged, onDiffRenderModeChanged,
    onAutoScrollChanged, onNextChange: () => viewer.nextChange(), onPrevChange: () => viewer.prevChange(),
    getWrap, onWrapChanged,
    getIgnoreGitignore: () => watchPreference.isEnabled(), onIgnoreGitignoreChanged,
    onToggleHelp: toggleHelp,
    onDeleteWorktree,
    getDiffRenderMode: () => diffRenderMode,
    document: doc, window: browserWindow,
  });
  liveUpdates = createLiveUpdates({ workspace, treeExpansion, EventSource: EventSourceClass,
    ignoreGitignore: watchPreference.isEnabled(),
    onActivity: (timestamps) => ui.setEditTimes(timestamps) });
  let editTimer = null;

  function stepFile(direction) {
    const { fileTree, activeFile } = workspace.getState();
    const files = changedFiles(fileTree);
    if (!files.length) return;
    const current = files.findIndex((file) => file.path === activeFile);
    const next = current === -1 ? (direction === 1 ? 0 : files.length - 1)
      : (current + direction + files.length) % files.length;
    workspace.selectFile(files[next].path);
  }

  function stepCommit(direction) {
    const { activePath, commits } = workspace.getState();
    if (!activePath || !commits.length) return;
    const lockedSha = commitLock.getLockedCommit(activePath);
    // Auto is a separate stop above the newest locked commit, even at HEAD.
    const current = lockedSha === null ? -1 : commits.findIndex((commit) => commit.sha === lockedSha);
    if (lockedSha !== null && current === -1) return;
    const next = current + direction;
    if (next < -1 || next >= commits.length) return;
    ui.selectComparisonCommit(activePath, next === -1 ? null : commits[next].sha);
  }

  function onShortcut(action) {
    switch (action.type) {
      case 'next-change': return viewer.nextChange();
      case 'prev-change': return viewer.prevChange();
      case 'scroll-up': return viewer.scrollUp();
      case 'scroll-down': return viewer.scrollDown();
      case 'next-file': return stepFile(1);
      case 'prev-file': return stepFile(-1);
      case 'older-commit': return stepCommit(1);
      case 'newer-commit': return stepCommit(-1);
      case 'select-worktree': {
        const worktree = workspace.getState().worktrees[action.index];
        return worktree && workspace.selectWorktree(worktree.path);
      }
      case 'toggle-help': return toggleHelp();
      case 'close': helpEl.hidden = true; ui.closeMenus(); return;
    }
  }
  function onKeyDown(event) {
    const action = shortcutAction(event);
    if (!action) return;
    event.preventDefault();
    onShortcut(action);
  }
  helpEl.addEventListener('click', () => { helpEl.hidden = true; });
  doc.addEventListener('keydown', onKeyDown);
  const dispose = () => {
    railResizer.dispose();
    doc.removeEventListener('keydown', onKeyDown);
    liveUpdates.dispose();
    cancel(editTimer);
  };

  let worktrees;
  try {
    const res = await request('/api/worktrees');
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    worktrees = await res.json();
  } catch (err) {
    ui.renderError(err);
    const message = doc.createElement('p');
    message.className = 'empty';
    message.textContent = `Failed to load worktrees: ${err.message}`;
    mainEl.replaceChildren(message);
    return { dispose };
  }

  treeExpansion.pruneToKnownWorktrees(workspace.updateWorktrees(worktrees));
  if (!workspace.getState().activePath) {
    ui.renderTabs();
    ui.renderToolbar();
    viewer.render();
  }
  liveUpdates.connectWorktrees();
  liveUpdates.connectActivity();
  editTimer = schedule(() => ui.updateEditTimes(), 30_000);
  editTimer?.unref?.();
  return { dispose };
}
