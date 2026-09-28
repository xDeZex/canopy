import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFiles } from './collect-files.js';

test('collectFiles returns every file leaf in tree order, without directories', () => {
  const first = { type: 'file', path: 'a', status: 'clean' };
  const nested = { type: 'file', path: 'src/deep/b', status: 'modified' };
  const last = { type: 'file', path: 'z', status: 'added' };
  const nodes = [
    first,
    { type: 'dir', path: 'empty', children: [] },
    { type: 'dir', path: 'src', children: [
      { type: 'dir', path: 'src/deep', children: [nested] },
    ] },
    last,
  ];

  assert.deepEqual(collectFiles(nodes), [first, nested, last]);
  assert.equal(nodes[2].children.length, 1, 'the input tree is not modified');
});

test('collectFiles returns an empty array for an empty tree or empty folders', () => {
  assert.deepEqual(collectFiles([]), []);
  assert.deepEqual(collectFiles([{ type: 'dir', path: 'empty', children: [] }]), []);
});
