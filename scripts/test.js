import { spawnSync } from 'node:child_process';
import { root } from './build-inputs.js';
import { build } from './build-project.js';

// Explicit compiled paths prevent Node discovering both source and output.
const manifest = await build();
const tests = manifest.filter((filename) => filename.startsWith('test/') && /\.test\.[jt]s$/.test(filename))
  .map((filename) => `dist/${filename.replace(/\.ts$/, '.js')}`);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
