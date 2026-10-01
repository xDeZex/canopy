import { collectFiles } from './collect-files.js';
import { pickActiveWorktree } from './worktree-select.js';

// Owns workspace transitions and accepts only the latest response for each
// resource. EventSource and DOM rendering remain the caller's responsibility.
export function createWorkspaceStore({ viewModeStore, commitLock, fetch: request, onChange, onActivePathChanged }) {
  let worktrees = [];
  let activePath = null;
  let activeFile = null;
  let fileTree = [];
  let fileTreeError = null;
  let fileStatusByPath = new Map();
  let treeResolved = false;
  let fileContent = null;
  let fileContentError = null;
  let commits = [];
  let commitsError = null;
  let treeRequest = 0;
  let contentRequest = 0;
  let commitsRequest = 0;

  async function fetchJson(url) {
    const res = await request(url);
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    return res.json();
  }

  // Optional `&name=value` query fragment.
  function param(name, value) {
    return value ? `&${name}=${encodeURIComponent(value)}` : '';
  }

  function clearFile() {
    activeFile = null;
    fileContent = null;
    fileContentError = null;
    contentRequest++;
  }

  function switchWorktree(path) {
    if (path === activePath) return false;
    activePath = path;
    clearFile();
    // Invalidate outstanding requests even if a previous path is reselected.
    treeRequest++;
    commitsRequest++;
    fileTree = [];
    fileTreeError = null;
    fileStatusByPath = new Map();
    treeResolved = false;
    commits = [];
    commitsError = null;
    onActivePathChanged(path);
    onChange('render');
    onChange('rail');
    loadFileTree();
    loadCommits();
    return true;
  }

  async function loadFileTree() {
    const generation = ++treeRequest;
    const path = activePath;
    treeResolved = false;
    if (!path) {
      fileTree = [];
      fileTreeError = null;
      fileStatusByPath = new Map();
      treeResolved = true;
      onChange('rail');
      return;
    }
    const lockedSha = commitLock.getLockedCommit(path);
    try {
      const tree = await fetchJson(`/api/files?worktree=${encodeURIComponent(path)}${param('ref', lockedSha)}`);
      if (generation !== treeRequest) return;
      fileTree = tree;
      fileTreeError = null;
      fileStatusByPath = new Map(collectFiles(tree).map((node) => [node.path, node.status]));
    } catch (err) {
      if (generation !== treeRequest) return;
      fileTree = [];
      fileTreeError = err;
      fileStatusByPath = new Map();
    }
    treeResolved = true;
    onChange('rail');
    if (activeFile) {
      const previousMode = viewModeStore.getMode();
      // A missing file or failed tree has no status; default to Diff rather
      // than leaving the first choice pending indefinitely.
      viewModeStore.seed(fileStatusByPath.get(activeFile));
      if (viewModeStore.getMode() !== previousMode) {
        onChange('toolbar');
        onChange('main');
      }
    }
  }

  async function loadCommits() {
    const generation = ++commitsRequest;
    const path = activePath;
    const file = activeFile;
    if (!path) {
      commits = [];
      commitsError = null;
      return;
    }
    try {
      const result = await fetchJson(`/api/commits?worktree=${encodeURIComponent(path)}${param('file', file)}`);
      if (generation !== commitsRequest) return;
      commits = result;
      commitsError = null;
    } catch (err) {
      if (generation !== commitsRequest) return;
      commits = [];
      commitsError = err;
    }
    onChange('toolbar');
  }

  async function loadFileContent() {
    if (!activePath || !activeFile) return;
    const generation = ++contentRequest;
    const path = activePath;
    const file = activeFile;
    const lockedSha = commitLock.getLockedCommit(path);
    try {
      const content = await fetchJson(
        `/api/file-content?worktree=${encodeURIComponent(path)}${param('file', file)}${param('ref', lockedSha)}`
      );
      if (generation !== contentRequest) return;
      fileContent = content;
      fileContentError = null;
    } catch (err) {
      if (generation !== contentRequest) return;
      fileContent = null;
      fileContentError = err;
    }
    onChange('main');
  }

  return {
    viewModeStore,
    commitLock,
    getState() {
      return { worktrees, activePath, activeFile, fileTree, fileTreeError, fileContent,
        fileContentError, commits, commitsError };
    },
    updateWorktrees(nextWorktrees) {
      const previousHead = worktrees.find((worktree) => worktree.path === activePath)?.head;
      worktrees = nextWorktrees;
      const knownPaths = worktrees.map((worktree) => worktree.path);
      commitLock.pruneToKnownWorktrees(knownPaths);
      const nextPath = pickActiveWorktree(worktrees, activePath);
      if (!switchWorktree(nextPath)) {
        onChange('render');
        const nextHead = worktrees.find((worktree) => worktree.path === activePath)?.head;
        if (previousHead !== nextHead) {
          loadFileTree();
          loadCommits();
          loadFileContent();
        }
      }
      return knownPaths;
    },
    selectWorktree: switchWorktree,
    selectFile(file) {
      if (file === activeFile) return;
      activeFile = file;
      contentRequest++;
      if (treeResolved && file) viewModeStore.seed(fileStatusByPath.get(file));
      fileContent = null;
      fileContentError = null;
      // Marks belong to the previous file; drop them until this file's commits load.
      commits = commits.map(({ touchesFile, ...commit }) => commit);
      onChange('rail');
      onChange('toolbar');
      onChange('main');
      loadCommits();
      return loadFileContent();
    },
    remoteChange(paths) {
      loadFileTree();
      if (activeFile && paths.includes(activeFile)) loadFileContent();
    },
    loadFileTree,
    loadCommits,
    loadFileContent,
  };
}
