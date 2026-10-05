// Run against a COMMITTED source snapshot: npm clones the Git URL, not the
// working tree. This check never creates a commit or changes the source repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { smokeCli } from './smoke-cli.js';

const [url, ...extra] = process.argv.slice(2);
assert.ok(url?.startsWith('git+file://') && extra.length === 0,
  'Usage: node scripts/smoke-git-install.js git+file:///absolute/path/to/committed/repository[#ref]');
const temporary = await mkdtemp('/tmp/opencode/canopy-git-install-');
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
try {
  // npm 10.8.2 leaks global/prefix config into its Git preparation install.
  // Pack from Git locally first, as documented, then install production output.
  execFileSync('npm', ['pack', url, '--pack-destination', temporary], { env, stdio: 'inherit' });
  const tarballs = (await readdir(temporary)).filter((filename) => filename.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'Git preparation must produce exactly one package');
  const prefix = path.join(temporary, 'install');
  execFileSync('npm', ['install', '--global', '--prefix', prefix, '--omit=dev', path.join(temporary, tarballs[0])], { env, stdio: 'inherit' });
  const installed = path.join(prefix, 'lib/node_modules/canopy');
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.bin.canopy.replace(/^\.\//, ''), 'dist/server/index.js');
  await access(path.join(installed, 'dist/public/index.html'));
  await access(path.join(installed, 'dist/public/styles.css'));
  await access(path.join(installed, 'dist/public/main.js'));
  await access(path.join(installed, 'dist/server/route-logic.js'));
  for (const omitted of ['dist/test', 'scripts', 'server', 'public', 'node_modules/typescript', 'node_modules/@types/node']) {
    await assert.rejects(access(path.join(installed, omitted)), { code: 'ENOENT' });
  }
  assert.match(execFileSync(path.join(prefix, 'bin/canopy'), ['--help'], { env, encoding: 'utf8' }), /Usage: canopy/);
  await smokeCli(path.join(prefix, 'bin/canopy'), [], path.resolve(import.meta.dirname, '..'));
  console.log(`Git-source prepare/install smoke passed on ${process.version}: installed CLI/runtime and HTML/CSS/native ESM over HTTP`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
