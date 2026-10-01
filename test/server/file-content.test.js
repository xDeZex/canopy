import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingRefSide, isMissingWorkingSide, readFileContent } from '../../server/file-content.js';

const errWithCode = (code) => Object.assign(new Error('boom'), { code });

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
  const shown = [];
  const read = [];
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
  const calls = [];
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
  const calls = [];
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
    const calls = [];
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
  let shown;
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
