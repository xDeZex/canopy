import test from 'node:test';
import assert from 'node:assert/strict';
import { getChangedPaths, getFileTree, parseStatus, parseNameStatus, parseUntracked, combineRefDiff, mergeFileStatuses, listChangedFiles, nestIntoTree, buildFileTree } from '../../server/status.js';
import type { PathStatus } from '../../server/status.js';
import { fakeGit } from './fake-git.js';
import { readFileContent } from '../../server/file-content.js';

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
    { path: 'untracked.txt', status: 'added', untracked: true },
    { path: 'dir/with space.txt', status: 'added', untracked: true },
  ]);
  assert.deepEqual(parseUntracked(''), []);
});

test('combineRefDiff lists diff entries followed by untracked additions', () => {
  assert.deepEqual(combineRefDiff('R100\0old.txt\0new.txt\0D\0gone.txt\0M\0changed.txt\0', 'untracked.txt\0'), [
    { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' },
    { path: 'gone.txt', status: 'deleted' },
    { path: 'changed.txt', status: 'modified' },
    { path: 'untracked.txt', status: 'added', untracked: true },
  ]);
  assert.deepEqual(combineRefDiff('', ''), []);
});

test('parses a modified tracked file', () => {
  assert.deepEqual(parseStatus(' M server/app.js\0'), [
    { path: 'server/app.js', status: 'modified' },
  ]);
});

test('parses an untracked file as added and tags it untracked', () => {
  assert.deepEqual(parseStatus('?? server/status.js\0'), [
    { path: 'server/status.js', status: 'added', untracked: true },
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
    { path: 'server/status.js', status: 'added', untracked: true },
  ]);
});

test('porcelain copies and deleted rename destinations keep ordinary statuses and consume their source records', () => {
  assert.deepEqual(parseStatus('C  copy name.js\0source.js\0RD removed.js\0old.js\0AD added then deleted.js\0?? literal -> name\n.js\0RM edited rename.js\0original.js\0'), [
    { path: 'copy name.js', status: 'modified' },
    { path: 'removed.js', status: 'deleted' },
    { path: 'added then deleted.js', status: 'deleted' },
    { path: 'literal -> name\n.js', status: 'added', untracked: true },
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
  const statuses: PathStatus[] = [
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
  assert.deepEqual(calls.find(({ args }) => args[0] === 'diff')?.args,
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
  const checked: string[] = [];
  const stat = async (path: string) => {
    checked.push(path);
    return { mtimeMs: path.endsWith('edit.js') ? 1234 : 5678 };
  };

  assert.deepEqual(await getFileTree('/wt', 'HEAD', runGit, stat, async () => { throw new Error('unreadable'); }), [
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
  const stat = async (path: string) => {
    if (path.endsWith('missing.txt')) throw new Error('ENOENT');
    return { mtimeMs: 900 };
  };

  assert.deepEqual(await getFileTree('/wt', 'HEAD', runGit, stat), [
    { name: 'missing.txt', type: 'file', path: 'missing.txt', status: 'modified' },
    { name: 'present.txt', type: 'file', path: 'present.txt', status: 'added', mtimeMs: 900 },
  ]);
});

test('getChangedPaths on HEAD pairs a deleted file with a similar untracked file as one rename', async () => {
  const content = 'one\ntwo\nthree\n';
  const { runGit, calls } = fakeGit({ status: ' D old.txt\0?? new.txt\0?? other.txt\0', show: content });
  const files = new Map([['/wt/new.txt', content], ['/wt/other.txt', 'unrelated\n']]);

  assert.deepEqual(await getChangedPaths('/wt', 'HEAD', runGit, async (path) => {
    const file = files.get(path);
    if (file === undefined) throw new Error(`Unexpected read: ${path}`);
    return file;
  }), [
    { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' },
    { path: 'other.txt', status: 'added' },
  ]);
  assert.deepEqual(calls.find(({ args }) => args[0] === 'show')?.args, ['show', 'HEAD:old.txt']);
});

test('getChangedPaths leaves unrelated deletions and additions unpaired', async () => {
  const { runGit } = fakeGit({ status: ' D old.txt\0?? new.txt\0', show: 'a\nb\nc\n' });

  assert.deepEqual(await getChangedPaths('/wt', 'HEAD', runGit, async () => 'x\ny\nz\n'), [
    { path: 'old.txt', status: 'deleted' },
    { path: 'new.txt', status: 'added' },
  ]);
});

test('getChangedPaths does not pair a staged addition with a deletion', async () => {
  const { runGit } = fakeGit({ status: ' D old.txt\0A  new.txt\0', show: 'a\nb\n' });

  assert.deepEqual(await getChangedPaths('/wt', 'HEAD', runGit, async () => 'a\nb\n'), [
    { path: 'old.txt', status: 'deleted' },
    { path: 'new.txt', status: 'added' },
  ]);
});

test('getChangedPaths against a ref pairs the deleted file with an untracked file', async () => {
  const { runGit, calls } = fakeGit({ 'rev-parse': 'abc123\n', diff: 'D\0old.txt\0', 'ls-files': 'new.txt\0', show: 'a\nb\n' });

  assert.deepEqual(await getChangedPaths('/wt', 'v1', runGit, async () => 'a\nb\n'), [
    { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' },
  ]);
  assert.deepEqual(calls.find(({ args }) => args[0] === 'show')?.args, ['show', 'abc123:old.txt']);
});

test('getChangedPaths does not pair a path deleted and recreated with itself', async () => {
  const { runGit } = fakeGit({ status: 'D  same.txt\0?? same.txt\0', show: 'a\nb\n' });

  assert.deepEqual(await getChangedPaths('/wt', 'HEAD', runGit, async () => 'a\nb\n'), [
    { path: 'same.txt', status: 'deleted' },
    { path: 'same.txt', status: 'added' },
  ]);
});

test('getChangedPaths pairs a staged deletion with an untracked file', async () => {
  const { runGit } = fakeGit({ status: 'D  old.txt\0?? new.txt\0', show: 'a\nb\n' });

  assert.deepEqual(await getChangedPaths('/wt', 'HEAD', runGit, async () => 'a\nb\n'), [
    { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' },
  ]);
});

test('getFileTree shows an unstaged move as one renamed file, not a renamed file plus a clean old path', async () => {
  const content = 'one\ntwo\nthree\n';
  const { runGit } = fakeGit({
    status: ' D old.txt\0?? new.txt\0',
    'ls-files': 'keep.txt\0old.txt\0',
    show: content,
  });

  assert.deepEqual(await getFileTree('/wt', 'HEAD', runGit, async () => ({ mtimeMs: 5678 }), async () => content), [
    { name: 'keep.txt', type: 'file', path: 'keep.txt', status: 'clean' },
    { name: 'new.txt', type: 'file', path: 'new.txt', status: 'renamed', oldPath: 'old.txt', mtimeMs: 5678 },
  ]);
});

test('tree loading rejects Git acquisition failures instead of returning a partial tree', async () => {
  for (const command of ['status', 'ls-files', 'diff']) {
    const failure = new Error(`${command} unavailable`);
    const { runGit } = fakeGit({
      status: '', 'ls-files': '', 'rev-parse': 'abc123\n', diff: '', [command]: failure,
    });
    await assert.rejects(getFileTree('/wt', command === 'diff' ? 'v1' : 'HEAD', runGit,
      async () => { throw new Error('Unexpected stat'); },
      async () => { throw new Error('Unexpected read'); }), (err) => err === failure);
  }
});

test('unreadable rename candidates keep separate deletion and addition statuses in the loaded tree', async () => {
  for (const unreadableSide of ['reference', 'working']) {
    const content = 'same\ncontent\n';
    const { runGit } = fakeGit({
      status: ' D src/old.txt\0?? lib/new.txt\0', 'ls-files': 'src/old.txt\0',
      show: unreadableSide === 'reference' ? new Error('show refused') : content,
    });
    const tree = await getFileTree('/wt', 'HEAD', runGit,
      async () => { throw new Error('stat refused'); },
      async () => {
        if (unreadableSide === 'working') throw new Error('read refused');
        return content;
      });
    assert.deepEqual(tree, [
      { name: 'lib', type: 'dir', path: 'lib', children: [
        { name: 'new.txt', type: 'file', path: 'lib/new.txt', status: 'added' },
      ] },
      { name: 'src', type: 'dir', path: 'src', children: [
        { name: 'old.txt', type: 'file', path: 'src/old.txt', status: 'deleted' },
      ] },
    ]);
  }
});

test('tree loading ignores non-finite stat times without losing changed status', async () => {
  for (const mtimeMs of [NaN, Infinity, -Infinity]) {
    const { runGit } = fakeGit({ status: ' M src/edit.txt\0', 'ls-files': 'src/edit.txt\0' });
    assert.deepEqual(await getFileTree('/wt', 'HEAD', runGit, async () => ({ mtimeMs })), [
      { name: 'src', type: 'dir', path: 'src', children: [
        { name: 'edit.txt', type: 'file', path: 'src/edit.txt', status: 'modified' },
      ] },
    ]);
  }
});

test('a locked loaded rename keeps its old reference path and current working path in comparison loading', async () => {
  const { runGit, calls } = fakeGit((args) => {
    if (args[0] === 'rev-parse') return 'abc123\n';
    if (args[0] === 'diff') return 'R100\0src/old.txt\0lib/new.txt\0M\0src/edit.txt\0';
    if (args[0] === 'ls-files') return args.includes('--others') ? 'notes/new.txt\0' : 'lib/new.txt\0src/edit.txt\0README.md\0';
    if (args[0] === 'show' && args[1] === 'abc123:src/old.txt') return 'reference\n';
    throw new Error(`Unexpected Git call: ${args.join(' ')}`);
  });
  const tree = await getFileTree('/wt', 'v1', runGit, async () => ({ mtimeMs: 1234 }),
    async () => { throw new Error('Unexpected rename-candidate read'); });
  assert.deepEqual(tree, [
    { name: 'lib', type: 'dir', path: 'lib', children: [
      { name: 'new.txt', type: 'file', path: 'lib/new.txt', status: 'renamed', oldPath: 'src/old.txt', mtimeMs: 1234 },
    ] },
    { name: 'notes', type: 'dir', path: 'notes', children: [
      { name: 'new.txt', type: 'file', path: 'notes/new.txt', status: 'added', mtimeMs: 1234 },
    ] },
    { name: 'src', type: 'dir', path: 'src', children: [
      { name: 'edit.txt', type: 'file', path: 'src/edit.txt', status: 'modified', mtimeMs: 1234 },
    ] },
    { name: 'README.md', type: 'file', path: 'README.md', status: 'clean' },
  ]);
  const directory = tree[0];
  assert.ok(directory?.type === 'dir');
  const renamed = directory.children[0];
  assert.ok(renamed?.type === 'file');
  const read: string[] = [];
  assert.deepEqual(await readFileContent('/wt', renamed.path, 'v1', {
    runGit, oldPath: renamed.oldPath,
    readWorkingFile: async (absolutePath) => { read.push(absolutePath); return 'working\n'; },
  }), { head: 'reference\n', working: 'working\n' });
  assert.deepEqual(read, ['/wt/lib/new.txt']);
  assert.deepEqual(calls.find(({ args }) => args[0] === 'show')?.args, ['show', 'abc123:src/old.txt']);
});
