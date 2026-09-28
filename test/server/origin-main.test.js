import test from 'node:test';
import assert from 'node:assert/strict';
import { markOriginMain } from '../../server/commits.js';

const commits = [
  { sha: 'c3', message: 'local two', date: '2025-01-03' },
  { sha: 'c2', message: 'local one', date: '2025-01-02' },
  { sha: 'c1', message: 'pushed', date: '2025-01-01' },
];

test('markOriginMain flags only the commit origin/main points at, keeping every commit in order', () => {
  const marked = markOriginMain(commits, 'c2');
  assert.deepEqual(marked.map((c) => [c.sha, c.isOriginMain === true]), [
    ['c3', false],
    ['c2', true],
    ['c1', false],
  ]);
});

test('markOriginMain leaves commits untouched when origin/main is unknown or outside the history', () => {
  assert.deepEqual(markOriginMain(commits, null), commits);
  assert.deepEqual(markOriginMain(commits, 'elsewhere'), commits);
});
