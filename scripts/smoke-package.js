// Package lifecycle IO check, not part of npm test. Uses the current Node/npm.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { listFiles, root } from './build-inputs.js';
import { smokeCli } from './smoke-cli.js';

const npm = (args, cwd = root) => execFileSync('npm', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
});
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.packages[''].bin.canopy, metadata.bin.canopy.replace(/^\.\//, ''), 'Lock bin metadata must match compiled package entry');

const temporary = await mkdtemp('/tmp/opencode/canopy-package-');
try {
  const result = JSON.parse(npm(['pack', '--json', '--pack-destination', temporary]));
  assert.ok(Array.isArray(result) && result.length === 1);
  const packed = result[0];
  assert.equal(typeof packed.filename, 'string');
  assert.ok(Array.isArray(packed.files));
  const files = packed.files.map((file) => { assert.equal(typeof file.path, 'string'); return file.path; });
  for (const directory of ['server', 'public']) {
    for (const filename of await listFiles(directory)) {
      assert.ok(files.includes(`dist/${filename.replace(/\.ts$/, '.js')}`), `Missing packaged runtime: ${filename}`);
    }
  }
  assert.ok(files.every((filename) => !filename.startsWith('dist/test/') && !filename.startsWith('scripts/') &&
    !filename.startsWith('server/') && !filename.startsWith('public/') && !filename.endsWith('.ts')), 'Package leaked tests, source or build tools');
  const prefix = path.join(temporary, 'install');
  npm(['install', '--global', '--prefix', prefix, '--omit=dev', path.join(temporary, packed.filename)]);
  const bin = path.join(prefix, 'bin/canopy');
  assert.match(execFileSync(bin, ['--help'], { encoding: 'utf8', env: {
    ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
  } }), /Usage: canopy/);
  await smokeCli(bin, [], root);
  console.log(`Package smoke passed on ${process.version}: ${files.length} tarball entries; installed CLI/runtime and HTML/CSS/native ESM over HTTP`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
