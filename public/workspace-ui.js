// DOM controls for the workspace: the tab bar, the file rail and the viewer
// toolbar (commit picker, Diff/File toggle #5, diff render modes #6, per
// worktree tree expansion #13, tab-bar scroll affordance #14). The editor and
// the initial-load error message in #main belong to the app coordinator.
export function createWorkspaceUI({
  tabsWrapperEl, tabsEl, railEl, toolbarEl, workspace, treeExpansion,
  viewModeStore, commitLock, computeTabScrollAffordance, formatRelativeTime,
  DIFF_RENDER_MODES, onViewModeChanged, onDiffRenderModeChanged, getDiffRenderMode,
  document, window,
}) {
  let toolbarPath = null;
  let toolbarCommits = null;
  let toolbarCommitsError = null;
  let toolbarLockedSha = null;

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

    const file = document.createElement('div');
    const { activeFile } = workspace.getState();
    file.className = `rail__file status-${node.status}${node.path === activeFile ? ' is-active' : ''}`;
    file.title = node.path;
    file.textContent = node.name;
    file.style.paddingLeft = `${depth * 12 + 10}px`;
    file.addEventListener('click', () => workspace.selectFile(node.path));
    return file;
  }

  function renderRail() {
    const { fileTree, fileTreeError } = workspace.getState();
    if (fileTreeError || fileTree.length === 0) {
      const message = document.createElement('p');
      message.className = 'empty rail__message';
      message.textContent = fileTreeError ? `Failed to load files: ${fileTreeError.message}` : 'No files.';
      railEl.replaceChildren(message);
      return;
    }
    railEl.replaceChildren(...fileTree.map((node) => renderNode(node, 0)));
  }

  // Re-fetch the tree regardless of whether a file is open; the selected
  // file's content also needs the new comparison base when one is open.
  function onCommitLockChanged() {
    workspace.loadFileTree();
    const { activeFile } = workspace.getState();
    renderToolbar();
    if (activeFile) workspace.loadFileContent();
  }

  function renderCommitMenuItem(commit, isSelected, menu, activePath) {
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
    timeEl.textContent = formatRelativeTime(commit.date);

    item.append(shaEl, messageEl, timeEl);
    item.addEventListener('click', () => {
      commitLock.lockCommit(activePath, commit.sha);
      menu.classList.remove('is-open');
      onCommitLockChanged();
    });
    return item;
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
    menu.replaceChildren(autoItem, ...commits.map((commit) => renderCommitMenuItem(commit, commit.sha === lockedSha, menu, activePath)));
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
    trigger.addEventListener('click', () => menu.classList.toggle('is-open'));
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

  function createToolbar() {
    const toolbar = document.createDocumentFragment();
    const pathLabel = document.createElement('span');
    pathLabel.className = 'viewer__path';
    const left = document.createElement('div');
    left.className = 'viewer__toolbar-left';
    left.append(pathLabel, renderCommitPicker());
    const toggle = document.createElement('div');
    toggle.className = 'view-toggle view-toggle--mode';
    toggle.append(renderToggleButton('diff', 'Diff'), renderToggleButton('file', 'File'));
    toolbar.append(left, toggle, renderDiffModeToggle());
    return toolbar;
  }

  // Keep the controls and open menu mounted across file and commit updates.
  // Only a worktree change replaces them.
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
        ? viewModeStore.getMode() : getDiffRenderMode();
      button.classList.toggle('is-active', button.dataset.mode === selected);
    });
    toolbarEl.querySelector('.view-toggle--diff').hidden = viewModeStore.getMode() !== 'diff';
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

  return { renderTabs, renderRail, renderToolbar, renderError };
}
