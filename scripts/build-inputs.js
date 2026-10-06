import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export const root = path.resolve(import.meta.dirname, '..');
export const sourceDirectories = ['server', 'public', 'test'];
export const isCode = (filename) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(filename);

export async function listFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const filename = `${directory}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `Build inputs must not be symlinks: ${filename}`);
    return entry.isDirectory() ? listFiles(filename) : [filename];
  }));
  return nested.flat().sort();
}

// tsconfig.files is the explicit migration manifest. Imports must not sneak
// unlisted application code into the program, or leave new files unbuilt.
export async function checkInputs(program, extraInputs = []) {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.options.strict, true, 'Migrated TypeScript must remain strict');
  assert.equal(parsed.options.allowJs, true);
  assert.equal(parsed.options.checkJs, false, 'Remaining JS is explicitly untyped, not claimed as checked coverage');
  const files = (await Promise.all(sourceDirectories.map(listFiles))).flat().filter(isCode).sort();
  const manifest = parsed.fileNames.map((filename) => path.relative(root, filename).split(path.sep).join('/')).sort();
  assert.deepEqual(manifest, files, 'Update tsconfig.files explicitly: replace migrated JS entries with TS, never hide uncovered inputs');
  program ??= ts.createProgram(parsed.fileNames, parsed.options);
  const applicationInputs = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file))
    .map((file) => path.relative(root, file.fileName).split(path.sep).join('/')).sort();
  const expectedInputs = [...manifest, ...extraInputs.map((filename) => path.relative(root, path.resolve(root, filename)).split(path.sep).join('/'))].sort();
  assert.deepEqual(applicationInputs, expectedInputs, 'An import pulled unlisted code into the build');
  const javascript = manifest.filter((filename) => /\.[cm]?jsx?$/.test(filename)).length;
  // The pre-migration baseline was 94 JS inputs. This ceiling only decreases.
  assert.ok(javascript <= 25, 'JavaScript migration coverage must not grow');
  // Keep stdout available for npm pack --json during the prepare lifecycle.
  console.error(`Migration coverage: ${manifest.length - javascript} strict TS / ${javascript} temporary JS inputs (target: zero JS)`);
  return manifest;
}
