import type { WatchPolicy, WatchStats } from './watch-policy.js';

// Only capabilities consumed by observation; fakes need not be FSWatcher or Stats.
export interface ObservationWatcher {
  on(event: 'add' | 'change' | 'unlink', callback: (path: string, stats?: WatchStats) => void): this;
  on(event: 'error', callback: (error: unknown) => void): this;
  once(event: 'ready', callback: () => void): this;
  once(event: 'error', callback: (error: unknown) => void): this;
  close(): void | Promise<void>;
}
export interface ObservationOptions {
  cwd?: string;
  ignored?: WatchPolicy;
  ignoreInitial?: boolean;
  followSymlinks?: boolean;
  alwaysStat?: boolean;
}
export type Watch = (path: string, options: ObservationOptions) => ObservationWatcher;
export type TimerHandle = ReturnType<typeof setTimeout> | number | string;
export interface TimerOptions {
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle | undefined) => void;
}
export interface Closable { close(): unknown }
