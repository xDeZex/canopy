import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanOut } from '../../server/fan-out.js';
import type { StartSource } from '../../server/fan-out.js';
import { required } from './observation-fakes.js';

type TestValue = number | readonly { path: string; branch?: string; head?: string }[];
function message(error: unknown) {
  assert.ok(error instanceof Error);
  return error.message;
}

// A fake source that records starts/closes and exposes its callbacks.
function fakeSource() {
  let emit: ((value: TestValue) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const source: { starts: number; closes: number; readonly emit: (value: TestValue) => void;
    readonly fail: (error: unknown) => void; start: StartSource<TestValue> } = {
    starts: 0, closes: 0,
    get emit() { return required(emit); },
    get fail() { return required(fail); },
    start: (onChange, { onError }) => {
      source.starts++;
      emit = onChange;
      fail = onError;
      return { close: () => source.closes++ };
    },
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
  const first: TestValue[] = [];
  const latest = [{ path: '/main', branch: 'main', head: 'new' }];
  const leave = subscribe({ onChange: (value) => first.push(value) });
  source.emit([{ path: '/main', branch: 'main', head: 'old' }]);
  source.emit(latest);
  const late: TestValue[] = [];
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
  const late: TestValue[] = [];
  let leaveLate: (() => void) | undefined;
  const leave = subscribe({ onChange: () => {
    leaveLate = subscribe({ onChange: (value) => late.push(value) });
  } });

  source.emit([]);

  assert.deepEqual(late, [[]]);
  required(leaveLate)();
  leave();
});

test('the first subscriber receives synchronous source errors and success without duplicates', () => {
  const values: TestValue[] = [];
  const errors: string[] = [];
  const subscribe = createFanOut<TestValue>((onChange, { onError }) => {
    onError(new Error('initial failure'));
    onChange([]);
    return { close() {} };
  });
  const leave = subscribe({ onChange: (value) => values.push(value), onError: (error) => errors.push(message(error)) });

  assert.deepEqual(values, [[]]);
  assert.deepEqual(errors, ['initial failure']);
  leave();
});

test('subscribing during synchronous source startup shares the source and replays once', () => {
  let starts = 0;
  const subscribe = createFanOut<TestValue>((onChange) => {
    starts++;
    onChange([]);
    return { close() {} };
  });
  const late: TestValue[] = [];
  let leaveLate: (() => void) | undefined;
  const leave = subscribe({ onChange: () => {
    leaveLate = subscribe({ onChange: (value) => late.push(value) });
  } });

  assert.equal(starts, 1);
  assert.deepEqual(late, [[]]);
  required(leaveLate)();
  leave();
});

test('errors are live-only and preserve the cached success, including an empty list', () => {
  const source = fakeSource();
  const subscribe = createFanOut(source.start);
  const errors: string[] = [];
  const leave = subscribe({ onChange() {}, onError: (error) => errors.push(message(error)) });
  source.fail(new Error('before success'));
  const late: TestValue[] = [];
  const lateErrors: string[] = [];
  const leaveLate = subscribe({ onChange: (value) => late.push(value), onError: (error) => lateErrors.push(message(error)) });
  assert.deepEqual(late, []);
  assert.deepEqual(lateErrors, []);

  source.emit([]);
  source.fail(new Error('after success'));
  const reconnect: TestValue[] = [];
  const reconnectErrors: string[] = [];
  const leaveReconnect = subscribe({ onChange: (value) => reconnect.push(value), onError: (error) => reconnectErrors.push(message(error)) });
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
  const values: [string, TestValue][] = [];
  const errors: [string, string][] = [];
  subscribe({ onChange: (v) => values.push(['a', v]), onError: (e) => errors.push(['a', message(e)]) });
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

  const later: TestValue[] = [];
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

  const values: TestValue[] = [];
  const leaveNext = subscribe({ onChange: (value) => values.push(value) });
  emitOld([{ path: '/stale' }]);
  const late: TestValue[] = [];
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
  const seen: TestValue[] = [];
  const leave = subscribe({ onChange: (v) => seen.push(v) });
  leave();

  subscribe({ onChange() {} });
  assert.equal(source.starts, 2);
  source.emit(1);
  assert.deepEqual(seen, []);
});
