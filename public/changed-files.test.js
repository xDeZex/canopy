import test from 'node:test';
import assert from 'node:assert/strict';
import { changedFiles } from './changed-files.js';

test('changedFiles lists non-clean files at any depth, sorted by full path', () => {
  const zAdded = { type: 'file', name: 'z.txt', path: 'z.txt', status: 'added' };
  const deepModified = { type: 'file', name: 'b.js', path: 'src/deep/b.js', status: 'modified' };
  const srcDeleted = { type: 'file', name: 'a.js', path: 'src/a.js', status: 'deleted' };
  const tree = [
    zAdded,
    { type: 'file', name: 'clean.txt', path: 'clean.txt', status: 'clean' },
    { type: 'dir', name: 'src', path: 'src', children: [
      { type: 'dir', name: 'deep', path: 'src/deep', children: [deepModified] },
      srcDeleted,
    ] },
  ];

  assert.deepEqual(changedFiles(tree), [srcDeleted, deepModified, zAdded]);
});

test('changedFiles sorts alphabetically regardless of letter case', () => {
  const file = (path) => ({ type: 'file', name: path, path, status: 'modified' });
  const tree = [file('Zeta.js'), file('alpha.js'), file('Beta.js')];

  assert.deepEqual(changedFiles(tree).map((f) => f.path), ['alpha.js', 'Beta.js', 'Zeta.js']);
});

test('changedFiles returns an empty array when nothing changed', () => {
  assert.deepEqual(changedFiles([]), []);
  assert.deepEqual(changedFiles([{ type: 'file', name: 'a', path: 'a', status: 'clean' }]), []);
});
