import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanOut } from './fan-out.js';

// A fake source that records starts/closes and exposes its callbacks.
function fakeSource() {
  const source = { starts: 0, closes: 0 };
  source.start = (onChange, { onError }) => {
    source.starts++;
    source.emit = onChange;
    source.fail = onError;
    return { close: () => source.closes++ };
  };
  return source;
}

test('starts the source on the first subscriber only', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  subscribe({ onChange() {} });
  subscribe({ onChange() {} });
  assert.equal(source.starts, 1);
});

test('delivers each value and error to every subscriber', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const values = [];
  const errors = [];
  subscribe({ onChange: (v) => values.push(['a', v]), onError: (e) => errors.push(['a', e.message]) });
  subscribe({ onChange: (v) => values.push(['b', v]) });

  source.emit(1);
  source.fail(new Error('x'));

  assert.deepEqual(values, [['a', 1], ['b', 1]]);
  assert.deepEqual(errors, [['a', 'x']]);
});

test('closes the source only when the last subscriber leaves', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const leaveFirst = subscribe({ onChange() {} });
  const leaveSecond = subscribe({ onChange() {} });

  leaveFirst();
  assert.equal(source.closes, 0);
  leaveSecond();
  assert.equal(source.closes, 1);
});

test('a subscriber that left no longer receives values, and a later subscriber restarts the source', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const seen = [];
  const leave = subscribe({ onChange: (v) => seen.push(v) });
  leave();

  subscribe({ onChange() {} });
  assert.equal(source.starts, 2);
  source.emit(1);
  assert.deepEqual(seen, []);
});
