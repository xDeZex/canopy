// Automated IO smoke, deliberately separate from the unit/integration suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { smokeCli } from './smoke-cli.js';

const root = path.resolve(import.meta.dirname, '..');
// A newly added source cannot silently miss compilation or bypass the JS list.
const unlisted = path.join(root, 'public', '.unlisted-build-probe.js');
await writeFile(unlisted, 'export const unlisted = true;', { flag: 'wx' });
try {
  assert.throws(() => execFileSync(process.execPath, ['scripts/check-inputs.js'], { cwd: root, stdio: 'pipe' }),
    (error) => String(error.stderr).includes('Update tsconfig.files explicitly'));
} finally {
  await rm(unlisted);
}
const staleFiles = ['server/removed-module.js', 'public/removed-module.js', 'test/removed.test.js']
  .map((filename) => path.join(root, 'dist', filename));
for (const stale of staleFiles) {
  await mkdir(path.dirname(stale), { recursive: true });
  await writeFile(stale, 'stale output');
}
execFileSync(process.execPath, ['scripts/build.js'], { cwd: root, stdio: 'inherit' });
for (const stale of staleFiles) await assert.rejects(access(stale), { code: 'ENOENT' });
for (const asset of ['index.html', 'styles.css']) {
  assert.deepEqual(await readFile(path.join(root, 'dist/public', asset)), await readFile(path.join(root, 'public', asset)));
}
assert.match(await readFile(path.join(root, 'dist/server/index.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
assert.match(execFileSync(process.execPath, ['dist/server/index.js', '--help'], { cwd: root, encoding: 'utf8' }), /Usage: canopy/);

await smokeCli(process.execPath, ['dist/server/index.js'], root);
console.log(`Build/CLI HTTP smoke passed on ${process.version}: unlisted-input rejection, stale cleanup, assets, HTML/CSS/native ESM`);
