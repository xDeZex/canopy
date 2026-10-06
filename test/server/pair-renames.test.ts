import test from 'node:test';
import assert from 'node:assert/strict';
import { renameCandidates, pairRenames, applyRenames } from '../../server/pair-renames.js';

const lines = (...n: number[]) => n.map((i) => `line ${i}`).join('\n');
const file = (path: string, content: string | null) => ({ path, content });
const paired = (from: string, to: string) => pairRenames([file('old', from)], [file('new', to)]);
const renamed = [{ oldPath: 'old', path: 'new' }];

test('pairs a deleted file with an added file of similar content', () => {
  assert.deepEqual(paired(lines(1, 2, 3, 4), lines(1, 2, 3, 5)), renamed);
});

test('pairs identical content', () => {
  assert.deepEqual(paired('a\nb\n', 'a\nb\n'), renamed);
});

test('does not pair unrelated deletions and additions', () => {
  assert.deepEqual(paired(lines(1, 2, 3), lines(7, 8, 9)), []);
});

test('pairs a file that gained a trailing newline', () => {
  assert.deepEqual(paired('one\ntwo\nthree', 'one\ntwo\nthree\n'), renamed);
});

test('weighs lines by length, so shared boilerplate does not dominate', () => {
  const boilerplate = '}\n});\n}\n';
  assert.deepEqual(paired(`${boilerplate}real logic here\nmore real logic\n`, `${boilerplate}something else\nentirely different\n`), []);
});

test('pairs contents at exactly the 0.5 threshold but not just below it', () => {
  // Half of the larger content's characters are shared lines, then slightly under.
  assert.deepEqual(paired('aaaa\nbbbb\n', 'aaaa\ncccc\n'), renamed);
  assert.deepEqual(paired('aaaa\nbbbb\n', 'aaaa\ncccc\nd\n'), []);
});

test('does not pair contents too different in size', () => {
  assert.deepEqual(paired('a\n', `a\n${'b\n'.repeat(50)}`), []);
});

test('does not pair empty, unreadable or binary files', () => {
  assert.deepEqual(pairRenames(
    [file('a', ''), file('b', null), file('bin', 'same\0bytes')],
    [file('c', ''), file('d', lines(1)), file('bin2', 'same\0bytes')],
  ), []);
});

test('uses each file once, giving the best match to the closest pair', () => {
  assert.deepEqual(pairRenames(
    [file('a', lines(1, 2, 3, 4)), file('b', lines(1, 2, 3, 9))],
    [file('x', lines(1, 2, 3, 4))],
  ), [{ oldPath: 'a', path: 'x' }]);
});

test('pairs several moves independently', () => {
  assert.deepEqual(pairRenames(
    [file('a', lines(1, 2, 3)), file('b', lines(7, 8, 9))],
    [file('y', lines(7, 8, 9)), file('x', lines(1, 2, 3))],
  ).sort((p, q) => p.oldPath.localeCompare(q.oldPath)), [
    { oldPath: 'a', path: 'x' },
    { oldPath: 'b', path: 'y' },
  ]);
});

test('applyRenames swaps a paired deletion and addition for one renamed entry', () => {
  assert.deepEqual(applyRenames([
    { path: 'gone.js', status: 'deleted' },
    { path: 'kept.js', status: 'deleted' },
    { path: 'moved.js', status: 'added' },
    { path: 'edited.js', status: 'modified' },
  ], [{ oldPath: 'gone.js', path: 'moved.js' }]), [
    { path: 'kept.js', status: 'deleted' },
    { path: 'moved.js', status: 'renamed', oldPath: 'gone.js' },
    { path: 'edited.js', status: 'modified' },
  ]);
});

test('renameCandidates picks deleted files and untracked additions only', () => {
  assert.deepEqual(renameCandidates([
    { path: 'gone', status: 'deleted' },
    { path: 'untracked', status: 'added', untracked: true },
    { path: 'staged', status: 'added' },
    { path: 'edited', status: 'modified' },
  ]), { deleted: ['gone'], added: ['untracked'] });
});

test('renameCandidates leaves a deleted and recreated path unpaired', () => {
  assert.equal(renameCandidates([
    { path: 'same', status: 'deleted' },
    { path: 'same', status: 'added', untracked: true },
  ]), null);
});

test('renameCandidates is null without both sides', () => {
  assert.equal(renameCandidates([{ path: 'gone', status: 'deleted' }]), null);
  assert.equal(renameCandidates([{ path: 'new', status: 'added', untracked: true }]), null);
  assert.equal(renameCandidates([{ path: 'gone', status: 'deleted' }, { path: 'staged', status: 'added' }]), null);
});

test('pairs a bulk move of thousands of files by exact content', () => {
  const files = Array.from({ length: 2000 }, (_, i) => `unique content ${i}\nsecond line ${i}\n`);
  const deleted = files.map((content, i) => file(`src/f${i}.js`, content));
  const added = files.map((content, i) => file(`lib/f${i}.js`, content));

  const pairs = pairRenames(deleted, added);

  assert.equal(pairs.length, 2000);
  assert.deepEqual(pairs[7], { oldPath: 'src/f7.js', path: 'lib/f7.js' });
});

test('pairs identical files by name before falling back to any identical file', () => {
  assert.deepEqual(pairRenames(
    [file('a/index.js', 'same\n'), file('b/other.js', 'same\n')],
    [file('c/other.js', 'same\n'), file('c/index.js', 'same\n')],
  ), [
    { oldPath: 'b/other.js', path: 'c/other.js' },
    { oldPath: 'a/index.js', path: 'c/index.js' },
  ]);
});

test('pairs the remaining files by similarity after exact matches are taken', () => {
  assert.deepEqual(pairRenames(
    [file('exact', lines(1, 2, 3)), file('edited', lines(4, 5, 6, 7))],
    [file('moved-exact', lines(1, 2, 3)), file('moved-edited', lines(4, 5, 6, 8))],
  ), [
    { oldPath: 'exact', path: 'moved-exact' },
    { oldPath: 'edited', path: 'moved-edited' },
  ]);
});
