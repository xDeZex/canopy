import chokidar from 'chokidar';
import { pollWorktrees } from './worktree-watch.js';
import { createWatchPolicy, IGNORE_GIT_DIR } from './watch-policy.js';
import type { WatchPolicyOptions } from './watch-policy.js';
import type { Watch, Closable } from './observation-port.js';

export interface WatchActivityOptions extends WatchPolicyOptions {
  watch?: Watch;
  now?: () => number;
  onError?: (error: unknown) => void;
}
export interface ActivityWorktree { readonly path: string | null; readonly bare?: boolean; readonly branch?: string | null }
export type ActivitySnapshot = Readonly<Record<string, number | null>>;
type ActivityCallback = (snapshot: ActivitySnapshot) => void;
type GetWorktrees = () => readonly ActivityWorktree[] | Promise<readonly ActivityWorktree[]>;
export interface ActivityFeedOptions {
  poll?: (getWorktrees: GetWorktrees, onChange: (worktrees: readonly ActivityWorktree[]) => void,
    options: { onError: (error: unknown) => void }) => Closable;
  watchActivity?: (path: string | null, onChange: (time: number) => void,
    options: { ignoreGitignore: boolean; onError: (error: unknown) => void }) => Closable;
}
interface Mode {
  subscribers: Set<ActivityCallback>;
  watchers: Map<string | null, Closable>;
  timestamps: ActivitySnapshot;
}

// Legacy bookkeeping predicate; each live watcher uses its worktree policy.
export function activityIgnored(filePath: string) {
  return IGNORE_GIT_DIR.test(filePath);
}

// Seed from the newest existing file mtime during chokidar's initial scan.
// Subsequent add/change/unlink events are saved edits, including external edits.
export function watchActivity(worktreePath: string, onChange: (time: number) => void, {
  watch = chokidar.watch, now = Date.now, onError, ignoreGitignore = true, readFile, stat,
}: WatchActivityOptions = {}) {
  const ignored = createWatchPolicy(worktreePath, { ignoreGitignore, readFile, stat });
  let ready = false;
  let closed = false;
  let latest: number | null = null;
  let scanFailed = false;
  const watcher = watch(worktreePath, {
    cwd: worktreePath, ignored, ignoreInitial: false,
    alwaysStat: true, followSymlinks: false,
  });
  watcher.on('add', (filePath, stats) => {
    if (closed || ignored(filePath, stats)) return;
    if (ready) onChange(now());
    else if (!scanFailed && typeof stats?.mtimeMs === 'number' && Number.isFinite(stats.mtimeMs)) latest = Math.max(latest ?? -Infinity, stats.mtimeMs);
  });
  for (const event of ['change', 'unlink'] as const) {
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
// Porcelain preserves missing paths as null. Keep that shape at the feed seam;
// native filesystem observation still rejects it instead of inventing a path.
const defaultActivityWatch: NonNullable<ActivityFeedOptions['watchActivity']> = (path, onChange, options) => {
  if (path === null) throw new TypeError('Worktree path must be a string');
  return watchActivity(path, onChange, options);
};

export function createActivityFeed(getWorktrees: GetWorktrees, { poll = pollWorktrees, watchActivity: watch = defaultActivityWatch }: ActivityFeedOptions = {}) {
  const modes = new Map<boolean, Mode>();
  let polling: Closable | null = null;
  let worktrees: readonly ActivityWorktree[] | null = null;

  function publish(mode: Mode) {
    for (const subscriber of mode.subscribers) subscriber(mode.timestamps);
  }

  function updateMode(mode: Mode, ignoreGitignore: boolean) {
    const { watchers } = mode;
    const paths = new Set(worktrees?.filter((wt) => !wt.bare).map((wt) => wt.path));
    const next = Object.fromEntries([...paths].map((path) => [path, mode.timestamps[String(path)] ?? null]));
    for (const [path, watcher] of watchers) {
      if (paths.has(path)) continue;
      watchers.delete(path);
      watcher.close();
    }
    mode.timestamps = next;
    publish(mode);
    for (const path of paths) {
      if (watchers.has(path)) continue;
      const key = String(path);
      const watcher = watch(path, (time) => {
        if (!Object.hasOwn(mode.timestamps, key) || watchers.get(path) !== watcher) return;
        mode.timestamps = { ...mode.timestamps, [key]: Math.max(mode.timestamps[key] ?? -Infinity, time) };
        publish(mode);
      }, { ignoreGitignore, onError: () => {
        if (!Object.hasOwn(mode.timestamps, key) || watchers.get(path) !== watcher) return;
        mode.timestamps = { ...mode.timestamps, [key]: null };
        publish(mode);
      } });
      watchers.set(path, watcher);
    }
  }

  return {
    subscribe(callback: ActivityCallback, { ignoreGitignore = true }: { ignoreGitignore?: boolean } = {}) {
      let mode = modes.get(ignoreGitignore);
      if (!mode) {
        mode = { subscribers: new Set(), watchers: new Map(), timestamps: {} };
        modes.set(ignoreGitignore, mode);
      }
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
