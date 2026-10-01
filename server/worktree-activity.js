import chokidar from 'chokidar';
import { pollWorktrees } from './worktree-watch.js';

// Git's administrative files aren't saved working-tree edits. Everything else,
// including generated and dependency files, can be edited and must be observed.
export function activityIgnored(filePath) {
  return /(^|[/\\])\.git([/\\]|$)/.test(filePath);
}

// Seed from the newest existing file mtime during chokidar's initial scan.
// Subsequent add/change/unlink events are saved edits, including external edits.
export function watchActivity(worktreePath, onChange, { watch = chokidar.watch, now = Date.now, onError } = {}) {
  let ready = false;
  let closed = false;
  let latest = null;
  let scanFailed = false;
  const watcher = watch(worktreePath, {
    cwd: worktreePath, ignored: activityIgnored, ignoreInitial: false,
    alwaysStat: true, followSymlinks: false,
  });
  watcher.on('add', (_path, stats) => {
    if (closed) return;
    if (ready) onChange(now());
    else if (!scanFailed && Number.isFinite(stats?.mtimeMs)) latest = Math.max(latest ?? -Infinity, stats.mtimeMs);
  });
  for (const event of ['change', 'unlink']) {
    watcher.on(event, () => { if (!closed) onChange(now()); });
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

// One shared poll and one watcher per known non-bare worktree, only while
// clients are connected. Each subscriber gets the current snapshot on joining.
export function createActivityFeed(getWorktrees, { poll = pollWorktrees, watchActivity: watch = watchActivity } = {}) {
  const subscribers = new Set();
  const watchers = new Map();
  let timestamps = {};
  let polling = null;
  let initialized = false;

  function publish() {
    for (const subscriber of subscribers) subscriber(timestamps);
  }

  function updateWorktrees(worktrees) {
    const paths = new Set(worktrees.filter((wt) => !wt.bare).map((wt) => wt.path));
    const next = Object.fromEntries([...paths].map((path) => [path, timestamps[path] ?? null]));
    for (const [path, watcher] of watchers) {
      if (paths.has(path)) continue;
      watcher.close();
      watchers.delete(path);
    }
    timestamps = next;
    initialized = true;
    publish();
    for (const path of paths) {
      if (watchers.has(path)) continue;
      const watcher = watch(path, (time) => {
        if (!Object.hasOwn(timestamps, path) || watchers.get(path) !== watcher) return;
        timestamps = { ...timestamps, [path]: Math.max(timestamps[path] ?? -Infinity, time) };
        publish();
      }, { onError: () => {
        if (!Object.hasOwn(timestamps, path) || watchers.get(path) !== watcher) return;
        timestamps = { ...timestamps, [path]: null };
        publish();
      } });
      watchers.set(path, watcher);
    }
  }

  return {
    subscribe(callback) {
      subscribers.add(callback);
      if (!polling) polling = poll(getWorktrees, updateWorktrees, {
        onError: (err) => console.error('canopy: activity worktree poll error', err),
      });
      if (initialized) callback(timestamps);
      return () => {
        subscribers.delete(callback);
        if (subscribers.size) return;
        polling.close();
        polling = null;
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear();
        // Preserve observed deletions across SSE reconnects; an initial scan
        // cannot recover the timestamp of a file that no longer exists.
        initialized = false;
      };
    },
  };
}
