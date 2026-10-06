import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchPolicy, type WatchPolicyOptions } from '../../server/watch-policy.js';

test('root ignore rules prune directories without reading inside them, while negations retain files', () => {
  const reads: string[] = [];
  const ignored = createWatchPolicy('/parent/.git/repo', {
    readFile: (file) => {
      reads.push(file);
      if (file === '/parent/.git/repo/.gitignore') return 'deps/\n*.log\n!keep.log\n';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    stat: (file) => {
      if (file.endsWith('/.gitignore')) return { isFile: () => true };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  assert.equal(ignored('/parent/.git/repo'), false, 'root is not excluded by parent names');
  assert.equal(ignored('deps', { isDirectory: () => true }), true);
  assert.equal(ignored('deps/deep/file'), true);
  assert.equal(ignored('error.log'), true);
  assert.equal(ignored('keep.log'), false);
  assert.equal(ignored('src/main.js'), false);
  assert.equal(ignored('.git/index'), true);
  assert.equal(ignored('/parent/.git/other/file'), false);
  assert.deepEqual(reads, ['/parent/.git/repo/.gitignore', '/parent/.git/repo/src/.gitignore']);
});

test('gitignore syntax matches case-sensitive names, escaped literals and recursive globs', () => {
  const ignored = createWatchPolicy('/wt', {
    readFile: (file) => file === '/wt/.gitignore' ? '# comment\nBUILD/\n**/generated/*.js\n\\#literal\n\\!literal\n' : '',
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  });
  assert.equal(ignored('build/file'), false);
  assert.equal(ignored('BUILD/file'), true);
  assert.equal(ignored('src/generated/output.js'), true);
  assert.equal(ignored('src/generated/output.ts'), false);
  assert.equal(ignored('#literal'), true);
  assert.equal(ignored('!literal'), true);
  assert.equal(ignored('comment'), false);
});

test('nested rules override ancestors only within their directory, and disabled mode reads no rules', () => {
  const files = new Map([
    ['/linked/.gitignore', '*.tmp\n/root-only\ncache/\n'],
    ['/linked/src/.gitignore', '!keep.tmp\n/local\n'],
  ]);
  const options: WatchPolicyOptions = {
    readFile: (file) => files.get(file) ?? '',
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  };
  const ignored = createWatchPolicy('/linked', options);
  assert.equal(ignored('src/drop.tmp'), true);
  assert.equal(ignored('src/keep.tmp'), false);
  assert.equal(ignored('other/keep.tmp'), true);
  assert.equal(ignored('src/local'), true);
  assert.equal(ignored('other/local'), false);
  assert.equal(ignored('root-only'), true);
  assert.equal(ignored('src/root-only'), false);
  assert.equal(ignored('cache', { isDirectory: () => false }), false, 'directory-only rules do not exclude files');
  assert.equal(ignored('cache', { isDirectory: () => true }), true);
  const all = createWatchPolicy('/linked', { ...options, ignoreGitignore: false,
    readFile: () => assert.fail('disabled mode reads no rules') });
  assert.equal(all('src/drop.tmp'), false);
  assert.equal(all('.git'), true, 'linked worktree .git file remains excluded');
  assert.equal(all('nested/.git/index'), true);
});

test('only regular root and nested gitignore files supply rules, never symlinks or other file types', () => {
  for (const type of ['symlink', 'directory', 'fifo']) {
    const reads: string[] = [];
    const ignored = createWatchPolicy('/wt', {
      stat: (file) => ({
        isFile: () => file === '/wt/.gitignore',
        isDirectory: () => type === 'directory' && file.endsWith('/.gitignore') && file !== '/wt/.gitignore',
        isSymbolicLink: () => type === 'symlink' && file.endsWith('/.gitignore') && file !== '/wt/.gitignore',
      }),
      readFile: (file) => { reads.push(file); return file === '/wt/.gitignore' ? '*.log\n' : '!keep.log\nexternal.txt\n'; },
    });
    assert.equal(ignored('src/keep.log'), true, 'outside rules cannot override root rules');
    assert.equal(ignored('src/external.txt'), false);
    assert.deepEqual(reads, ['/wt/.gitignore'], type);

    const rootLink = createWatchPolicy('/wt', {
      stat: () => ({ isFile: () => false, isSymbolicLink: () => true }),
      readFile: () => assert.fail('symlinked root rules must not be read'),
    });
    assert.equal(rootLink('external.txt'), false);
  }
});

test('unavailable rule files fail open with one diagnostic per cached failure, preserving other rules', (t) => {
  const diagnosticLog = t.mock.method(console, 'error', (..._args: unknown[]) => {});
  for (const operation of ['stat', 'read']) {
    for (const code of ['EACCES', 'EISDIR']) {
      const failure = Object.assign(new Error('rules unavailable'), { code });
      const failedFile = '/wt/src/.gitignore';
      let attempts = 0;
      const ignored = createWatchPolicy('/wt', {
        stat: (file) => {
          if (file === failedFile && operation === 'stat') { attempts++; throw failure; }
          return { isFile: () => true, isDirectory: () => false };
        },
        readFile: (file) => {
          if (file === failedFile) { attempts++; throw failure; }
          return file === '/wt/.gitignore' ? '*.log\n' : '';
        },
      });
      const before = diagnosticLog.mock.callCount();
      assert.equal(ignored('src/edit.txt'), false);
      assert.equal(ignored('src/another.txt'), false);
      assert.equal(ignored('src/error.log'), true, 'available root rules still apply');
      assert.equal(attempts, 1, 'failed configuration is cached until restart');
      assert.equal(diagnosticLog.mock.callCount(), before + 1);
      const diagnostic = diagnosticLog.mock.calls.at(-1)?.arguments;
      assert.ok(diagnostic);
      assert.ok(diagnostic.includes(failedFile));
      assert.ok(diagnostic.includes(failure));
    }
  }
});

test('missing and deleted paths retain cached root and nested ignore decisions without diagnostics', (t) => {
  const diagnosticLog = t.mock.method(console, 'error', () => {});
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const files = new Map([['/wt/.gitignore', 'deps/\n*.tmp\n'], ['/wt/src/.gitignore', '!keep.tmp\n']]);
    const reads: string[] = [];
    const ignored = createWatchPolicy('/wt', {
      stat: (file) => {
        if (files.has(file)) return { isFile: () => true };
        throw Object.assign(new Error('missing'), { code });
      },
      readFile: (file) => { reads.push(file); const contents = files.get(file); assert.ok(contents !== undefined); return contents; },
    });
    assert.equal(ignored('src/drop.tmp'), true);
    assert.equal(ignored('src/keep.tmp'), false);
    files.clear();
    assert.equal(ignored('src/drop.tmp'), true);
    assert.equal(ignored('src/keep.tmp'), false);
    assert.equal(ignored('deps/deep/deleted.txt'), true);
    assert.equal(ignored('other/deleted.txt'), false);
    assert.deepEqual(reads, ['/wt/.gitignore', '/wt/src/.gitignore']);
  }
  assert.equal(diagnosticLog.mock.callCount(), 0);
});

test('the comments sidecar and its directory stay watched even when gitignored', () => {
  for (const ignoreGitignore of [true, false]) {
    const ignored = createWatchPolicy('/wt', {
      ignoreGitignore, observeSidecar: true,
      readFile: (file) => file === '/wt/.gitignore' ? '.canopy/\n*.yaml\n' : '',
      stat: () => ({ isDirectory: () => false, isFile: () => true }),
    });
    assert.equal(ignored('.canopy', { isDirectory: () => true }), false);
    assert.equal(ignored('.canopy/comments.yaml'), false);
    assert.equal(ignored('.canopy/other.yaml'), ignoreGitignore, 'siblings keep the normal rules');
  }
});

test('without observeSidecar a gitignored sidecar follows the normal rules', () => {
  const ignored = createWatchPolicy('/wt', {
    readFile: (file) => file === '/wt/.gitignore' ? '.canopy/\n' : '',
    stat: () => ({ isDirectory: () => false, isFile: () => true }),
  });
  assert.equal(ignored('.canopy/comments.yaml'), true);
});
