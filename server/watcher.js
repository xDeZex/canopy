// Watches a single worktree's files on disk and reports changed paths (add/
// change/unlink), debounced and deduped, back to a callback. One watcher
// instance corresponds to one actively-watched worktree; callers own the
// lifecycle (start one, `close()` it before starting the next) — see
// server/app.js's `/api/watch` SSE route, which scopes exactly one watcher
// to the client's currently active worktree per the issue's MVP scope.

import chokidar from 'chokidar';

const DEFAULT_DEBOUNCE_MS = 150;

// Ignore git's own bookkeeping churn (.git/index, .git/HEAD, lock files,
// etc.), so routine git operations the app itself performs don't trigger a
// refresh — only real working-tree edits should.
export const IGNORE_GIT_DIR = /(^|[/\\])\.git([/\\]|$)/;

// `watch`, `setTimer` and `clearTimer` default to chokidar and the real
// timers; they exist so tests can drive events and time by hand.
export function watchWorktree(
  worktreePath,
  onChange,
  { debounceMs = DEFAULT_DEBOUNCE_MS, watch = chokidar.watch, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  const changedPaths = new Set();
  let timer = null;

  const flush = () => {
    timer = null;
    if (changedPaths.size === 0) return;
    const paths = [...changedPaths];
    changedPaths.clear();
    onChange(paths);
  };

  const schedule = (relativePath) => {
    changedPaths.add(relativePath);
    clearTimer(timer);
    timer = setTimer(flush, debounceMs);
  };

  const watcher = watch(worktreePath, {
    cwd: worktreePath,
    ignored: IGNORE_GIT_DIR,
    ignoreInitial: true,
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
      clearTimer(timer);
      return watcher.close();
    },
  };
}
