// Canopy client shell: fetches the repo's real worktrees and renders them
// as a tab bar, with a file rail (variant D's shape) showing the active
// worktree's real file tree and live git status. Clicking a tab switches
// the active worktree and re-fetches its file tree. No build step; loaded
// directly as an ES module by index.html.

const tabsEl = document.getElementById('tabs');
const railEl = document.getElementById('rail');
const mainEl = document.getElementById('main');

let worktrees = [];
let activePath = null;
let fileTree = [];
let fileTreeError = null;

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
  await loadFileTree();
}

async function loadFileTree() {
  if (!activePath) {
    fileTree = [];
    fileTreeError = null;
    renderRail();
    return;
  }

  try {
    const res = await fetch(`/api/files?worktree=${encodeURIComponent(activePath)}`);
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    fileTree = await res.json();
    fileTreeError = null;
  } catch (err) {
    fileTree = [];
    fileTreeError = err;
  }
  renderRail();
}

function selectWorktree(worktreePath) {
  if (worktreePath === activePath) return;
  activePath = worktreePath;
  render();
  loadFileTree();
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
  const active = worktrees.find((worktree) => worktree.path === activePath);
  const message = document.createElement('p');
  message.className = 'empty';
  message.textContent = active
    ? `Active worktree: ${branchLabel(active)} — ${active.path}`
    : 'No worktrees found.';
  mainEl.replaceChildren(message);
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
  file.className = `rail__file status-${node.status}`;
  file.style.paddingLeft = `${depth * 12 + 10}px`;
  file.title = node.path;
  file.textContent = node.name;
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
