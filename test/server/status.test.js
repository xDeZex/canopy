import test from 'node:test';
import assert from 'node:assert/strict';
import { getChangedPaths, getFileTree, parseStatus, parseNameStatus, parseUntracked, combineRefDiff, mergeFileStatuses, listChangedFiles, nestIntoTree, buildFileTree } from '../../server/status.js';

test('parses NUL-delimited diff names including a rename, copy and deletion', () => {
  assert.deepEqual(parseNameStatus('R100\0old name -> original\nfile\0new name -> destination\nfile\0C100\0source\0copy\0D\0gone\0A\0new\0M\0changed\0'), [
    { path: 'new name -> destination\nfile', status: 'renamed', oldPath: 'old name -> original\nfile' },
    { path: 'copy', status: 'modified' },
    { path: 'gone', status: 'deleted' },
    { path: 'new', status: 'added' },
    { path: 'changed', status: 'modified' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('parses NUL-delimited diff names with spaces, staged and unstaged alike', () => {
  assert.deepEqual(parseNameStatus('A\0my new file.txt\0M\0dir name/with space.txt\0'), [
    { path: 'my new file.txt', status: 'added' },
    { path: 'dir name/with space.txt', status: 'modified' },
  ]);
});

test('parses NUL-delimited untracked paths as added, spaces included', () => {
  assert.deepEqual(parseUntracked('untracked.txt\0dir/with space.txt\0'), [
    { path: 'untracked.txt', status: 'added' },
    { path: 'dir/with space.txt', status: 'added' },
  ]);
  assert.deepEqual(parseUntracked(''), []);
});

test('combineRefDiff lists diff entries followed by untracked additions', () => {
  assert.deepEqual(combineRefDiff('R100\0old.txt\0new.txt\0D\0gone.txt\0M\0changed.txt\0', 'untracked.txt\0'), [
    { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' },
    { path: 'gone.txt', status: 'deleted' },
    { path: 'changed.txt', status: 'modified' },
    { path: 'untracked.txt', status: 'added' },
  ]);
  assert.deepEqual(combineRefDiff('', ''), []);
});

test('parses a modified tracked file', () => {
  assert.deepEqual(parseStatus(' M server/app.js\0'), [
    { path: 'server/app.js', status: 'modified' },
  ]);
});

test('parses an untracked file as added', () => {
  assert.deepEqual(parseStatus('?? server/status.js\0'), [
    { path: 'server/status.js', status: 'added' },
  ]);
});

test('parses a staged new file as added', () => {
  assert.deepEqual(parseStatus('A  server/status.js\0'), [
    { path: 'server/status.js', status: 'added' },
  ]);
});

test('parses a deleted file', () => {
  assert.deepEqual(parseStatus(' D server/old.js\0'), [
    { path: 'server/old.js', status: 'deleted' },
  ]);
});

test('parses a NUL-delimited rename destination first without interpreting path characters', () => {
  assert.deepEqual(parseStatus('R  new dir/new -> name\n.js\0old dir/old -> name\n.js\0 M next.js\0'), [
    { path: 'new dir/new -> name\n.js', status: 'renamed', oldPath: 'old dir/old -> name\n.js' },
    { path: 'next.js', status: 'modified' },
  ]);
});

test('parses multiple NUL records', () => {
  const output = [' M server/app.js', '?? server/status.js', ''].join('\0');

  assert.deepEqual(parseStatus(output), [
    { path: 'server/app.js', status: 'modified' },
    { path: 'server/status.js', status: 'added' },
  ]);
});

test('porcelain copies and deleted rename destinations keep ordinary statuses and consume their source records', () => {
  assert.deepEqual(parseStatus('C  copy name.js\0source.js\0RD removed.js\0old.js\0AD added then deleted.js\0?? literal -> name\n.js\0RM edited rename.js\0original.js\0'), [
    { path: 'copy name.js', status: 'modified' },
    { path: 'removed.js', status: 'deleted' },
    { path: 'added then deleted.js', status: 'deleted' },
    { path: 'literal -> name\n.js', status: 'added' },
    { path: 'edited rename.js', status: 'renamed', oldPath: 'original.js' },
  ]);
});

test('returns an empty array for empty output', () => {
  assert.deepEqual(parseStatus(''), []);
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

test('rename metadata reaches the changed list and tree without removing a current source file', () => {
  const merged = mergeFileStatuses(
    ['server/new.js', 'server/old.js', 'server/other.js'],
    [{ ...parseStatus('R  server/new.js\0server/old.js\0')[0], mtimeMs: 1234 }]
  );

  assert.deepEqual(merged, [
    { path: 'server/new.js', status: 'renamed', oldPath: 'server/old.js', mtimeMs: 1234 },
    { path: 'server/old.js', status: 'clean' },
    { path: 'server/other.js', status: 'clean' },
  ]);
  assert.deepEqual(listChangedFiles(merged), [
    { path: 'server/new.js', status: 'renamed', oldPath: 'server/old.js', mtimeMs: 1234 },
  ]);
  assert.deepEqual(nestIntoTree(merged), [{
    name: 'server', type: 'dir', path: 'server', children: [
      { name: 'new.js', type: 'file', path: 'server/new.js', status: 'renamed', oldPath: 'server/old.js', mtimeMs: 1234 },
      { name: 'old.js', type: 'file', path: 'server/old.js', status: 'clean' },
      { name: 'other.js', type: 'file', path: 'server/other.js', status: 'clean' },
    ],
  }]);
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

test('buildFileTree keeps a deleted tracked child when its directory is replaced by an untracked file', () => {
  assert.deepEqual(
    buildFileTree(['foo/bar.txt'], [{ path: 'foo/bar.txt', status: 'deleted' }, { path: 'foo', status: 'added' }]),
    [
      {
        name: 'foo', type: 'dir', path: 'foo', children: [
          { name: 'bar.txt', type: 'file', path: 'foo/bar.txt', status: 'deleted' },
        ],
      },
      { name: 'foo', type: 'file', path: 'foo', status: 'added' },
    ]
  );
});

// A fake runGit keyed by git subcommand; records every call's args and cwd.
function fakeGit(responses) {
  const calls = [];
  const runGit = async (args, cwd) => {
    calls.push({ args, cwd });
    const response = responses[args[0]];
    if (response instanceof Error) throw response;
    return response;
  };
  return { runGit, calls };
}

test('getChangedPaths on HEAD parses `git status --porcelain -z` in the worktree', async () => {
  const { runGit, calls } = fakeGit({ status: ' M modified.txt\0?? new.txt\0' });

  assert.deepEqual(await getChangedPaths('/wt', 'HEAD', runGit), [
    { path: 'modified.txt', status: 'modified' },
    { path: 'new.txt', status: 'added' },
  ]);
  assert.deepEqual(calls, [{ args: ['status', '--porcelain', '-z', '--untracked-files=all'], cwd: '/wt' }]);
});

test('getChangedPaths against a ref diffs the resolved sha and appends untracked files', async () => {
  const { runGit, calls } = fakeGit({
    'rev-parse': 'abc123\n',
    diff: 'A\0later.txt\0',
    'ls-files': 'untracked.txt\0',
  });

  assert.deepEqual(await getChangedPaths('/wt', 'v1', runGit), [
    { path: 'later.txt', status: 'added' },
    { path: 'untracked.txt', status: 'added' },
  ]);
  assert.deepEqual(calls[0].args, ['rev-parse', '--verify', '--end-of-options', 'v1^{commit}']);
  assert.deepEqual(calls.find(({ args }) => args[0] === 'diff').args,
    ['diff', '--no-ext-diff', '--name-status', '-z', 'abc123', '--']);
  assert.ok(calls.every(({ cwd }) => cwd === '/wt'));
});

test('getChangedPaths rejects, without diffing, when the ref does not resolve', async () => {
  const { runGit, calls } = fakeGit({ 'rev-parse': new Error('bad revision') });

  await assert.rejects(getChangedPaths('/wt', '--output=/tmp/nope', runGit), /bad revision/);
  assert.equal(calls.length, 1);
});

test('getFileTree merges tracked files with changed-path statuses', async () => {
  const { runGit } = fakeGit({
    status: ' M src/a.js\0',
    'ls-files': 'README.md\0src/a.js\0',
  });

  assert.deepEqual(await getFileTree('/wt', 'HEAD', runGit, async () => { throw new Error('ENOENT'); }), [
    { name: 'src', type: 'dir', path: 'src', children: [
      { name: 'a.js', type: 'file', path: 'src/a.js', status: 'modified' },
    ] },
    { name: 'README.md', type: 'file', path: 'README.md', status: 'clean' },
  ]);
});

test('getFileTree adds saved edit times only to changed files present on disk', async () => {
  const { runGit } = fakeGit({
    status: ' M src/edit.js\0?? new.txt\0 D old.txt\0',
    'ls-files': 'clean.txt\0src/edit.js\0old.txt\0',
  });
  const checked = [];
  const stat = async (path) => {
    checked.push(path);
    return { mtimeMs: path.endsWith('edit.js') ? 1234 : 5678 };
  };

  assert.deepEqual(await getFileTree('/wt', 'HEAD', runGit, stat), [
    { name: 'src', type: 'dir', path: 'src', children: [
      { name: 'edit.js', type: 'file', path: 'src/edit.js', status: 'modified', mtimeMs: 1234 },
    ] },
    { name: 'clean.txt', type: 'file', path: 'clean.txt', status: 'clean' },
    { name: 'new.txt', type: 'file', path: 'new.txt', status: 'added', mtimeMs: 5678 },
    { name: 'old.txt', type: 'file', path: 'old.txt', status: 'deleted' },
  ]);
  assert.deepEqual(checked.sort(), ['/wt/new.txt', '/wt/src/edit.js']);
});

test('getFileTree keeps changed files when their edit time cannot be read', async () => {
  const { runGit } = fakeGit({ status: ' M missing.txt\0?? present.txt\0', 'ls-files': 'missing.txt\0' });
  const stat = async (path) => {
    if (path.endsWith('missing.txt')) throw new Error('ENOENT');
    return { mtimeMs: 900 };
  };

  assert.deepEqual(await getFileTree('/wt', 'HEAD', runGit, stat), [
    { name: 'missing.txt', type: 'file', path: 'missing.txt', status: 'modified' },
    { name: 'present.txt', type: 'file', path: 'present.txt', status: 'added', mtimeMs: 900 },
  ]);
});
