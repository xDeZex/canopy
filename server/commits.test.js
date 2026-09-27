import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCommitLog, LOG_FORMAT } from './commits.js';

const execFileAsync = promisify(execFile);

// A disposable scratch git repo (not this project's own repo), same pattern
// as file-content.test.js, so the parser is exercised against git's real
// `git log` output rather than a hand-typed fixture string.
let repoDir;
let firstSha;
let secondSha;
let thirdSha;

before(async () => {
  repoDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-commits-'));
  const run = (args) => execFileAsync('git', args, { cwd: repoDir });

  await run(['init', '-q']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Canopy Test']);

  await writeFile(path.join(repoDir, 'file.txt'), 'v1\n');
  await run(['add', '.']);
  await run(['commit', '-q', '-m', 'first commit']);
  firstSha = (await run(['rev-parse', 'HEAD'])).stdout.trim();

  await writeFile(path.join(repoDir, 'file.txt'), 'v2\n');
  await run(['commit', '-q', '-am', 'second commit']);
  secondSha = (await run(['rev-parse', 'HEAD'])).stdout.trim();

  await writeFile(path.join(repoDir, 'file.txt'), 'v3\n');
  await run(['commit', '-q', '-am', 'third commit']);
  thirdSha = (await run(['rev-parse', 'HEAD'])).stdout.trim();
});

after(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

test('parses real `git log` output into sha/message/date, newest first', async () => {
  const { stdout } = await execFileAsync('git', ['log', `--pretty=format:${LOG_FORMAT}`], {
    cwd: repoDir,
  });

  const commits = parseCommitLog(stdout);

  assert.deepEqual(
    commits.map((c) => c.sha),
    [thirdSha, secondSha, firstSha]
  );
  assert.deepEqual(
    commits.map((c) => c.message),
    ['third commit', 'second commit', 'first commit']
  );
  for (const commit of commits) {
    assert.match(commit.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  }
});

test('returns an empty array for a repo with no commits yet', async () => {
  const emptyRepoDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-commits-empty-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: emptyRepoDir });
    // `git log` on a repo with no commits exits non-zero with no stdout, so
    // there's nothing to feed the parser here beyond confirming it handles
    // an empty string gracefully (the non-zero exit itself is handled by
    // the server route, not the parser).
    assert.deepEqual(parseCommitLog(''), []);
  } finally {
    await rm(emptyRepoDir, { recursive: true, force: true });
  }
});
