// Owns the SSE connections: repo-wide worktree list and edit activity streams,
// plus a file stream scoped to the active worktree. The workspace store owns
// selection and fetching.
export function createLiveUpdates({ workspace, treeExpansion, EventSource, onActivity, ignoreGitignore = true }) {
  let activeSource = null;
  let activePath = null;
  let worktreesSource = null;
  let activitySource = null;
  let disposed = false;

  function connectActive(worktreePath) {
    if (disposed || worktreePath === activePath) return;
    const previous = activeSource;
    activeSource = null;
    activePath = worktreePath;
    previous?.close();
    if (!worktreePath) return;

    const source = new EventSource(`/api/watch?worktree=${encodeURIComponent(worktreePath)}&ignoreGitignore=${ignoreGitignore}`);
    activeSource = source;
    let opened = false;
    source.onopen = () => {
      if (disposed || source !== activeSource) return;
      // Initial selection already fetches these resources. Later opens may
      // follow missed file events, even when HEAD and selection are unchanged.
      if (opened) workspace.remoteChange();
      opened = true;
    };
    source.onmessage = (event) => {
      if (disposed || source !== activeSource) return;
      workspace.remoteChange(JSON.parse(event.data).paths);
    };
    source.addEventListener('status-invalidated', () => {
      if (disposed || source !== activeSource) return;
      workspace.invalidateStatus();
    });
  }

  function connectWorktrees() {
    if (disposed || worktreesSource) return;
    const source = new EventSource('/api/watch-worktrees');
    worktreesSource = source;
    source.onmessage = (event) => {
      if (disposed || source !== worktreesSource) return;
      treeExpansion.pruneToKnownWorktrees(workspace.updateWorktrees(JSON.parse(event.data)));
    };
    source.addEventListener('worktree-poll-error', (event) => {
      if (disposed || source !== worktreesSource) return;
      // The connection remains open and retries; surface polling failures.
      console.error('canopy: worktree list live-update failed:', JSON.parse(event.data).message);
    });
  }

  function connectActivity() {
    if (disposed || activitySource) return;
    const source = new EventSource(`/api/watch-activity?ignoreGitignore=${ignoreGitignore}`);
    activitySource = source;
    source.onmessage = (event) => {
      if (disposed || source !== activitySource) return;
      onActivity(JSON.parse(event.data));
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    activeSource?.close();
    worktreesSource?.close();
    activitySource?.close();
    activeSource = null;
    worktreesSource = null;
    activitySource = null;
  }

  function setIgnoreGitignore(enabled) {
    if (disposed || enabled === ignoreGitignore) return;
    ignoreGitignore = enabled;
    const path = activePath;
    const previousActive = activeSource;
    const previousActivity = activitySource;
    activeSource = null;
    activitySource = null;
    activePath = null;
    previousActive?.close();
    previousActivity?.close();
    onActivity({});
    connectActive(path);
    connectActivity();
    // Files ignored in the previous mode may have changed while unobserved.
    // Re-fetch, but never change their visibility or the current selection.
    if (path) workspace.remoteChange();
  }

  return { connectActive, connectWorktrees, connectActivity, setIgnoreGitignore, dispose };
}
