import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEditTime } from '../../public/edit-time.js';

test('elapsed edit time distinguishes unknown, recent, minute, hour and day boundaries', () => {
  const now = 90000000;
  assert.equal(formatEditTime(null, now), 'No edit time');
  assert.equal(formatEditTime(now, now), 'just now');
  assert.equal(formatEditTime(now - 60_000, now), '1m ago');
  assert.equal(formatEditTime(now - 3_600_000, now), '1h ago');
  assert.equal(formatEditTime(now - 86_400_000, now), '1d ago');
  assert.equal(formatEditTime(now + 1000, now), 'just now');
});
