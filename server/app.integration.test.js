import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';

const execFileAsync = promisify(execFile);

// A throwaway git repo (removed after the test) plus a `run(...git args)` helper.
async function makeGitRepo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'canopy-commits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (...args) => execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir });
  await run('init', '-q');
  return { dir, run };
}

// Serves `dir` as the only worktree; returns the port and the commits URL.
async function serveWorktree(t, dir) {
  const server = createApp({ listWorktrees: async () => [{ path: dir }] });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  return { port: server.address().port, base: `/api/commits?worktree=${encodeURIComponent(dir)}` };
}

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

// The real `git log` glue (rename following, literal file names) that the
// pure parsing and marking functions in commits.js can't reach.
test('GET /api/commits?file= still lists every commit when the file filter fails, and follows renames', async (t) => {
  const { dir, run } = await makeGitRepo(t);
  await writeFile(path.join(dir, 'old.txt'), 'some content\nmore lines\n');
  await run('add', '.');
  await run('commit', '-qm', 'add old');
  await run('mv', 'old.txt', 'new.txt');
  await run('commit', '-qm', 'rename');

  const { port, base } = await serveWorktree(t, dir);

  const outside = JSON.parse((await get(port, `${base}&file=${encodeURIComponent('../outside')}`)).body);
  assert.deepEqual(outside.map((c) => c.message), ['rename', 'add old']);
  assert.ok(outside.every((c) => !c.touchesFile));

  const renamed = JSON.parse((await get(port, `${base}&file=new.txt`)).body);
  assert.deepEqual(renamed.map((c) => c.touchesFile), [true, true]);
});

test('GET /api/commits?file= matches the file name literally, not as a git pathspec', async (t) => {
  const { dir, run } = await makeGitRepo(t);
  await writeFile(path.join(dir, 'a.txt'), '1\n');
  await run('add', '.');
  await run('commit', '-qm', 'add a');

  const { port, base } = await serveWorktree(t, dir);

  const res = await get(port, `${base}&file=${encodeURIComponent('*.txt')}`);
  assert.deepEqual(JSON.parse(res.body).map((c) => c.touchesFile), [false]);
});
