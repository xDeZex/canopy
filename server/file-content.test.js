import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingRefSide, isMissingWorkingSide } from './file-content.js';

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
