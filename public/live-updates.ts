// Owns the SSE connections: repo-wide worktree list and edit activity streams,
// plus a file stream scoped to the active worktree. The workspace store owns
// selection and fetching.
import { parseChangedPaths, parseWorktrees, parseActivity, parsePollError, isRecord, errorMessage } from './workspace-contracts.js';
import type { ActivitySnapshot } from './workspace-contracts.js';
import type { createWorkspaceStore } from './workspace-state.js';

export interface LiveEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  addEventListener(name: string, listener: (event: unknown) => void): void;
  close(): void;
}
export interface LiveUpdatesOptions {
  workspace: Pick<ReturnType<typeof createWorkspaceStore>, 'remoteChange' | 'invalidateStatus' | 'updateWorktrees'>;
  treeExpansion: { pruneToKnownWorktrees(paths: readonly (string | null)[]): unknown };
  EventSource: new (url: string) => LiveEventSource;
  onActivity(snapshot: ActivitySnapshot): void;
  ignoreGitignore?: boolean;
}

function readEvent<T>(event: unknown, parse: (value: unknown) => T, stream: string): T | undefined {
  try {
    if (!isRecord(event) || typeof event.data !== 'string') throw new Error('Missing event data');
    const value: unknown = JSON.parse(event.data);
    return parse(value);
  } catch (error) {
    console.error(`canopy: ${stream} live-update failed:`, errorMessage(error));
    return undefined;
  }
}

export function createLiveUpdates({ workspace, treeExpansion, EventSource, onActivity, ignoreGitignore = true }: LiveUpdatesOptions) {
  let activeSource: LiveEventSource | null = null;
  let activePath: string | null = null;
  let worktreesSource: LiveEventSource | null = null;
  let activitySource: LiveEventSource | null = null;
  let disposed = false;

  function connectActive(worktreePath: string | null) {
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
      const paths = readEvent(event, parseChangedPaths, 'file');
      if (paths !== undefined) workspace.remoteChange(paths);
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
      const worktrees = readEvent(event, parseWorktrees, 'worktree list');
      if (worktrees !== undefined) treeExpansion.pruneToKnownWorktrees(workspace.updateWorktrees(worktrees));
    };
    source.addEventListener('worktree-poll-error', (event) => {
      if (disposed || source !== worktreesSource) return;
      // The connection remains open and retries; surface polling failures.
      const message = readEvent(event, parsePollError, 'worktree list');
      if (message !== undefined) console.error('canopy: worktree list live-update failed:', message);
    });
  }

  function connectActivity() {
    if (disposed || activitySource) return;
    const source = new EventSource(`/api/watch-activity?ignoreGitignore=${ignoreGitignore}`);
    activitySource = source;
    source.onmessage = (event) => {
      if (disposed || source !== activitySource) return;
      const snapshot = readEvent(event, parseActivity, 'activity');
      if (snapshot !== undefined) onActivity(snapshot);
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

  function setIgnoreGitignore(enabled: boolean) {
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
