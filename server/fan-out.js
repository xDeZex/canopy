// Fans one underlying source out to many subscribers instead of starting a
// new one per subscriber: without this, each open browser tab — or each
// EventSource auto-reconnect — would multiply the poll's process-spawn cost
// indefinitely. `start(onChange, { onError })` is called on the first
// subscriber and returns `{ close }`, which is called when the last one leaves.
// Late subscribers receive the latest successful value immediately; the cache
// belongs to that source lifecycle and errors never replace it.
export function createFanOut(start) {
  let active = null;

  return function subscribe({ onChange, onError }) {
    const subscriber = { onChange, onError };
    if (!active) {
      const subscribers = new Set([subscriber]);
      const lifecycle = { subscribers, source: null, hasLatest: false, latest: undefined };
      // Register before starting, since a source may emit synchronously.
      active = lifecycle;
      lifecycle.source = start(
        (value) => {
          lifecycle.latest = value;
          lifecycle.hasLatest = true;
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
      if (active.hasLatest) subscriber.onChange(active.latest);
    }

    const lifecycle = active;
    return () => {
      if (!lifecycle.subscribers.delete(subscriber)) return;
      if (lifecycle.subscribers.size === 0) {
        active = null;
        lifecycle.source.close();
      }
    };
  };
}
