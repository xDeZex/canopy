import chokidar from 'chokidar';
import { pollWorktrees } from './worktree-watch.js';
import { createWatchPolicy, IGNORE_GIT_DIR } from './watch-policy.js';

// Legacy bookkeeping predicate; each live watcher uses its worktree policy.
export function activityIgnored(filePath) {
  return IGNORE_GIT_DIR.test(filePath);
}

// Seed from the newest existing file mtime during chokidar's initial scan.
// Subsequent add/change/unlink events are saved edits, including external edits.
export function watchActivity(worktreePath, onChange, {
  watch = chokidar.watch, now = Date.now, onError, ignoreGitignore = true, readFile, stat,
} = {}) {
  const ignored = createWatchPolicy(worktreePath, { ignoreGitignore, readFile, stat });
  let ready = false;
  let closed = false;
  let latest = null;
  let scanFailed = false;
  const watcher = watch(worktreePath, {
    cwd: worktreePath, ignored, ignoreInitial: false,
    alwaysStat: true, followSymlinks: false,
  });
  watcher.on('add', (filePath, stats) => {
    if (closed || ignored(filePath, stats)) return;
    if (ready) onChange(now());
    else if (!scanFailed && Number.isFinite(stats?.mtimeMs)) latest = Math.max(latest ?? -Infinity, stats.mtimeMs);
  });
  for (const event of ['change', 'unlink']) {
    watcher.on(event, (filePath, stats) => { if (!closed && !ignored(filePath, stats)) onChange(now()); });
  }
  watcher.once('ready', () => {
    if (closed) return;
    ready = true;
    if (!scanFailed && latest !== null) onChange(latest);
  });
  watcher.on('error', (err) => {
    if (closed) return;
    latest = null;
    if (!ready) scanFailed = true;
    console.error('canopy: activity watcher error', err);
    onError?.(err);
  });
  return { close() { closed = true; return watcher.close(); } };
}

// One shared list poll; each observation mode owns its timestamps and watchers.
// Clients with the same mode share observation, never timestamps across modes.
export function createActivityFeed(getWorktrees, { poll = pollWorktrees, watchActivity: watch = watchActivity } = {}) {
  const modes = new Map();
  let polling = null;
  let worktrees = null;

  function publish(mode) {
    for (const subscriber of mode.subscribers) subscriber(mode.timestamps);
  }

  function updateMode(mode, ignoreGitignore) {
    const { watchers } = mode;
    const paths = new Set(worktrees.filter((wt) => !wt.bare).map((wt) => wt.path));
    const next = Object.fromEntries([...paths].map((path) => [path, mode.timestamps[path] ?? null]));
    for (const [path, watcher] of watchers) {
      if (paths.has(path)) continue;
      watchers.delete(path);
      watcher.close();
    }
    mode.timestamps = next;
    publish(mode);
    for (const path of paths) {
      if (watchers.has(path)) continue;
      const watcher = watch(path, (time) => {
        if (!Object.hasOwn(mode.timestamps, path) || watchers.get(path) !== watcher) return;
        mode.timestamps = { ...mode.timestamps, [path]: Math.max(mode.timestamps[path] ?? -Infinity, time) };
        publish(mode);
      }, { ignoreGitignore, onError: () => {
        if (!Object.hasOwn(mode.timestamps, path) || watchers.get(path) !== watcher) return;
        mode.timestamps = { ...mode.timestamps, [path]: null };
        publish(mode);
      } });
      watchers.set(path, watcher);
    }
  }

  return {
    subscribe(callback, { ignoreGitignore = true } = {}) {
      if (!modes.has(ignoreGitignore)) modes.set(ignoreGitignore, {
        subscribers: new Set(), watchers: new Map(), timestamps: {},
      });
      const mode = modes.get(ignoreGitignore);
      const wasIdle = mode.subscribers.size === 0;
      mode.subscribers.add(callback);
      if (worktrees) {
        if (wasIdle) updateMode(mode, ignoreGitignore);
        else callback(mode.timestamps);
      }
      if (!polling) polling = poll(getWorktrees, (next) => {
        worktrees = next;
        for (const [filter, state] of modes) {
          if (state.subscribers.size) updateMode(state, filter);
        }
      }, {
        onError: (err) => console.error('canopy: activity worktree poll error', err),
      });
      return () => {
        mode.subscribers.delete(callback);
        if (mode.subscribers.size) return;
        const closing = [...mode.watchers.values()];
        mode.watchers.clear();
        for (const watcher of closing) watcher.close();
        if ([...modes.values()].some((state) => state.subscribers.size)) return;
        polling?.close();
        polling = null;
        // Preserve observed deletions across SSE reconnects; an initial scan
        // cannot recover the timestamp of a file that no longer exists.
        worktrees = null;
      };
    },
  };
}
