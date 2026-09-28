import test from 'node:test';
import assert from 'node:assert/strict';
import { getChangedPaths } from './status.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const git = promisify(execFile);

async function makeStatusFixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'canopy-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (...args) => git('git', args, { cwd: dir });
  await run('init', '-q');
  await writeFile(path.join(dir, 'old.txt'), 'rename content\n');
  await writeFile(path.join(dir, 'deleted.txt'), 'deleted content\n');
  await writeFile(path.join(dir, 'modified.txt'), 'original\n');
  await run('add', '.');
  await run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  const { stdout: base } = await run('rev-parse', 'HEAD');
  await writeFile(path.join(dir, 'later space.txt'), 'later\n');
  await run('add', 'later space.txt');
  await run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'later');
  await rename(path.join(dir, 'old.txt'), path.join(dir, 'new.txt'));
  await rm(path.join(dir, 'deleted.txt'));
  await writeFile(path.join(dir, 'modified.txt'), 'changed\n');
  await writeFile(path.join(dir, 'staged.txt'), 'staged\n');
  await writeFile(path.join(dir, 'untracked.txt'), 'untracked\n');
  await run('add', '-A', 'old.txt', 'new.txt', 'staged.txt');
  return { dir, base: base.trim() };
}

test('getChangedPaths reads HEAD and older refs from a real repo', async (t) => {
  const { dir, base } = await makeStatusFixture(t);
  const head = new Map((await getChangedPaths(dir)).map(({ path, status }) => [path, status]));
  assert.equal(head.get('staged.txt'), 'added');
  assert.equal(head.get('modified.txt'), 'modified');
  assert.equal(head.get('deleted.txt'), 'deleted');
  assert.equal(head.get('new.txt'), 'modified');
  assert.equal(head.get('untracked.txt'), 'added');

  const older = new Map((await getChangedPaths(dir, base)).map(({ path, status }) => [path, status]));
  for (const [file, status] of head) assert.equal(older.get(file), status, file);
  assert.equal(older.get('later space.txt'), 'added');
  assert.equal(older.has('old.txt'), false);
  await assert.rejects(getChangedPaths(dir, '--output=/tmp/nope'));
});
