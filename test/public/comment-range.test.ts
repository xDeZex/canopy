import test from 'node:test';
import assert from 'node:assert/strict';
import { composerTarget, rangeFromSelection } from '../../public/comment-range.js';

const sel = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => ({ startLineNumber, startColumn, endLineNumber, endColumn });

test('a cursor or in-line selection anchors to its single line', () => {
  assert.deepEqual(rangeFromSelection(sel(4, 3, 4, 3), 10), { line: 4, endLine: 4 });
  assert.deepEqual(rangeFromSelection(sel(4, 1, 4, 9), 10), { line: 4, endLine: 4 });
});

test('a multi-line selection anchors to its inclusive 1-based line range', () => {
  assert.deepEqual(rangeFromSelection(sel(3, 2, 5, 4), 10), { line: 3, endLine: 5 });
  assert.deepEqual(rangeFromSelection(sel(1, 1, 10, 6), 10), { line: 1, endLine: 10 });
});

test('a selection ending at column 1 of a later line does not include that line', () => {
  assert.deepEqual(rangeFromSelection(sel(3, 1, 6, 1), 10), { line: 3, endLine: 5 });
  assert.deepEqual(rangeFromSelection(sel(3, 1, 4, 1), 10), { line: 3, endLine: 3 });
});

test('a reversed selection is normalised', () => {
  assert.deepEqual(rangeFromSelection(sel(5, 4, 3, 2), 10), { line: 3, endLine: 5 });
});

test('selections outside the file or malformed ones create no anchor', () => {
  assert.equal(rangeFromSelection(sel(0, 1, 2, 1), 10), null);
  assert.equal(rangeFromSelection(sel(9, 1, 11, 2), 10), null);
  assert.equal(rangeFromSelection(sel(1, 1, 1.5, 1), 10), null);
  assert.equal(rangeFromSelection(null, 10), null);
  assert.equal(rangeFromSelection({}, 10), null);
});

test('the composer target is the selection, or just the clicked line when it is outside the selection', () => {
  const range = sel(3, 2, 5, 4);
  assert.deepEqual(composerTarget(range, 10), { line: 3, endLine: 5 });
  assert.deepEqual(composerTarget(range, 10, 4), { line: 3, endLine: 5 });
  assert.deepEqual(composerTarget(range, 10, 3), { line: 3, endLine: 5 });
  assert.deepEqual(composerTarget(range, 10, 5), { line: 3, endLine: 5 });
  assert.deepEqual(composerTarget(range, 10, 8), { line: 8, endLine: 8 });
  assert.deepEqual(composerTarget(range, 10, 2), { line: 2, endLine: 2 });
});

test('with no usable selection a click targets its line and a keyboard action targets nothing', () => {
  assert.deepEqual(composerTarget(sel(9, 1, 11, 2), 10, 6), { line: 6, endLine: 6 });
  assert.equal(composerTarget(sel(9, 1, 11, 2), 10), null);
});
