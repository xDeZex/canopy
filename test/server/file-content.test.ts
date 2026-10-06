import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingRefSide, isMissingWorkingSide, readFileContent } from '../../server/file-content.js';
import { fakeGit, type GitCall } from './fake-git.js';

const errWithCode = (code: string | number) => Object.assign(new Error('boom'), { code });

test('a git show exit of 128 can mean the ref side is missing', () => {
  assert.equal(isMissingRefSide(errWithCode(128)), true);
});

test('other git show failures are real errors for the ref side', () => {
  assert.equal(isMissingRefSide(errWithCode(1)), false);
  assert.equal(isMissingRefSide(errWithCode('ENOENT')), false); // git binary missing
  assert.equal(isMissingRefSide(errWithCode('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')), false);
  assert.equal(isMissingRefSide(new Error('no code')), false);
});

test('ENOENT and ENOTDIR mean the working side is missing', () => {
  assert.equal(isMissingWorkingSide(errWithCode('ENOENT')), true);
  assert.equal(isMissingWorkingSide(errWithCode('ENOTDIR')), true);
});

test('other fs failures are real errors for the working side', () => {
  assert.equal(isMissingWorkingSide(errWithCode('EACCES')), false);
  assert.equal(isMissingWorkingSide(errWithCode('EISDIR')), false);
  assert.equal(isMissingWorkingSide(new Error('no code')), false);
});

test('readFileContent reads a resolvable lock outside HEAD history using its resolved SHA', async () => {
  const shown: GitCall[] = [];
  const read: string[] = [];
  const result = await readFileContent('/wt', 'src/a.txt', 'outside-history', {
    runGit: async (args, cwd) => {
      shown.push({ args, cwd });
      if (args[0] === 'rev-parse') return 'abcdef1234567890\n';
      return 'old\n';
    },
    readWorkingFile: async (absolutePath) => {
      read.push(absolutePath);
      return 'new\n';
    },
  });

  assert.deepEqual(result, { head: 'old\n', working: 'new\n' });
  assert.deepEqual(shown, [
    { args: ['rev-parse', '--verify', '--end-of-options', 'outside-history^{commit}'], cwd: '/wt' },
    { args: ['show', 'abcdef1234567890:src/a.txt'], cwd: '/wt' },
  ]);
  assert.deepEqual(read, ['/wt/src/a.txt']);
});

test('an unresolvable locked ref rejects instead of pretending the base file is missing', async () => {
  const calls: GitCall[] = [];
  const invalidRef = errWithCode(128);
  await assert.rejects(readFileContent('/wt', 'a.txt', 'unresolvable', {
    runGit: async (args, cwd) => {
      calls.push({ args, cwd });
      throw invalidRef;
    },
    readWorkingFile: async () => 'working\n',
  }), (err) => err === invalidRef);
  assert.deepEqual(calls, [{
    args: ['rev-parse', '--verify', '--end-of-options', 'unresolvable^{commit}'], cwd: '/wt',
  }]);
});

test('a resolvable lock outside HEAD history can have a missing file without invalidating the base', async () => {
  const calls: string[][] = [];
  const result = await readFileContent('/wt', 'later.txt', 'outside-history', {
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return 'abcdef1234567890\n';
      if (args[0] === 'show') throw errWithCode(128);
      if (args[0] === 'ls-tree') return '';
      throw new Error(`unexpected Git request: ${args}`);
    },
    readWorkingFile: async () => 'added after the locked commit\n',
  });
  assert.deepEqual(result, { head: null, working: 'added after the locked commit\n' });
  assert.deepEqual(calls, [
    ['rev-parse', '--verify', '--end-of-options', 'outside-history^{commit}'],
    ['show', 'abcdef1234567890:later.txt'],
    ['ls-tree', '--full-tree', '-z', 'abcdef1234567890', '--', 'later.txt'],
  ]);
});

test('a locked file listed in the tree rethrows the original show failure', async () => {
  const showError = errWithCode(128);
  await assert.rejects(readFileContent('/wt', 'src/a.txt', 'outside-history', {
    runGit: async (args) => {
      if (args[0] === 'rev-parse') return 'abcdef1234567890\n';
      if (args[0] === 'show') throw showError;
      if (args[0] === 'ls-tree') return '100644 blob abcdef\tsrc/a.txt\0';
      throw new Error(`unexpected Git request: ${args}`);
    },
    readWorkingFile: async () => 'working\n',
  }), (err) => err === showError);
});

test('a failed tree lookup rejects even after the locked commit resolved', async () => {
  for (const code of [128, 'ENOENT']) {
    const lookupError = errWithCode(code);
    await assert.rejects(readFileContent('/wt', 'src/a.txt', 'outside-history', {
      runGit: async (args) => {
        if (args[0] === 'rev-parse') return 'abcdef1234567890\n';
        if (args[0] === 'show') throw errWithCode(128);
        if (args[0] === 'ls-tree') throw lookupError;
        throw new Error(`unexpected Git request: ${args}`);
      },
      readWorkingFile: async () => 'working\n',
    }), (err) => err === lookupError);
  }
});

test('locked path confirmation is rooted, NUL-delimited, and option-safe', async () => {
  for (const filePath of ['src/a file\n.txt', '--name-only']) {
    const calls: GitCall[] = [];
    const showError = errWithCode(128);
    await assert.rejects(readFileContent('/wt', filePath, 'outside-history', {
      runGit: async (args, cwd) => {
        calls.push({ args, cwd });
        if (args[0] === 'rev-parse') return 'abcdef1234567890\n';
        if (args[0] === 'show') throw showError;
        if (args[0] === 'ls-tree') return `100644 blob abcdef\t${filePath}\0`;
        throw new Error(`unexpected Git request: ${args}`);
      },
      readWorkingFile: async () => 'working\n',
    }), (err) => err === showError);
    assert.deepEqual(calls, [
      { args: ['rev-parse', '--verify', '--end-of-options', 'outside-history^{commit}'], cwd: '/wt' },
      { args: ['show', `abcdef1234567890:${filePath}`], cwd: '/wt' },
      { args: ['ls-tree', '--full-tree', '-z', 'abcdef1234567890', '--', filePath], cwd: '/wt' },
    ]);
  }
});

test('readFileContent defaults the ref to HEAD', async () => {
  let shown: string[] | undefined;
  await readFileContent('/wt', 'a.txt', undefined, {
    runGit: async (args) => {
      shown = args;
      return '';
    },
    readWorkingFile: async () => '',
  });

  assert.deepEqual(shown, ['show', 'HEAD:a.txt']);
});

test('readFileContent maps a missing ref side or working side to null', async () => {
  const result = await readFileContent('/wt', 'a.txt', 'HEAD', {
    runGit: async () => { throw errWithCode(128); },
    readWorkingFile: async () => 'new\n',
  });
  assert.deepEqual(result, { head: null, working: 'new\n' });

  for (const code of ['ENOENT', 'ENOTDIR']) {
    const deleted = await readFileContent('/wt', 'a.txt', 'HEAD', {
      runGit: async () => 'old\n',
      readWorkingFile: async () => { throw errWithCode(code); },
    });
    assert.deepEqual(deleted, { head: 'old\n', working: null });
  }
});

test('readFileContent rethrows errors that are not a missing side', async () => {
  await assert.rejects(
    readFileContent('/wt', 'a.txt', 'HEAD', {
      runGit: async () => { throw errWithCode('ENOENT-git-missing'); },
      readWorkingFile: async () => '',
    }),
    { code: 'ENOENT-git-missing' },
  );
  await assert.rejects(
    readFileContent('/wt', 'a.txt', 'HEAD', {
      runGit: async () => '',
      readWorkingFile: async () => { throw errWithCode('EACCES'); },
    }),
    { code: 'EACCES' },
  );
});

test('readFileContent reads the ref side from the old path of a renamed file', async () => {
  const shown: (string | undefined)[] = [];
  const result = await readFileContent('/wt', 'new.txt', 'HEAD', {
    oldPath: 'old.txt',
    runGit: async (args) => { shown.push(args.at(-1)); return 'same\n'; },
    readWorkingFile: async (absolutePath) => (absolutePath === '/wt/new.txt' ? 'same\n' : 'wrong'),
  });
  assert.deepEqual(shown, ['HEAD:old.txt']);
  assert.deepEqual(result, { head: 'same\n', working: 'same\n' });
});

test('comparison loading preserves the large stdout limit at the Git edge', async () => {
  const { runGit, calls } = fakeGit({ show: 'reference\n' });
  assert.deepEqual(await readFileContent('/wt', 'a.txt', 'HEAD', {
    runGit, readWorkingFile: async () => 'working\n',
  }), { head: 'reference\n', working: 'working\n' });
  assert.deepEqual(calls, [{
    args: ['show', 'HEAD:a.txt'], cwd: '/wt', options: { maxBuffer: 33554432 },
  }]);
});

test('comparison loading preserves Git failures other than a missing HEAD side', async () => {
  for (const code of [1, 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
    const failure = errWithCode(code);
    const { runGit, calls } = fakeGit({ show: failure });
    await assert.rejects(readFileContent('/wt', 'a.txt', 'HEAD', {
      runGit, readWorkingFile: async () => 'working\n',
    }), (err) => err === failure);
    assert.deepEqual(calls.map(({ args }) => args), [['show', 'HEAD:a.txt']]);
  }
});

test('comparison loading preserves unreadable working-side failures, even with a missing reference side', async () => {
  for (const code of ['EACCES', 'EISDIR']) {
    const failure = errWithCode(code);
    const { runGit } = fakeGit({ show: errWithCode(128) });
    await assert.rejects(readFileContent('/wt', 'a.txt', 'HEAD', {
      runGit, readWorkingFile: async () => { throw failure; },
    }), (err) => err === failure);
  }
});

test('comparison loading represents two missing sides as null, not empty strings', async () => {
  const { runGit } = fakeGit({ show: errWithCode(128) });
  assert.deepEqual(await readFileContent('/wt', 'a.txt', 'HEAD', {
    runGit, readWorkingFile: async () => { throw errWithCode('ENOENT'); },
  }), { head: null, working: null });
});
