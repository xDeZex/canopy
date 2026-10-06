import assert from 'node:assert/strict';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { checkInputs, isCode, listFiles, root, sourceDirectories } from './build-inputs.js';

export async function build() {
  // Disposable output: a deleted or renamed source must never survive a rebuild.
  await rm(path.join(root, 'dist'), { recursive: true, force: true });
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const manifest = await checkInputs(program);
  const formatHost = {
    getCurrentDirectory: () => root, getCanonicalFileName: (filename) => filename, getNewLine: () => '\n',
  };
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, `TypeScript build failed.\n${ts.formatDiagnostics(diagnostics, formatHost)}`);
  const result = program.emit();
  assert.equal(result.diagnostics.length, 0, `TypeScript emit failed.\n${ts.formatDiagnostics(result.diagnostics, formatHost)}`);
  assert.equal(result.emitSkipped, false, 'TypeScript emission was skipped');
  for (const directory of sourceDirectories) {
    for (const filename of await listFiles(directory)) {
      if (isCode(filename)) continue;
      const destination = path.join(root, 'dist', filename);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, filename), destination);
    }
  }
  return manifest;
}
