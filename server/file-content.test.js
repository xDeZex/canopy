import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileContent } from './file-content.js';

const execFileAsync = promisify(execFile);

// A disposable scratch git repo (not this project's own repo) so we can put
// files into exact states — clean, modified, untracked, deleted — without
// touching the real working tree.
let repoDir;
let firstSha;
let secondSha;

before(async () => {
  repoDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-file-content-'));
  const run = (args) => execFileAsync('git', args, { cwd: repoDir });

  await run(['init', '-q']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Canopy Test']);

  await writeFile(path.join(repoDir, 'clean.txt'), 'clean content\n');
  await writeFile(path.join(repoDir, 'to-modify.txt'), 'original content\n');
  await writeFile(path.join(repoDir, 'to-delete.txt'), 'will be deleted\n');
  await writeFile(path.join(repoDir, 'across-commits.txt'), 'first commit content\n');
  await run(['add', '.']);
  await run(['commit', '-q', '-m', 'initial commit']);
  firstSha = (await run(['rev-parse', 'HEAD'])).stdout.trim();

  // A second commit, changing a file not otherwise used by the other tests,
  // so a locked-to-an-older-commit lookup (the `ref` param) has two
  // distinguishable versions of the same file to tell apart.
  await writeFile(path.join(repoDir, 'across-commits.txt'), 'second commit content\n');
  await run(['commit', '-q', '-am', 'second commit']);
  secondSha = (await run(['rev-parse', 'HEAD'])).stdout.trim();

  // Now put the working tree into the states each test exercises.
  await writeFile(path.join(repoDir, 'to-modify.txt'), 'modified content\n');
  await unlink(path.join(repoDir, 'to-delete.txt'));
  await writeFile(path.join(repoDir, 'untracked.txt'), 'brand new\n');
});

after(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

test('a clean tracked file has matching HEAD and working content', async () => {
  const result = await readFileContent(repoDir, 'clean.txt');
  assert.deepEqual(result, { head: 'clean content\n', working: 'clean content\n' });
});

test('a modified tracked file returns both its HEAD and working content', async () => {
  const result = await readFileContent(repoDir, 'to-modify.txt');
  assert.deepEqual(result, { head: 'original content\n', working: 'modified content\n' });
});

test('an untracked file has no HEAD version', async () => {
  const result = await readFileContent(repoDir, 'untracked.txt');
  assert.deepEqual(result, { head: null, working: 'brand new\n' });
});

test('a deleted file has no working-tree version', async () => {
  const result = await readFileContent(repoDir, 'to-delete.txt');
  assert.deepEqual(result, { head: 'will be deleted\n', working: null });
});

test('a path with neither a HEAD nor a working version returns both null', async () => {
  const result = await readFileContent(repoDir, 'does-not-exist.txt');
  assert.deepEqual(result, { head: null, working: null });
});

test('defaults to HEAD when no ref is given', async () => {
  const withDefault = await readFileContent(repoDir, 'to-modify.txt');
  const withExplicitHead = await readFileContent(repoDir, 'to-modify.txt', 'HEAD');
  assert.deepEqual(withDefault, withExplicitHead);
});

test('an explicit ref reads that commit\'s content instead of HEAD, leaving working untouched', async () => {
  const result = await readFileContent(repoDir, 'across-commits.txt', firstSha);
  assert.deepEqual(result, { head: 'first commit content\n', working: 'second commit content\n' });
});

test('a later ref reads a newer commit\'s content', async () => {
  const result = await readFileContent(repoDir, 'across-commits.txt', secondSha);
  assert.deepEqual(result, { head: 'second commit content\n', working: 'second commit content\n' });
});
