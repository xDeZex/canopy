import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanOut } from '../../server/fan-out.js';

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

test('a late subscriber immediately receives the latest successful list', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const first = [];
  const latest = [{ path: '/main', branch: 'main', head: 'new' }];
  const leave = subscribe({ onChange: (value) => first.push(value) });
  source.emit([{ path: '/main', branch: 'main', head: 'old' }]);
  source.emit(latest);
  const late = [];
  const leaveLate = subscribe({ onChange: (value) => late.push(value) });

  assert.deepEqual(late, [latest]);
  assert.equal(first.length, 2);
  assert.equal(source.starts, 1);
  leaveLate();
  leave();
});

test('subscribing during a live emission receives that success only once', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const late = [];
  let leaveLate;
  const leave = subscribe({ onChange: () => {
    leaveLate = subscribe({ onChange: (value) => late.push(value) });
  } });

  source.emit([]);

  assert.deepEqual(late, [[]]);
  leaveLate();
  leave();
});

test('the first subscriber receives synchronous source errors and success without duplicates', () => {
  const values = [];
  const errors = [];
  const subscribe = createFanOut((onChange, { onError }) => {
    onError(new Error('initial failure'));
    onChange([]);
    return { close() {} };
  });
  const leave = subscribe({ onChange: (value) => values.push(value), onError: (error) => errors.push(error.message) });

  assert.deepEqual(values, [[]]);
  assert.deepEqual(errors, ['initial failure']);
  leave();
});

test('subscribing during synchronous source startup shares the source and replays once', () => {
  let starts = 0;
  const subscribe = createFanOut((onChange) => {
    starts++;
    onChange([]);
    return { close() {} };
  });
  const late = [];
  let leaveLate;
  const leave = subscribe({ onChange: () => {
    leaveLate = subscribe({ onChange: (value) => late.push(value) });
  } });

  assert.equal(starts, 1);
  assert.deepEqual(late, [[]]);
  leaveLate();
  leave();
});

test('errors are live-only and preserve the cached success, including an empty list', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const errors = [];
  const leave = subscribe({ onChange() {}, onError: (error) => errors.push(error.message) });
  source.fail(new Error('before success'));
  const late = [];
  const lateErrors = [];
  const leaveLate = subscribe({ onChange: (value) => late.push(value), onError: (error) => lateErrors.push(error.message) });
  assert.deepEqual(late, []);
  assert.deepEqual(lateErrors, []);

  source.emit([]);
  source.fail(new Error('after success'));
  const reconnect = [];
  const reconnectErrors = [];
  const leaveReconnect = subscribe({ onChange: (value) => reconnect.push(value), onError: (error) => reconnectErrors.push(error.message) });
  assert.deepEqual(reconnect, [[]]);
  assert.deepEqual(reconnectErrors, []);
  assert.deepEqual(errors, ['before success', 'after success']);
  assert.deepEqual(lateErrors, ['after success']);
  leaveReconnect();
  leaveLate();
  leave();
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

test('repeated cleanup is safe and cannot close a later source lifecycle', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const leave = subscribe({ onChange() {} });
  leave();
  leave();
  assert.equal(source.closes, 1);

  const later = [];
  const leaveLater = subscribe({ onChange: (value) => later.push(value) });
  leave();
  source.emit([]);
  assert.deepEqual(later, [[]]);
  assert.equal(source.closes, 1);
  leaveLater();
  assert.equal(source.closes, 2);
});

test('a restarted source has no cached success from the previous lifecycle', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const leave = subscribe({ onChange() {} });
  source.emit([{ path: '/old' }]);
  const emitOld = source.emit;
  leave();

  const values = [];
  const leaveNext = subscribe({ onChange: (value) => values.push(value) });
  emitOld([{ path: '/stale' }]);
  const late = [];
  const leaveLate = subscribe({ onChange: (value) => late.push(value) });
  assert.deepEqual(values, []);
  assert.deepEqual(late, []);
  source.emit([{ path: '/new' }]);
  assert.deepEqual(values, [[{ path: '/new' }]]);
  assert.deepEqual(late, [[{ path: '/new' }]]);
  leaveLate();
  leaveNext();
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
