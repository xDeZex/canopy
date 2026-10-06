// Fans one underlying source out to many subscribers instead of starting a
// new one per subscriber: without this, each open browser tab — or each
// EventSource auto-reconnect — would multiply the poll's process-spawn cost
// indefinitely. `start(onChange, { onError })` is called on the first
// subscriber and returns `{ close }`, which is called when the last one leaves.
// Late subscribers receive the latest successful value immediately; the cache
// belongs to that source lifecycle and errors never replace it.
import type { Closable } from './observation-port.js';

export interface Subscriber<Value, Failure = unknown> {
  onChange: (value: Value) => void;
  onError?: (error: Failure) => void;
}
export type StartSource<Value, Failure = unknown> = (onChange: (value: Value) => void,
  options: { onError: (error: Failure) => void }) => Closable;
interface Lifecycle<Value, Failure> {
  subscribers: Set<Subscriber<Value, Failure>>;
  source: Closable | null;
  cache: { hasLatest: false } | { hasLatest: true; latest: Value };
}

export function createFanOut<Value, Failure = unknown>(start: StartSource<Value, Failure>) {
  let active: Lifecycle<Value, Failure> | null = null;

  return function subscribe({ onChange, onError }: Subscriber<Value, Failure>) {
    const subscriber = { onChange, onError };
    if (!active) {
      const subscribers = new Set([subscriber]);
      const lifecycle: Lifecycle<Value, Failure> = { subscribers, source: null, cache: { hasLatest: false } };
      // Register before starting, since a source may emit synchronously.
      active = lifecycle;
      lifecycle.source = start(
        (value) => {
          lifecycle.cache = { hasLatest: true, latest: value };
          // Subscribers added during delivery already receive this via replay.
          for (const subscriber of [...subscribers]) {
            if (subscribers.has(subscriber)) subscriber.onChange(value);
          }
        },
        {
          onError: (err) => {
            for (const subscriber of subscribers) subscriber.onError?.(err);
          },
        }
      );
    } else {
      active.subscribers.add(subscriber);
      if (active.cache.hasLatest) subscriber.onChange(active.cache.latest);
    }

    const lifecycle = active;
    return () => {
      if (!lifecycle.subscribers.delete(subscriber)) return;
      if (lifecycle.subscribers.size === 0) {
        active = null;
        if (lifecycle.source === null) throw new TypeError('Source has not finished starting');
        lifecycle.source.close();
      }
    };
  };
}
