import { EventEmitter } from 'node:events';
import type { ObservationOptions } from '../../server/observation-port.js';
import type { WatchStats } from '../../server/watch-policy.js';

// EventEmitter delivery is simulated; this does not emulate filesystem scans.
export class FakeWatcher extends EventEmitter {
  closed = false;
  private watched: { path: string; chokidarOptions: ObservationOptions } | undefined;
  get watchedWith() {
    if (!this.watched) throw new Error('Watcher has not started');
    return this.watched;
  }
  set watchedWith(value: { path: string; chokidarOptions: ObservationOptions }) { this.watched = value; }
  emit(event: 'add' | 'change' | 'unlink', path: string, stats?: WatchStats): boolean;
  emit(event: 'ready'): boolean;
  emit(event: 'error', error: unknown): boolean;
  emit(event: string, ...args: unknown[]): boolean { return super.emit(event, ...args); }
  async close() { this.closed = true; }
}

export function deferred<Value>() {
  let finish: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => { finish = resolve; });
  return { promise, resolve(value: Value) {
    if (!finish) throw new Error('Deferred has not initialized');
    finish(value);
  } };
}

export function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error('Expected configured test capability');
  return value;
}

export function fakeScheduler() {
  let pending: (() => void) | null = null;
  const delays: number[] = [];
  return {
    delays,
    setTimer(callback: () => void, delay: number) {
      pending = callback;
      delays.push(delay);
      return 'timer';
    },
    clearTimer() { pending = null; },
    hasPending: () => pending !== null,
    async fire() {
      const callback = pending;
      pending = null;
      if (!callback) throw new Error('No scheduled tick');
      await callback();
    },
  };
}
