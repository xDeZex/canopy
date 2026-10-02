import { collectFiles } from './collect-files.js';
import { pickActiveWorktree } from './worktree-select.js';
import { commentsAfterLoad } from './comments-after-load.js';

// Ref metadata belongs to the commit picker, not the tabs or mounted viewer.
function worktreeDetailsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((worktree, i) => {
    const keys = Object.keys(worktree).filter((key) => key !== 'originMainSha');
    const nextKeys = Object.keys(b[i]).filter((key) => key !== 'originMainSha');
    return keys.length === nextKeys.length && keys.every((key) => worktree[key] === b[i][key]);
  });
}

// Owns workspace transitions and accepts only the latest response for each
// resource. EventSource and DOM rendering remain the caller's responsibility.
export function createWorkspaceStore({ viewModeStore, commitLock, fetch: request, onChange, onActivePathChanged }) {
  let worktrees = [];
  let activePath = null;
  let activeFile = null;
  let fileTree = [];
  let fileTreeError = null;
  let fileInfoByPath = new Map();
  let treeResolved = false;
  let fileContent = null;
  let fileContentError = null;
  let commits = [];
  let commitsError = null;
  let treeRequest = 0;
  let contentRequest = 0;
  let commitsRequest = 0;
  let commentsRequest = 0;
  let comments = { threads: [], warning: null };
  let mainView = 'file';
  let selectedThreadId = null;
  let worktreeGeneration = 0;
  let commentsLoad = Promise.resolve();

  async function fetchJson(url) {
    const res = await request(url);
    if (!res.ok) throw new Error(`request failed with status ${res.status}`);
    return res.json();
  }

  // Optional `&name=value` query fragment.
  // The status and, for a renamed file, old path the tree gives each path.
  function indexFiles(files) {
    fileInfoByPath = new Map(files.map((node) => [node.path, { status: node.status, oldPath: node.oldPath }]));
  }

  function param(name, value) {
    return value ? `&${name}=${encodeURIComponent(value)}` : '';
  }

  function clearFile() {
    mainView = 'file';
    selectedThreadId = null;
    activeFile = null;
    fileContent = null;
    fileContentError = null;
    contentRequest++;
  }

  function switchWorktree(path) {
    if (path === activePath) return false;
    activePath = path;
    worktreeGeneration++;
    clearFile();
    // Invalidate outstanding requests even if a previous path is reselected.
    treeRequest++;
    commitsRequest++;
    commentsRequest++;
    comments = { threads: [], warning: null };
    fileTree = [];
    fileTreeError = null;
    indexFiles([]);
    treeResolved = false;
    commits = [];
    commitsError = null;
    onActivePathChanged(path);
    onChange('render');
    onChange('rail');
    loadFileTree();
    loadCommits();
    loadComments();
    return true;
  }

  async function loadFileTree({ statusOnly = false } = {}) {
    const generation = ++treeRequest;
    const path = activePath;
    if (!statusOnly) treeResolved = false;
    if (!path) {
      fileTree = [];
      fileTreeError = null;
      indexFiles([]);
      treeResolved = true;
      onChange('rail');
      return;
    }
    const lockedSha = commitLock.getLockedCommit(path);
    const openFile = activeFile;
    const previousOldPath = fileInfoByPath.get(openFile)?.oldPath;
    try {
      const tree = await fetchJson(`/api/files?worktree=${encodeURIComponent(path)}${param('ref', lockedSha)}`);
      if (generation !== treeRequest) return;
      fileTree = tree;
      fileTreeError = null;
      indexFiles(collectFiles(tree));
    } catch (err) {
      if (generation !== treeRequest) return;
      fileTree = [];
      fileTreeError = err;
      indexFiles([]);
    }
    treeResolved = true;
    onChange('rail');
    // The file's base side moves with its old path, so a pairing found after
    // it was opened needs its content read again.
    if (activeFile && activeFile === openFile && fileInfoByPath.get(activeFile)?.oldPath !== previousOldPath) loadFileContent();
    if (comments?.threads?.length) onChange('comments-refresh');
    if (activeFile && !statusOnly) {
      const previousMode = viewModeStore.getMode();
      // A missing file or failed tree has no status; default to Diff rather
      // than leaving the first choice pending indefinitely.
      viewModeStore.seed(fileInfoByPath.get(activeFile)?.status);
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
        `/api/file-content?worktree=${encodeURIComponent(path)}${param('file', file)}${param('oldFile', fileInfoByPath.get(file)?.oldPath)}${param('ref', lockedSha)}`
      );
      if (generation !== contentRequest) return;
      // Both API sides are strings or null. Identical content must not
      // remount the viewer and lose its scroll position or diff navigation.
      if (!fileContentError && fileContent &&
          fileContent.head === content.head && fileContent.working === content.working) return;
      fileContent = content;
      fileContentError = null;
    } catch (err) {
      if (generation !== contentRequest) return;
      fileContent = null;
      fileContentError = err;
    }
    onChange('main');
  }

  function loadComments() {
    commentsLoad = readComments();
    return commentsLoad;
  }

  async function readComments() {
    const generation = ++commentsRequest;
    const path = activePath;
    if (!path) return;
    let next;
    try {
      next = await fetchJson(`/api/comments?worktree=${encodeURIComponent(path)}`);
    } catch (err) {
      next = { threads: [], warning: `Failed to load comments: ${err.message}` };
    }
    if (generation !== commentsRequest) return;
    next = commentsAfterLoad(comments, next);
    if (JSON.stringify(next) === JSON.stringify(comments)) return;
    comments = next;
    const selected = (comments?.threads ?? []).find((thread) => thread.id === selectedThreadId);
    if (!selected) selectedThreadId = null;
    else if (!Object.hasOwn(selected, 'file')) return showGeneralComments();
    else if (selected.file !== activeFile) return selectFile(selected.file, selected.id);
    onChange('comments-refresh');
  }

  // Saves one new thread (a single line, or through `endLine`) against the
  // revision this client has seen. Rejections carry the server's message; the
  // latest comments are reloaded either way so a conflict shows what changed.
  async function addComment({ file, line, endLine, text }) {
    return saveComment({ file, line, endLine, text });
  }

  async function addReply({ threadId, text, worktree = activePath }) {
    if (worktree !== activePath) throw new Error('The active worktree changed; return to this conversation to retry');
    return saveComment({ threadId, text }, { waitForRefresh: true });
  }

  async function setThreadResolved({ threadId, resolved, worktree = activePath }) {
    if (worktree !== activePath) throw new Error('The active worktree changed; return to this conversation to retry');
    return saveComment({ action: 'set-resolved', threadId, resolved }, { waitForRefresh: true });
  }

  async function saveComment(input, { waitForRefresh = false } = {}) {
    const path = activePath;
    const generation = worktreeGeneration;
    const revision = comments?.revision;
    if (comments?.warning) throw new Error(`Cannot save while comments cannot be read: ${comments.warning}`);
    if (!path || typeof revision !== 'string') throw new Error('Comments are still loading; try again in a moment');
    let res;
    try {
      res = await request(`/api/comments?worktree=${encodeURIComponent(path)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, revision }),
      });
    } catch (err) {
      throw new Error(`Could not save comment: ${err.message}`);
    }
    const body = !res.ok ? await res.json().catch(() => ({})) : null;
    if (waitForRefresh && generation !== worktreeGeneration) {
      if (res.ok) return; // The old worktree's draft was saved; do not invite a duplicate retry.
      throw new Error('The active worktree changed; return to this conversation to retry');
    }
    if (generation === worktreeGeneration) {
      const refresh = loadComments();
      if (waitForRefresh) {
        // A watcher may supersede our read. Wait for that newer read too,
        // rather than enabling retry against a revision not yet displayed.
        let pending = refresh;
        do {
          await pending;
          if (generation !== worktreeGeneration) {
            if (res.ok) return; // Navigation cannot turn a confirmed save into a retry.
            throw new Error('The active worktree changed; return to this conversation to retry');
          }
          if (pending === commentsLoad) break;
          pending = commentsLoad;
        } while (true);
      }
    }
    if (!res.ok) throw new Error(body.error || `request failed with status ${res.status}`);
    // A successful POST is not retried when its refresh fails: that would
    // duplicate the reply. The retained conversation shows the read warning.
  }

  function showGeneralComments() {
    mainView = 'general';
    selectedThreadId = null;
    onChange('comments');
  }

  function selectFile(file, threadId = null) {
    const returningToFile = mainView !== 'file' || selectedThreadId !== null;
    mainView = 'file';
    selectedThreadId = threadId;
    if (file === activeFile) {
      if (returningToFile || threadId) onChange('comments');
      return;
    }
    activeFile = file;
    contentRequest++;
    if (treeResolved && file) viewModeStore.seed(fileInfoByPath.get(file)?.status);
    fileContent = null;
    fileContentError = null;
    // Marks belong to the previous file; drop them until this file's commits load.
    commits = commits.map(({ touchesFile, ...commit }) => commit);
    onChange('rail');
    onChange('toolbar');
    onChange('main');
    loadCommits();
    return loadFileContent();
  }

  return {
    viewModeStore,
    commitLock,
    getState() {
      return { worktrees, activePath, activeFile, fileTree, fileTreeError, fileContent,
        fileContentError, commits, commitsError, comments, mainView, selectedThreadId };
    },
    updateWorktrees(nextWorktrees) {
      const previousActive = worktrees.find((worktree) => worktree.path === activePath);
      const previousHead = previousActive?.head;
      const previousOrigin = previousActive?.originMainSha;
      const detailsChanged = !worktreeDetailsEqual(worktrees, nextWorktrees);
      worktrees = nextWorktrees;
      const knownPaths = worktrees.map((worktree) => worktree.path);
      commitLock.pruneToKnownWorktrees(knownPaths);
      const nextPath = pickActiveWorktree(worktrees, activePath);
      if (!switchWorktree(nextPath)) {
        const nextActive = worktrees.find((worktree) => worktree.path === activePath);
        const nextHead = nextActive?.head;
        const originChanged = previousOrigin !== nextActive?.originMainSha;
        // Tabs and controls need metadata, but the mounted viewer does not.
        if (detailsChanged) onChange('metadata');
        if (previousHead !== nextHead) {
          loadFileTree();
          loadCommits();
          loadFileContent();
        } else if (originChanged) {
          loadCommits();
        }
      }
      return knownPaths;
    },
    selectWorktree: switchWorktree,
    selectFile,
    selectThread(id) {
      const thread = comments.threads.find((thread) => thread.id === id);
      if (!thread) return;
      if (!Object.hasOwn(thread, 'file')) return showGeneralComments();
      return selectFile(thread.file, id);
    },
    showGeneralComments,
    addComment,
    addReply,
    setThreadResolved,
    // A reconnect has no paths: reconcile the tree and any selected content.
    remoteChange(paths = null) {
      loadFileTree();
      // Any file event can change an anchor's availability; reconnects also
      // reconcile ignored sidecars that the filesystem watcher did not see.
      loadComments();
      if (activeFile && (paths === null || paths.includes(activeFile))) loadFileContent();
    },
    // Index changes affect API statuses, not the selected comparison or its
    // controls. Reuse the tree request guard without seeding/remounting it.
    invalidateStatus() {
      return loadFileTree({ statusOnly: true });
    },
    loadFileTree,
    loadCommits,
    loadFileContent,
    loadComments,
  };
}
