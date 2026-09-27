import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchWorktree } from './watcher.js';

const execFileAsync = promisify(execFile);

// A disposable scratch git repo (not this project's own repo), matching the
// pattern in file-content.test.js, so we can trigger real filesystem events
// (add/change/unlink) without touching the real working tree. Real chokidar
// is used throughout rather than mocked, per the issue's guidance: this
// module's job is exactly the debounce/dedupe/ignore behavior layered on
// top of chokidar, which is only meaningfully tested against a real watcher.
let repoDir;

before(async () => {
  repoDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-watcher-'));
  const run = (args) => execFileAsync('git', args, { cwd: repoDir });

  await run(['init', '-q']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Canopy Test']);
  await writeFile(path.join(repoDir, 'tracked.txt'), 'original content\n');
  await run(['add', '.']);
  await run(['commit', '-q', '-m', 'initial commit']);
});

after(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

// Starts a watcher on the scratch repo, registers its cleanup with `t` (the
// repo's usual per-test teardown, e.g. server/app.test.js's
// `t.after(() => server.close())`), and resolves once its initial scan is
// done so tests can write files without racing the watcher's own startup.
async function startWatcher(t, onChange, options) {
  const watcher = watchWorktree(repoDir, onChange, { debounceMs: 30, ...options });
  t.after(() => watcher.close());
  await watcher.ready;
  return watcher;
}

// A tiny recording callback that resolves a promise on its first call,
// so tests can `await` the debounced batch instead of guessing timings.
function recordingCallback() {
  let resolve;
  const first = new Promise((r) => {
    resolve = r;
  });
  const calls = [];
  const fn = (paths) => {
    calls.push(paths);
    resolve(paths);
  };
  fn.calls = calls;
  fn.first = first;
  return fn;
}

test('editing a tracked file reports its relative path', async (t) => {
  const onChange = recordingCallback();
  await startWatcher(t, onChange);

  await writeFile(path.join(repoDir, 'tracked.txt'), 'edited content\n');

  const paths = await onChange.first;
  assert.deepEqual(paths, ['tracked.txt']);
});

test('adding a new file reports its relative path', async (t) => {
  const onChange = recordingCallback();
  await startWatcher(t, onChange);

  await writeFile(path.join(repoDir, 'new-file.txt'), 'brand new\n');

  const paths = await onChange.first;
  assert.deepEqual(paths, ['new-file.txt']);
});

test('deleting a file reports its relative path', async (t) => {
  await writeFile(path.join(repoDir, 'to-delete.txt'), 'will be deleted\n');
  const onChange = recordingCallback();
  await startWatcher(t, onChange);

  await unlink(path.join(repoDir, 'to-delete.txt'));

  const paths = await onChange.first;
  assert.deepEqual(paths, ['to-delete.txt']);
});

test('rapid repeated edits to the same file within the debounce window collapse into one call', async (t) => {
  const onChange = recordingCallback();
  await startWatcher(t, onChange);

  await writeFile(path.join(repoDir, 'tracked.txt'), 'first edit\n');
  await writeFile(path.join(repoDir, 'tracked.txt'), 'second edit\n');
  await writeFile(path.join(repoDir, 'tracked.txt'), 'third edit\n');

  const paths = await onChange.first;
  assert.deepEqual(paths, ['tracked.txt']);

  // Give any (incorrect) extra calls a chance to land before asserting
  // there weren't any.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(onChange.calls.length, 1);
});

test('edits to two different files within the debounce window batch into one call', async (t) => {
  await writeFile(path.join(repoDir, 'second.txt'), 'original\n');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const onChange = recordingCallback();
  await startWatcher(t, onChange);

  await writeFile(path.join(repoDir, 'tracked.txt'), 'edit a\n');
  await writeFile(path.join(repoDir, 'second.txt'), 'edit b\n');

  const paths = await onChange.first;
  assert.deepEqual([...paths].sort(), ['second.txt', 'tracked.txt']);
});

test('changes under .git are ignored', async (t) => {
  const onChange = recordingCallback();
  await startWatcher(t, onChange);

  await mkdir(path.join(repoDir, '.git', 'canopy-test-dir'));
  await writeFile(path.join(repoDir, '.git', 'canopy-test-file'), 'noise\n');
  // A real change too, so we have something to wait on: if .git noise were
  // reported it would arrive first (or alongside) this one.
  await writeFile(path.join(repoDir, 'tracked.txt'), 'a real edit\n');

  const paths = await onChange.first;
  assert.deepEqual(paths, ['tracked.txt']);
});

test('close() stops reporting further changes', async (t) => {
  const onChange = recordingCallback();
  const watcher = await startWatcher(t, onChange);
  await watcher.close(); // t.after's close() is then a harmless no-op repeat

  await writeFile(path.join(repoDir, 'tracked.txt'), 'after close\n');
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(onChange.calls.length, 0);
});
