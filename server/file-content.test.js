import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingRefSide, isMissingWorkingSide, readFileContent } from './file-content.js';

const errWithCode = (code) => Object.assign(new Error('boom'), { code });

test('a git show exit of 128 means the ref side is missing', () => {
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

test('readFileContent shows the file at the ref and reads the working file', async () => {
  const shown = [];
  const read = [];
  const result = await readFileContent('/wt', 'src/a.txt', 'abc123', {
    runGit: async (args, cwd) => {
      shown.push({ args, cwd });
      return 'old\n';
    },
    readWorkingFile: async (absolutePath) => {
      read.push(absolutePath);
      return 'new\n';
    },
  });

  assert.deepEqual(result, { head: 'old\n', working: 'new\n' });
  assert.deepEqual(shown.map(({ args, cwd }) => ({ args, cwd })), [{ args: ['show', 'abc123:src/a.txt'], cwd: '/wt' }]);
  assert.deepEqual(read, ['/wt/src/a.txt']);
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
