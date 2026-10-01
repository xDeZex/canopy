import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitLog, markTouching, listCommits, LOG_FORMAT } from '../../server/commits.js';

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

// A fake runGit: `responses` maps a git subcommand ('log', 'merge-base') to
// its stdout, or to an Error to throw. `--literal-pathspecs` is skipped when
// finding the subcommand. Every call is recorded in `calls`.
function fakeGit(responses) {
  const calls = [];
  const runGit = async (args, cwd) => {
    calls.push({ args, cwd });
    const response = responses[args.find((arg) => !arg.startsWith('--literal'))];
    if (response instanceof Error) throw response;
    return response ?? '';
  };
  return { runGit, calls };
}

const sep = '\x1f';
const twoCommits = `bbb${sep}second${sep}2026-01-02T00:00:00+00:00\naaa${sep}first${sep}2026-01-01T00:00:00+00:00`;

test('listCommits runs git log in the worktree and parses it', async () => {
  const { runGit, calls } = fakeGit({ log: twoCommits, 'merge-base': new Error('no origin') });
  const commits = await listCommits('/wt', null, runGit);

  assert.deepEqual(commits.map((c) => c.sha), ['bbb', 'aaa']);
  assert.ok(commits.every((c) => !('touchesFile' in c)));
  assert.deepEqual(calls[0], { args: ['log', `--pretty=format:${LOG_FORMAT}`], cwd: '/wt' });
});

test('listCommits marks commits touching a file, using literal pathspecs', async () => {
  const { runGit } = fakeGit({ log: twoCommits, 'merge-base': new Error('no origin') });
  // The file filter is the `--follow` call; it answers with just the shas.
  const commits = await listCommits('/wt', 'a.txt', async (args, cwd) =>
    args.includes('--follow') ? 'aaa\n' : runGit(args, cwd));

  assert.deepEqual(commits.map((c) => c.touchesFile), [false, true]);
});

test('listCommits passes the file after -- with literal pathspecs and --follow', async () => {
  const seen = [];
  await listCommits('/wt', '*.txt', async (args) => {
    seen.push(args);
    return args[0] === 'log' ? twoCommits : '';
  });

  assert.ok(seen.some((args) =>
    args.join(' ') === '--literal-pathspecs log --follow --pretty=format:%H -- *.txt'));
});

test('listCommits still lists every commit, unmarked, when the file filter fails', async () => {
  const commits = await listCommits('/wt', '../outside', async (args) => {
    if (args.includes('--follow')) throw new Error('outside repository');
    return args[0] === 'log' ? twoCommits : '';
  });

  assert.equal(commits.length, 2);
  assert.ok(commits.every((c) => !('touchesFile' in c)));
});

test('listCommits flags the latest shared commit when origin/main is an ancestor', async () => {
  const { runGit } = fakeGit({ log: twoCommits, 'merge-base': 'aaa\n' });
  const commits = await listCommits('/wt', null, runGit);

  assert.deepEqual(commits.map((c) => c.isOriginMain), [false, true]);
});

test('listCommits marks the latest shared commit when origin/main advances beyond the worktree history', async () => {
  const { runGit, calls } = fakeGit({ log: twoCommits, 'rev-parse': 'ccc\n', 'merge-base': 'aaa\n' });
  const commits = await listCommits('/wt', null, runGit);

  assert.deepEqual(commits, [
    { sha: 'bbb', message: 'second', date: '2026-01-02T00:00:00+00:00', isOriginMain: false },
    { sha: 'aaa', message: 'first', date: '2026-01-01T00:00:00+00:00', isOriginMain: true },
  ]);
  assert.ok(calls.some(({ args, cwd }) =>
    cwd === '/wt' && args.join(' ') === 'merge-base HEAD refs/remotes/origin/main'));
});

test('listCommits returns no commits when git log fails (repo with no commits)', async () => {
  const { runGit } = fakeGit({ log: new Error('does not have any commits yet') });

  assert.deepEqual(await listCommits('/wt', null, runGit), []);
});

test('listCommits keeps every commit without a divider when origin/main is missing', async () => {
  const { runGit } = fakeGit({ log: twoCommits, 'merge-base': new Error('missing ref') });

  assert.deepEqual(await listCommits('/wt', null, runGit), [
    { sha: 'bbb', message: 'second', date: '2026-01-02T00:00:00+00:00' },
    { sha: 'aaa', message: 'first', date: '2026-01-01T00:00:00+00:00' },
  ]);
});

test('listCommits preserves file marking without a divider when origin/main has unrelated history', async () => {
  const { runGit } = fakeGit({ log: twoCommits, 'merge-base': new Error('no common ancestor') });
  const commits = await listCommits('/wt', 'a.txt', async (args, cwd) =>
    args.includes('--follow') ? 'aaa\n' : runGit(args, cwd));

  assert.deepEqual(commits, [
    { sha: 'bbb', message: 'second', date: '2026-01-02T00:00:00+00:00', touchesFile: false },
    { sha: 'aaa', message: 'first', date: '2026-01-01T00:00:00+00:00', touchesFile: true },
  ]);
});
