// Canopy client shell: fetches the repo's real worktrees and renders them
// as a tab bar. Clicking a tab sets it as the active worktree. No build
// step; loaded directly as an ES module by index.html.

const tabsEl = document.getElementById('tabs');
const mainEl = document.getElementById('main');

let worktrees = [];
let activePath = null;

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
}

function selectWorktree(worktreePath) {
  activePath = worktreePath;
  render();
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
  mainEl.replaceChildren(message);
}

init();
