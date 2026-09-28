import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, parseNameStatus, getChangedPaths, mergeFileStatuses, listChangedFiles, nestIntoTree, buildFileTree } from './status.js';
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

test('parses NUL-delimited diff names including a rename and deletion', () => {
  assert.deepEqual(parseNameStatus('R100\0old name\0new name\0D\0gone\0A\0new\0M\0changed\0'), [
    { path: 'new name', status: 'modified' },
    { path: 'gone', status: 'deleted' },
    { path: 'new', status: 'added' },
    { path: 'changed', status: 'modified' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('ref status covers staged, unstaged, untracked, rename, deletion and older commits', async (t) => {
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

test('parses a modified tracked file', () => {
  assert.deepEqual(parseStatus(' M server/app.js\n'), [
    { path: 'server/app.js', status: 'modified' },
  ]);
});

test('parses an untracked file as added', () => {
  assert.deepEqual(parseStatus('?? server/status.js\n'), [
    { path: 'server/status.js', status: 'added' },
  ]);
});

test('parses a staged new file as added', () => {
  assert.deepEqual(parseStatus('A  server/status.js\n'), [
    { path: 'server/status.js', status: 'added' },
  ]);
});

test('parses a deleted file', () => {
  assert.deepEqual(parseStatus(' D server/old.js\n'), [
    { path: 'server/old.js', status: 'deleted' },
  ]);
});

test('parses a renamed file using its new path', () => {
  assert.deepEqual(parseStatus('R  server/old.js -> server/new.js\n'), [
    { path: 'server/new.js', status: 'modified' },
  ]);
});

test('parses multiple lines', () => {
  const output = [' M server/app.js', '?? server/status.js', ''].join('\n');

  assert.deepEqual(parseStatus(output), [
    { path: 'server/app.js', status: 'modified' },
    { path: 'server/status.js', status: 'added' },
  ]);
});

test('returns an empty array for empty output', () => {
  assert.deepEqual(parseStatus(''), []);
  assert.deepEqual(parseStatus('\n'), []);
});

test('mergeFileStatuses deduplicates paths, prefers status entries, defaults tracked paths to clean, and sorts by full path', () => {
  const merged = mergeFileStatuses(
    ['z.js', 'a.js', 'z.js', 'a-dir/nested.js', 'a.js'],
    [{ path: 'z.js', status: 'modified' }, { path: 'b.js', status: 'added' }]
  );

  assert.deepEqual(merged, [
    { path: 'a-dir/nested.js', status: 'clean' },
    { path: 'a.js', status: 'clean' },
    { path: 'b.js', status: 'added' },
    { path: 'z.js', status: 'modified' },
  ]);
});

test('mergeFileStatuses uses the new path for a rename parsed from git status', () => {
  const merged = mergeFileStatuses(
    ['server/new.js', 'server/other.js'],
    parseStatus('R  server/old.js -> server/new.js\n')
  );

  assert.deepEqual(merged, [
    { path: 'server/new.js', status: 'modified' },
    { path: 'server/other.js', status: 'clean' },
  ]);
});

test('listChangedFiles keeps only changed entries in full-path order', () => {
  const merged = mergeFileStatuses(
    ['z.js', 'a.js', 'a-dir/nested.js'],
    [{ path: 'z.js', status: 'deleted' }, { path: 'a-dir/nested.js', status: 'modified' }]
  );

  assert.deepEqual(listChangedFiles(merged), [
    { path: 'a-dir/nested.js', status: 'modified' },
    { path: 'z.js', status: 'deleted' },
  ]);
  assert.deepEqual(listChangedFiles(mergeFileStatuses(['clean.js'], [])), []);
});

test('nestIntoTree sorts directories before files regardless of flat path order', () => {
  const merged = mergeFileStatuses(
    ['b.js', 'a.js', 'a-dir/z.js', 'a-dir/b.js'],
    [{ path: 'a-dir/z.js', status: 'modified' }]
  );

  assert.deepEqual(nestIntoTree(merged), [
    {
      name: 'a-dir', type: 'dir', path: 'a-dir', children: [
        { name: 'b.js', type: 'file', path: 'a-dir/b.js', status: 'clean' },
        { name: 'z.js', type: 'file', path: 'a-dir/z.js', status: 'modified' },
      ],
    },
    { name: 'a.js', type: 'file', path: 'a.js', status: 'clean' },
    { name: 'b.js', type: 'file', path: 'b.js', status: 'clean' },
  ]);
});

test('nestIntoTree keeps both a deleted tracked child and its untracked file replacement', () => {
  const paths = ['foo/bar.txt', 'foo', 'foo/baz.txt', 'other.txt'];
  const statuses = [
    { path: 'foo/bar.txt', status: 'deleted' },
    { path: 'foo/baz.txt', status: 'deleted' },
    { path: 'foo', status: 'added' },
  ];
  const expected = [
    {
      name: 'foo', type: 'dir', path: 'foo', children: [
        { name: 'bar.txt', type: 'file', path: 'foo/bar.txt', status: 'deleted' },
        { name: 'baz.txt', type: 'file', path: 'foo/baz.txt', status: 'deleted' },
      ],
    },
    { name: 'foo', type: 'file', path: 'foo', status: 'added' },
    { name: 'other.txt', type: 'file', path: 'other.txt', status: 'clean' },
  ];

  assert.deepEqual(nestIntoTree(mergeFileStatuses(paths, statuses)), expected);
  assert.deepEqual(nestIntoTree(mergeFileStatuses([...paths].reverse(), [...statuses].reverse())), expected);
  assert.deepEqual(listChangedFiles(mergeFileStatuses(paths, statuses)), [
    { path: 'foo', status: 'added' },
    { path: 'foo/bar.txt', status: 'deleted' },
    { path: 'foo/baz.txt', status: 'deleted' },
  ]);
});

test('buildFileTree marks a tracked file with no status entry as clean', () => {
  assert.deepEqual(buildFileTree(['README.md'], []), [
    { name: 'README.md', type: 'file', path: 'README.md', status: 'clean' },
  ]);
});

test('buildFileTree applies a status entry to a tracked file', () => {
  const tree = buildFileTree(['server/app.js'], [{ path: 'server/app.js', status: 'modified' }]);

  assert.deepEqual(tree, [
    {
      name: 'server',
      type: 'dir',
      path: 'server',
      children: [{ name: 'app.js', type: 'file', path: 'server/app.js', status: 'modified' }],
    },
  ]);
});

test('buildFileTree includes an untracked file not present in the tracked list', () => {
  const tree = buildFileTree([], [{ path: 'server/status.js', status: 'added' }]);

  assert.deepEqual(tree, [
    {
      name: 'server',
      type: 'dir',
      path: 'server',
      children: [{ name: 'status.js', type: 'file', path: 'server/status.js', status: 'added' }],
    },
  ]);
});

test('buildFileTree merges sibling files under a shared directory', () => {
  const tree = buildFileTree(
    ['server/app.js', 'server/porcelain.js'],
    [{ path: 'server/app.js', status: 'modified' }]
  );

  assert.deepEqual(tree, [
    {
      name: 'server',
      type: 'dir',
      path: 'server',
      children: [
        { name: 'app.js', type: 'file', path: 'server/app.js', status: 'modified' },
        { name: 'porcelain.js', type: 'file', path: 'server/porcelain.js', status: 'clean' },
      ],
    },
  ]);
});

test('buildFileTree sorts directories before files, each alphabetically', () => {
  const tree = buildFileTree(['b.js', 'a-dir/nested.js', 'a.js'], []);

  assert.deepEqual(
    tree.map((n) => n.name),
    ['a-dir', 'a.js', 'b.js']
  );
});

test('buildFileTree returns an empty array when given no paths', () => {
  assert.deepEqual(buildFileTree([], []), []);
});
