import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTabScrollAffordance } from './tab-scroll.js';

test('no affordance when content fits without scrolling', () => {
  const result = computeTabScrollAffordance({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 });
  assert.deepEqual(result, { showLeft: false, showRight: false });
});

test('shows only the right fade when scrolled to the start of an overflowing bar', () => {
  const result = computeTabScrollAffordance({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
  assert.deepEqual(result, { showLeft: false, showRight: true });
});

test('shows only the left fade when scrolled to the end of an overflowing bar', () => {
  const result = computeTabScrollAffordance({ scrollLeft: 600, scrollWidth: 1000, clientWidth: 400 });
  assert.deepEqual(result, { showLeft: true, showRight: false });
});

test('shows both fades when scrolled to the middle of an overflowing bar', () => {
  const result = computeTabScrollAffordance({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 400 });
  assert.deepEqual(result, { showLeft: true, showRight: true });
});

test('tolerates subpixel rounding at the very start and end', () => {
  const atStart = computeTabScrollAffordance({ scrollLeft: 0.4, scrollWidth: 1000, clientWidth: 400 });
  assert.equal(atStart.showLeft, false);

  const atEnd = computeTabScrollAffordance({ scrollLeft: 600, scrollWidth: 1000.4, clientWidth: 400 });
  assert.equal(atEnd.showRight, false);
});
