// Fans one underlying source out to many subscribers instead of starting a
// new one per subscriber: without this, each open browser tab — or each
// EventSource auto-reconnect — would multiply the poll's process-spawn cost
// indefinitely. `start(onChange, { onError })` is called on the first
// subscriber and returns `{ close }`, which is called when the last one leaves.
export function createFanOut(start) {
  let active = null;

  return function subscribe({ onChange, onError }) {
    if (!active) {
      const subscribers = new Set();
      const source = start(
        (value) => {
          for (const subscriber of subscribers) subscriber.onChange(value);
        },
        {
          onError: (err) => {
            for (const subscriber of subscribers) subscriber.onError?.(err);
          },
        }
      );
      active = { source, subscribers };
    }

    const subscriber = { onChange, onError };
    active.subscribers.add(subscriber);

    return () => {
      active.subscribers.delete(subscriber);
      if (active.subscribers.size === 0) {
        active.source.close();
        active = null;
      }
    };
  };
}
