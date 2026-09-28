import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitLog, markTouching } from './commits.js';

// Captured `git log --pretty=format:LOG_FORMAT` output: fields joined by the
// unit separator (0x1f), commits by a newline, no trailing newline.
const SEP = '\x1f';
const THIRD = ['c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'third commit', '2026-09-27T10:00:00+02:00'];
const SECOND = ['b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'second commit', '2026-09-26T10:00:00+02:00'];
const FIRST = ['a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'first commit', '2026-09-25T09:30:00-05:00'];
const line = (fields) => fields.join(SEP);
const LOG_OUTPUT = [THIRD, SECOND, FIRST].map(line).join('\n');

const toCommit = ([sha, message, date]) => ({ sha, message, date });

test('parses multiple commits into sha/message/date, keeping git\'s newest-first order', () => {
  assert.deepEqual(parseCommitLog(LOG_OUTPUT), [THIRD, SECOND, FIRST].map(toCommit));
});

test('parses a single commit', () => {
  assert.deepEqual(parseCommitLog(line(FIRST)), [toCommit(FIRST)]);
});

test('returns an empty array for empty output (a repo with no commits yet)', () => {
  assert.deepEqual(parseCommitLog(''), []);
});

test('ignores a single trailing newline, LF or CRLF, without adding a phantom commit', () => {
  const expected = [THIRD, SECOND, FIRST].map(toCommit);
  assert.deepEqual(parseCommitLog(`${LOG_OUTPUT}\n`), expected);
  assert.deepEqual(parseCommitLog(`${LOG_OUTPUT}\r\n`), expected);
  assert.deepEqual(parseCommitLog('\n'), []);
});

test('markTouching flags only the shas that touched the file, keeping every commit in order', () => {
  const commits = [THIRD, SECOND, FIRST].map(toCommit);

  const marked = markTouching(commits, [THIRD[0], FIRST[0]]);

  assert.deepEqual(marked.map((c) => [c.message, c.touchesFile]), [
    ['third commit', true],
    ['second commit', false],
    ['first commit', true],
  ]);
});
