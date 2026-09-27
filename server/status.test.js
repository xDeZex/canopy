import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, buildFileTree } from './status.js';

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
