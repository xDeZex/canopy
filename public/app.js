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
import { createCommitLockStore } from './commit-lock.js';
import { formatRelativeTime } from './relative-time.js';
import { createTreeExpansionStore } from './tree-state.js';
import { computeTabScrollAffordance } from './tab-scroll.js';
import { createWorkspaceStore } from './workspace-state.js';
import { shortcutAction } from './keyboard-shortcuts.js';
import { changedFiles } from './changed-files.js';

export async function startApp({
  document: doc = globalThis.document,
  window: browserWindow = globalThis.window,
  fetch: request = globalThis.fetch,
  EventSource: EventSourceClass = globalThis.EventSource,
  mountEditor: mountFileEditor = mountEditor,
  mountDiffEditor: mountDiff = mountDiffEditor,
  languageForPath: language = languageForPath,
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
  const viewModeStore = createViewModeStore(storage);
  const getWrap = () => wrap ?? (viewModeStore.getMode() === 'file' || diffRenderMode !== 'side-by-side');
  const autoScrollStore = createAutoScrollStore(storage);
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
      if (part === 'render') {
        ui.renderTabs();
        ui.renderToolbar();
        viewer.render();
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

  function onWrapChanged() {
    wrap = !getWrap();
    ui.renderToolbar();
    if (workspace.getState().activeFile) viewer.render();
  }

  function toggleHelp() {
    helpEl.hidden = !helpEl.hidden;
  }

  ui = createWorkspaceUI({
    tabsWrapperEl, tabsEl, railEl, toolbarEl, workspace, treeExpansion,
    viewModeStore, autoScrollStore, commitLock, computeTabScrollAffordance, formatRelativeTime,
    DIFF_RENDER_MODES, onViewModeChanged, onDiffRenderModeChanged,
    onAutoScrollChanged, onNextChange: () => viewer.nextChange(), onPrevChange: () => viewer.prevChange(),
    getWrap, onWrapChanged,
    onToggleHelp: toggleHelp,
    getDiffRenderMode: () => diffRenderMode,
    document: doc, window: browserWindow,
  });
  liveUpdates = createLiveUpdates({ workspace, treeExpansion, EventSource: EventSourceClass });

  function stepFile(direction) {
    const { fileTree, activeFile } = workspace.getState();
    const files = changedFiles(fileTree);
    if (!files.length) return;
    const current = files.findIndex((file) => file.path === activeFile);
    const next = current === -1 ? (direction === 1 ? 0 : files.length - 1)
      : (current + direction + files.length) % files.length;
    workspace.selectFile(files[next].path);
  }

  function onShortcut(action) {
    switch (action.type) {
      case 'next-change': return viewer.nextChange();
      case 'prev-change': return viewer.prevChange();
      case 'next-file': return stepFile(1);
      case 'prev-file': return stepFile(-1);
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
    doc.removeEventListener('keydown', onKeyDown);
    liveUpdates.dispose();
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
  liveUpdates.connectWorktrees();
  return { dispose };
}
