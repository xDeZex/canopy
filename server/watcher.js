// Watches a single worktree's files on disk and reports changed paths (add/
// change/unlink), debounced and deduped, back to a callback. Index observation
// is optional and reports status invalidation through a separate callback.
// One instance corresponds to one actively-watched worktree; callers own the
// lifecycle (start one, `close()` it before starting the next) — see
// server/app.js's `/api/watch` SSE route, which scopes exactly one watcher
// to the client's currently active worktree per the issue's MVP scope.

import chokidar from 'chokidar';
import path from 'node:path';
import { runGit as defaultRunGit } from './git.js';
import { createWatchPolicy } from './watch-policy.js';
export { IGNORE_GIT_DIR } from './watch-policy.js';

const DEFAULT_DEBOUNCE_MS = 150;

// Keep bookkeeping out of file-edit notifications. The resolved index is
// observed separately: it invalidates status, not HEAD-versus-disk content.

// `watch`, `setTimer` and `clearTimer` default to chokidar and the real
// timers; they exist so tests can drive events and time by hand.
export function watchWorktree(
  worktreePath,
  onChange,
  { debounceMs = DEFAULT_DEBOUNCE_MS, watch = chokidar.watch, setTimer = setTimeout,
    clearTimer = clearTimeout, runGit = defaultRunGit, onStatusChange,
    ignoreGitignore = true, readFile, stat } = {},
) {
  const ignored = createWatchPolicy(worktreePath, { ignoreGitignore, readFile, stat });
  const changedPaths = new Set();
  let timer = null;
  let statusTimer = null;
  let indexWatcher = null;
  let closed = false;

  const flush = () => {
    timer = null;
    if (changedPaths.size === 0) return;
    const paths = [...changedPaths];
    changedPaths.clear();
    onChange(paths);
  };

  const schedule = (relativePath) => {
    if (closed || ignored(relativePath)) return;
    changedPaths.add(relativePath);
    clearTimer(timer);
    timer = setTimer(flush, debounceMs);
  };

  // Linked worktrees have their own index outside the worktree directory.
  // Watching the exact path also observes Git's atomic index replacement,
  // without reacting to another worktree's index or index.lock churn.
  if (onStatusChange) {
    (async () => {
      const indexPath = path.resolve(worktreePath,
        (await runGit(['rev-parse', '--git-path', 'index'], worktreePath)).trim());
      if (closed) return;
      indexWatcher = watch(indexPath, { ignoreInitial: true });
      const scheduleStatus = (changedPath) => {
        if (closed || path.resolve(changedPath) !== indexPath) return;
        clearTimer(statusTimer);
        statusTimer = setTimer(() => {
          statusTimer = null;
          if (!closed) onStatusChange();
        }, debounceMs);
      };
      for (const event of ['add', 'change', 'unlink']) indexWatcher.on(event, scheduleStatus);
      // The API tree may predate index resolution and the initial scan.
      // Reconcile once observation starts, including changes ignoreInitial
      // suppressed, without treating readiness as a working-file edit.
      indexWatcher.once('ready', () => {
        if (!closed) onStatusChange();
      });
      indexWatcher.on('error', (err) => console.error('canopy: index watcher error', err));
    })().catch((err) => {
      if (!closed) console.error('canopy: index watcher error', err);
    });
  }

  const watcher = watch(worktreePath, {
    cwd: worktreePath,
    ignored,
    ignoreInitial: true,
    followSymlinks: false,
  });

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);

  // Keep watcher errors (e.g. the worktree directory disappearing mid-watch)
  // from becoming an unhandled rejection / crashing the process: chokidar's
  // own EventEmitter would otherwise throw synchronously on an unhandled
  // 'error' event, and nothing upstream (server/app.js's SSE route) awaits
  // `ready` or otherwise observes this watcher's failures.
  watcher.on('error', (err) => {
    console.error('canopy: file watcher error', err);
  });

  const ready = new Promise((resolve, reject) => {
    watcher.once('ready', resolve);
    watcher.once('error', reject);
  });
  // A caller that never awaits `ready` (the SSE route doesn't) shouldn't
  // turn a watcher error into an unhandled promise rejection on top of the
  // logging above.
  ready.catch(() => {});

  return {
    // Resolves once the initial scan is complete and real filesystem
    // changes will start being reported. Exposed so tests can wait for it
    // instead of guessing timings; production callers don't need to.
    ready,
    close() {
      closed = true;
      clearTimer(timer);
      clearTimer(statusTimer);
      return Promise.all([watcher.close(), indexWatcher?.close()]);
    },
  };
}
