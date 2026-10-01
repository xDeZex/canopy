// Owns the SSE connections: repo-wide worktree list and edit activity streams,
// plus a file stream scoped to the active worktree. The workspace store owns
// selection and fetching.
export function createLiveUpdates({ workspace, treeExpansion, EventSource, onActivity }) {
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

    const source = new EventSource(`/api/watch?worktree=${encodeURIComponent(worktreePath)}`);
    activeSource = source;
    source.onmessage = (event) => {
      if (disposed || source !== activeSource) return;
      workspace.remoteChange(JSON.parse(event.data).paths);
    };
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
    const source = new EventSource('/api/watch-activity');
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

  return { connectActive, connectWorktrees, connectActivity, dispose };
}
