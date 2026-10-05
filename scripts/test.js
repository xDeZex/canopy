import { spawnSync } from 'node:child_process';
import { checkInputs, root } from './build-inputs.js';

// Explicit compiled paths prevent Node discovering both source and output.
const manifest = await checkInputs();
const tests = manifest.filter((filename) => filename.startsWith('test/') && /\.test\.[jt]s$/.test(filename))
  .map((filename) => `dist/${filename.replace(/\.ts$/, '.js')}`);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
