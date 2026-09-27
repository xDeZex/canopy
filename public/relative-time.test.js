import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime } from './relative-time.js';

const now = new Date('2026-09-27T12:00:00Z');

test('a moment ago reads as "just now"', () => {
  assert.equal(formatRelativeTime('2026-09-27T11:59:30Z', now), 'just now');
});

test('just over a minute ago reads in minutes', () => {
  assert.equal(formatRelativeTime('2026-09-27T11:58:00Z', now), '2 minutes ago');
});

test('exactly one minute ago is singular', () => {
  assert.equal(formatRelativeTime('2026-09-27T11:59:00Z', now), '1 minute ago');
});

test('hours ago reads in hours', () => {
  assert.equal(formatRelativeTime('2026-09-27T09:00:00Z', now), '3 hours ago');
});

test('days ago reads in days', () => {
  assert.equal(formatRelativeTime('2026-09-24T12:00:00Z', now), '3 days ago');
});

test('weeks ago reads in weeks', () => {
  assert.equal(formatRelativeTime('2026-09-06T12:00:00Z', now), '3 weeks ago');
});

test('months ago reads in months', () => {
  assert.equal(formatRelativeTime('2026-06-27T12:00:00Z', now), '3 months ago');
});

test('years ago reads in years', () => {
  assert.equal(formatRelativeTime('2023-09-27T12:00:00Z', now), '3 years ago');
});

test('a future timestamp (clock skew) falls back to "just now" rather than a negative duration', () => {
  assert.equal(formatRelativeTime('2026-09-27T12:05:00Z', now), 'just now');
});
