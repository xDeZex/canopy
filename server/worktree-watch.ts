// Detects changes to the repo's worktree list (`git worktree add`/`remove`,
// or a checkout that changes a worktree's branch/HEAD) by polling rather
// than watching a filesystem path.
//
// `git worktree add`/`remove` write to the main repo's `.git/worktrees/`
// administrative directory, not to any individual worktree's own working
// directory — that's outside what watcher.js's per-worktree chokidar
// instance ever sees, and it belongs to the *main* repo rather than any one
// worktree, so there's no single worktree path to hand chokidar the way
// `/api/watch` does. Watching `.git/worktrees/` directly would work, but
// finding it reliably means resolving the *common* git dir (`git
// rev-parse --git-common-dir`), which differs for a bare repo and for a
// worktree whose own `.git` is a file pointing elsewhere. Polling the same
// `git worktree list --porcelain` command the initial `/api/worktrees`
// response already uses avoids all of that: it's the one already-trusted
// source of truth, add/remove is an infrequent operator action so a short
// poll interval is cheap, and "did the list change" is a plain value
// comparison with no filesystem-event edge cases to get wrong.

import type { TimerOptions, TimerHandle } from './observation-port.js';

const DEFAULT_POLL_MS = 2000;

export interface PollOptions extends TimerOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

// Structural equality over two worktree-list snapshots (as returned by
// `parseWorktreeList`): same length, same worktrees in the same order, same
// fields on each. Order-sensitive because `git worktree list` itself is
// stable (main worktree first, then others in listing order), so a reorder
// would only happen alongside an actual add/remove, which this would catch
// anyway via the length/path change.
export function worktreeListsEqual(a: readonly object[], b: readonly object[]) {
  if (a.length !== b.length) return false;
  return a.every((worktree, i) => shallowEqual(worktree, b[i]));
}

function shallowEqual(a: object, b: object) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    const aValue: unknown = Reflect.get(a, key);
    const bValue: unknown = Reflect.get(b, key);
    return aValue === bValue;
  });
}

// Polls `getWorktrees()` (typically the same function `/api/worktrees` uses)
// at `intervalMs` and calls `onChange(worktrees)` with the new list whenever
// it differs from the previous poll — including once, immediately, for the
// first snapshot, so a caller that only wants "the current list plus live
// updates" (server/app.js's `/api/watch-worktrees` route) can rely on this
// alone rather than also needing a separate initial fetch.
//
// Each tick is scheduled only after the previous one's `getWorktrees()` call
// has settled (a self-rescheduling `setTimeout`, not `setInterval`), so a
// slow `git worktree list` invocation can never overlap with the next tick
// and race on `previous` — ticks are strictly sequential.
//
// A persistent `getWorktrees()` failure is logged and also handed to the
// optional `onError` callback, so a caller pushing this over a live channel
// (the SSE route) can tell a connected client the channel is unhealthy
// instead of going silent.
// `setTimer`/`clearTimer` default to the real timers and exist so tests can
// drive ticks by hand instead of sleeping.
export function pollWorktrees<Snapshot extends object>(getWorktrees: () => readonly Snapshot[] | Promise<readonly Snapshot[]>, onChange: (worktrees: readonly Snapshot[]) => void, { intervalMs = DEFAULT_POLL_MS, onError, setTimer = setTimeout, clearTimer = clearTimeout }: PollOptions = {}) {
  let previous: readonly Snapshot[] | null = null;
  let stopped = false;
  let timer: TimerHandle | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const current = await getWorktrees();
      if (stopped) return;
      if (previous === null || !worktreeListsEqual(previous, current)) {
        previous = current;
        onChange(current);
      }
    } catch (err) {
      console.error('canopy: worktree poll error', err);
      onError?.(err);
    }
    if (!stopped) {
      timer = setTimer(tick, intervalMs);
    }
  };

  tick();

  return {
    close() {
      stopped = true;
      clearTimer(timer);
    },
  };
}
