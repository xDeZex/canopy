// Owns the two SSE connections: one repo-wide worktree list (#12, opened once
// for the app's lifetime because the list is not scoped to a worktree) and one
// scoped to the active worktree (closed and reopened when the active path
// changes, matching the server's one-watcher-per-connection model). The
// workspace store owns selection and fetching.
export function createLiveUpdates({ workspace, treeExpansion, EventSource }) {
  let activeSource = null;
  let activePath = null;
  let worktreesSource = null;
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

  function dispose() {
    if (disposed) return;
    disposed = true;
    activeSource?.close();
    worktreesSource?.close();
    activeSource = null;
    worktreesSource = null;
  }

  return { connectActive, connectWorktrees, dispose };
}
