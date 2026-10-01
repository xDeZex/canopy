import { changedFiles } from './changed-files.js';
import { renderCommentIndex } from './comments-view.js';

function commitDivergence(commits, lockedSha) {
  const originIndex = commits.findIndex((commit) => commit.isOriginMain);
  const selectedIndex = lockedSha ? commits.findIndex((commit) => commit.sha === lockedSha) : 0;
  if (originIndex < 0 || selectedIndex < 0) return null;
  if (selectedIndex === originIndex) return 'at';
  return selectedIndex > originIndex ? 'behind' : 'ahead';
}

// DOM controls for the workspace: the tab bar, the file rail and the viewer
// toolbar (commit picker, Diff/File toggle #5, diff render modes #6, per
// worktree tree expansion #13, tab-bar scroll affordance #14). The editor and
// the initial-load error message in #main belong to the app coordinator.
export function createWorkspaceUI({
  tabsWrapperEl, tabsEl, railEl, toolbarEl, workspace, treeExpansion,
  viewModeStore, autoScrollStore, commitLock, computeTabScrollAffordance, formatRelativeTime,
  formatEditTime, now = Date.now,
  DIFF_RENDER_MODES, onViewModeChanged, onDiffRenderModeChanged, getDiffRenderMode,
  onAutoScrollChanged, onNextChange, onPrevChange, onToggleHelp,
  getWrap, onWrapChanged,
  onDeleteWorktree,
  getIgnoreGitignore = () => true, onIgnoreGitignoreChanged,
  document, window,
}) {
  let toolbarPath = null;
  let toolbarCommits = null;
  let toolbarCommitsError = null;
  let toolbarLockedSha = null;
  let editTimes = {};
  let deletionBusy = false;
  let deletionMessage = '';
  let commentIndex = null;
  let commentsSnapshot = null;

  function refreshComments() {
    const { activePath, comments } = workspace.getState();
    const snapshot = JSON.stringify([activePath, comments]);
    if (snapshot === commentsSnapshot) return;
    commentsSnapshot = snapshot;
    const next = renderCommentIndex(document, comments ?? {}, {
      onSelectThread: (id) => workspace.selectThread(id),
      onGeneralComments: () => workspace.showGeneralComments(),
    });
    if (commentIndex) commentIndex.replaceChildren(...next.children);
    else commentIndex = next;
  }

  function updateCommitTimes(currentTime = now()) {
    const currentDate = new Date(currentTime);
    toolbarEl.querySelectorAll('.commit-picker__item-time').forEach((label) => {
      label.textContent = formatRelativeTime(label.dataset.date, currentDate);
    });
  }

  function updateEditTimes(currentTime = now()) {
    const { worktrees } = workspace.getState();
    tabsEl.querySelectorAll('.tabs__tab').forEach((tab, index) => {
      const timestamp = editTimes[worktrees[index]?.path];
      const label = tab.querySelector('.tabs__edit-time');
      label.textContent = formatEditTime(timestamp, currentTime);
      label.title = timestamp == null ? 'Last saved edit unknown' : `Last saved edit: ${new Date(timestamp).toLocaleString()}`;
    });
    railEl.querySelectorAll('.changed-files__age').forEach((label) => {
      label.textContent = formatEditTime(Number(label.dataset.mtimeMs), currentTime);
    });
    updateCommitTimes(currentTime);
  }

  function setEditTimes(timestamps) {
    editTimes = timestamps;
    updateEditTimes();
  }

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

  function branchLabel(worktree) {
    if (worktree.branch) return worktree.branch;
    if (worktree.bare) return '(bare)';
    if (worktree.detached) return `detached @ ${worktree.head?.slice(0, 7) ?? '?'}`;
    return '(unknown)';
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

        const editTime = document.createElement('span');
        editTime.className = 'tabs__edit-time';

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = `tabs__tab${isActive ? ' is-active' : ''}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(isActive));
        tab.append(branch, pathLabel, editTime);
        tab.addEventListener('click', () => workspace.selectWorktree(worktree.path));
        return tab;
      })
    );
    updateEditTimes();
    updateTabScrollAffordance();
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
      if (isExpanded) group.append(...node.children.map((child) => renderNode(child, depth + 1)));
      return group;
    }

    const file = renderFileRow(node, node.name, 'rail__file');
    file.style.paddingLeft = `${depth * 12 + 10}px`;
    return file;
  }

  function fileLabel(node, fallback) {
    return node.status === 'renamed' ? `${node.oldPath} → ${node.path}` : fallback;
  }

  // A clickable file row, shared by the tree and the changed-files list so
  // status colors, the active highlight and click-to-open stay identical.
  function renderFileRow(node, label, className) {
    const { activeFile } = workspace.getState();
    const row = document.createElement('div');
    row.className = `${className} status-${node.status}${node.path === activeFile ? ' is-active' : ''}`;
    row.title = fileLabel(node, node.path);
    row.textContent = fileLabel(node, label);
    row.addEventListener('click', () => workspace.selectFile(node.path));
    return row;
  }

  function renderChangedFiles() {
    const { fileTree } = workspace.getState();
    const section = document.createElement('div');
    section.className = 'changed-files';
    const heading = document.createElement('div');
    heading.className = 'changed-files__heading';
    heading.textContent = 'Changed files';
    const changed = changedFiles(fileTree);
    section.append(heading);
    if (changed.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'changed-files__empty';
      empty.textContent = 'No changed files';
      section.append(empty);
    } else {
      section.append(...changed.map((node) => {
        const row = renderFileRow(node, node.path, 'rail__file changed-files__file');
        const path = document.createElement('span');
        path.className = 'changed-files__path';
        path.textContent = fileLabel(node, node.path);
        row.replaceChildren(path);
        if (node.status !== 'deleted' && Number.isFinite(node.mtimeMs)) {
          const age = document.createElement('span');
          age.className = 'changed-files__age';
          age.dataset.mtimeMs = String(node.mtimeMs);
          age.textContent = formatEditTime(node.mtimeMs, now());
          age.title = `Last saved edit: ${new Date(node.mtimeMs).toLocaleString()}`;
          row.append(age);
        }
        return row;
      }));
    }
    return section;
  }

  // The changed-files list is always mounted below the tree, including when
  // the tree is empty or failed to load.
  function renderRail() {
    const { fileTree, fileTreeError } = workspace.getState();
    refreshComments();
    if (fileTreeError || fileTree.length === 0) {
      const message = document.createElement('p');
      message.className = 'empty rail__message';
      message.textContent = fileTreeError ? `Failed to load files: ${fileTreeError.message}` : 'No files.';
      const tree = document.createElement('div');
      tree.className = 'rail__tree';
      tree.append(message);
      railEl.replaceChildren(tree, renderChangedFiles(), commentIndex);
      return;
    }
    const tree = document.createElement('div');
    tree.className = 'rail__tree';
    tree.append(...fileTree.map((node) => renderNode(node, 0)));
    railEl.replaceChildren(tree, renderChangedFiles(), commentIndex);
  }

  // Re-fetch the tree regardless of whether a file is open; the selected
  // file's content also needs the new comparison base when one is open.
  function onCommitLockChanged() {
    workspace.loadFileTree();
    const { activeFile } = workspace.getState();
    renderToolbar();
    if (activeFile) workspace.loadFileContent();
  }

  function selectComparisonCommit(activePath, sha) {
    if (sha === null) commitLock.setAuto(activePath);
    else commitLock.lockCommit(activePath, sha);
    closeMenus();
    onCommitLockChanged();
  }

  function renderCommitMenuItem(commit, isSelected, activePath) {
    const item = document.createElement('div');
    item.className = [
      'commit-picker__item',
      isSelected && 'is-selected',
      commit.touchesFile && 'commit-picker__item--touches-file',
    ].filter(Boolean).join(' ');

    const shaEl = document.createElement('span');
    shaEl.className = 'commit-picker__item-sha';
    shaEl.textContent = commit.sha.slice(0, 7);

    const messageEl = document.createElement('span');
    messageEl.className = 'commit-picker__item-message';
    messageEl.textContent = commit.message;
    messageEl.title = commit.message;

    const timeEl = document.createElement('span');
    timeEl.className = 'commit-picker__item-time';
    timeEl.dataset.date = commit.date;
    timeEl.textContent = formatRelativeTime(commit.date, new Date(now()));

    item.append(shaEl, messageEl, timeEl);
    item.addEventListener('click', () => {
      selectComparisonCommit(activePath, commit.sha);
    });
    return item;
  }

  function updateCommitPicker(activePath, commits, commitsError) {
    const lockedSha = commitLock.getLockedCommit(activePath);
    if (toolbarCommits === commits && toolbarCommitsError === commitsError && toolbarLockedSha === lockedSha) return;
    toolbarCommits = commits;
    toolbarCommitsError = commitsError;
    toolbarLockedSha = lockedSha;
    const picker = toolbarEl.querySelector('.commit-picker');
    const trigger = picker.querySelector('.commit-picker__trigger');
    const divergence = commitDivergence(commits, lockedSha);
    trigger.className = `commit-picker__trigger${divergence ? ` commit-picker__trigger--${divergence}` : ''}`;
    trigger.title = divergence ? `Selected commit is ${divergence === 'ahead' ? 'ahead of' : divergence} the origin/main divergence` : '';
    picker.querySelector('.commit-picker__trigger-sha').textContent = lockedSha ? lockedSha.slice(0, 7) : 'HEAD';
    picker.querySelector('.commit-picker__trigger-label').textContent = lockedSha ? 'locked' : 'since last commit';
    const menu = picker.querySelector('.commit-picker__menu');
    const autoItem = document.createElement('div');
    autoItem.className = `commit-picker__item${lockedSha ? '' : ' is-selected'}`;
    autoItem.textContent = 'Auto (since last commit)';
    autoItem.addEventListener('click', () => {
      selectComparisonCommit(activePath, null);
    });
    const commitItems = commits.flatMap((commit) => {
      const item = renderCommitMenuItem(commit, commit.sha === lockedSha, activePath);
      if (!commit.isOriginMain) return [item];
      const divider = document.createElement('div');
      divider.className = 'commit-picker__divider';
      divider.textContent = 'origin/main';
      divider.title = 'origin/main';
      return [divider, item];
    });
    menu.replaceChildren(autoItem, ...commitItems);
    if (commitsError) {
      const message = document.createElement('div');
      message.className = 'commit-picker__item commit-picker__item--error';
      message.textContent = `Failed to load commits: ${commitsError.message}`;
      menu.append(message);
    }
  }

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
    trigger.addEventListener('click', () => {
      menu.classList.toggle('is-open');
      if (menu.classList.contains('is-open')) updateCommitTimes();
    });
    // The toolbar is replaced on worktree change, so drop the listener once detached.
    const closeOnOutsideClick = (event) => {
      if (!wrapper.isConnected) {
        document.removeEventListener('click', closeOnOutsideClick);
      } else if (!wrapper.contains(event.target)) {
        menu.classList.remove('is-open');
      }
    };
    document.addEventListener('click', closeOnOutsideClick);
    wrapper.append(trigger, menu);
    return wrapper;
  }

  function renderToggleButton(mode, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `view-toggle__btn${viewModeStore.getMode() === mode ? ' is-active' : ''}`;
    button.dataset.mode = mode;
    button.textContent = label;
    button.addEventListener('click', () => onViewModeChanged(mode));
    return button;
  }

  const DIFF_RENDER_MODE_LABELS = {
    inline: 'Inline',
    'side-by-side': 'Side-by-side',
    collapsed: 'Collapsed',
  };

  function renderDiffModeToggle() {
    const toggle = document.createElement('div');
    toggle.className = 'view-toggle view-toggle--diff';
    toggle.append(...DIFF_RENDER_MODES.map((mode) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `view-toggle__btn${getDiffRenderMode() === mode ? ' is-active' : ''}`;
      button.dataset.mode = mode;
      button.textContent = DIFF_RENDER_MODE_LABELS[mode];
      button.addEventListener('click', () => onDiffRenderModeChanged(mode));
      return button;
    }));
    return toggle;
  }

  function renderChangeNav() {
    const nav = document.createElement('div');
    nav.className = 'change-nav';
    const steps = document.createElement('div');
    steps.className = 'view-toggle change-nav__steps';
    for (const [label, glyph, onClick] of [['Previous change', '▲', onPrevChange], ['Next change', '▼', onNextChange]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'view-toggle__btn change-nav__step';
      button.textContent = glyph;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', onClick);
      steps.append(button);
    }
    const auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'change-nav__auto';
    auto.textContent = '⤓';
    auto.title = 'Auto-scroll to the first change when a diff opens';
    auto.setAttribute('aria-label', 'Auto-scroll to first change');
    auto.addEventListener('click', () => onAutoScrollChanged(!autoScrollStore.isEnabled()));
    nav.append(steps, auto);
    return nav;
  }

  function renderHelpButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'help-button';
    button.textContent = '?';
    button.title = 'Keyboard shortcuts';
    button.setAttribute('aria-label', 'Keyboard shortcuts');
    button.addEventListener('click', onToggleHelp);
    return button;
  }

  function renderWrapButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'view-toggle__btn viewer__wrap';
    button.textContent = 'Wrap';
    button.title = 'Wrap long lines';
    button.setAttribute('aria-pressed', String(getWrap()));
    button.addEventListener('click', onWrapChanged);
    return button;
  }

  function renderDeleteButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'viewer__delete-worktree';
    button.textContent = 'Delete worktree';
    button.addEventListener('click', () => onDeleteWorktree?.(workspace.getState().activePath));
    return button;
  }

  function renderIgnoreButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'view-toggle__btn watch-ignore';
    button.textContent = 'Ignore .gitignore paths';
    button.title = 'Exclude .gitignore paths from live file updates and saved edit times; files remain visible';
    button.classList.toggle('is-active', getIgnoreGitignore());
    button.setAttribute('aria-pressed', String(getIgnoreGitignore()));
    button.addEventListener('click', () => onIgnoreGitignoreChanged(!getIgnoreGitignore()));
    return button;
  }

  function createToolbar() {
    const toolbar = document.createDocumentFragment();
    const pathLabel = document.createElement('span');
    pathLabel.className = 'viewer__path';
    const directory = document.createElement('span');
    directory.className = 'viewer__directory';
    const filename = document.createElement('span');
    filename.className = 'viewer__filename';
    pathLabel.append(directory, filename);
    const left = document.createElement('div');
    left.className = 'viewer__toolbar-left';
    left.append(pathLabel, renderCommitPicker());
    const toggle = document.createElement('div');
    toggle.className = 'view-toggle view-toggle--mode';
    toggle.append(renderToggleButton('diff', 'Diff'), renderToggleButton('file', 'File'));
    const right = document.createElement('div');
    right.className = 'viewer__toolbar-right';
    const deletionStatus = document.createElement('span');
    deletionStatus.className = 'viewer__deletion-status';
    deletionStatus.setAttribute('role', 'status');
    right.append(renderChangeNav(), renderDiffModeToggle(), renderWrapButton(), renderIgnoreButton(), renderDeleteButton(), deletionStatus, renderHelpButton());
    toolbar.append(left, toggle, right);
    return toolbar;
  }

  // Keep the controls and open menu mounted across file and commit updates.
  // Only a worktree change replaces them.
  function renderToolbar() {
    const { activePath, activeFile, commits, commitsError, worktrees } = workspace.getState();
    toolbarEl.hidden = false;
    if (!activePath) {
      toolbarEl.replaceChildren(renderIgnoreButton());
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
    // Always mounted (never hidden) so selecting a file moves nothing.
    const path = activeFile ?? '';
    const separator = path.lastIndexOf('/');
    pathLabel.querySelector('.viewer__directory').textContent = path.slice(0, separator + 1);
    pathLabel.querySelector('.viewer__filename').textContent = path.slice(separator + 1);
    pathLabel.title = activeFile ?? '';

    updateCommitPicker(activePath, commits, commitsError);
    toolbarEl.querySelectorAll('.view-toggle__btn').forEach((button) => {
      const selected = button.parentElement.classList.contains('view-toggle--mode')
        ? viewModeStore.getMode() : getDiffRenderMode();
      button.classList.toggle('is-active', button.dataset.mode === selected);
    });
    const diffMode = viewModeStore.getMode() === 'diff';
    // Concealed, not removed, in File mode: the space stays reserved.
    toolbarEl.querySelector('.view-toggle--diff').classList.toggle('is-concealed', !diffMode);
    toolbarEl.querySelectorAll('.change-nav__step').forEach((button) => {
      button.disabled = !activeFile || !diffMode;
    });
    const auto = toolbarEl.querySelector('.change-nav__auto');
    auto.classList.toggle('is-on', autoScrollStore.isEnabled());
    auto.setAttribute('aria-pressed', String(autoScrollStore.isEnabled()));
    const wrapButton = toolbarEl.querySelector('.viewer__wrap');
    wrapButton.classList.toggle('is-active', getWrap());
    wrapButton.setAttribute('aria-pressed', String(getWrap()));
    const deleteButton = toolbarEl.querySelector('.viewer__delete-worktree');
    const reason = worktrees.find((worktree) => worktree.path === activePath)?.deletionReason;
    deleteButton.disabled = deletionBusy || Boolean(reason);
    deleteButton.title = reason || 'Delete this worktree and its local branch';
    deleteButton.textContent = deletionBusy ? 'Deleting…' : 'Delete worktree';
    const deletionStatus = toolbarEl.querySelector('.viewer__deletion-status');
    deletionStatus.textContent = deletionMessage;
    deletionStatus.hidden = !deletionMessage;
    const ignoreButton = toolbarEl.querySelector('.watch-ignore');
    ignoreButton.classList.toggle('is-active', getIgnoreGitignore());
    ignoreButton.setAttribute('aria-pressed', String(getIgnoreGitignore()));
  }

  function renderError(_err) {
    tabsEl.replaceChildren();
    railEl.replaceChildren();
    toolbarEl.hidden = true;
    toolbarEl.replaceChildren();
    toolbarPath = null;
    toolbarCommits = null;
    toolbarCommitsError = null;
    toolbarLockedSha = null;
  }

  function closeMenus() {
    toolbarEl.querySelector('.commit-picker__menu')?.classList.remove('is-open');
  }

  function setDeletionState(busy, message = '') {
    deletionBusy = busy;
    deletionMessage = message;
    renderToolbar();
  }

  return { renderTabs, renderRail, refreshComments, renderToolbar, renderError, closeMenus, selectComparisonCommit, setEditTimes, updateEditTimes, setDeletionState };
}
