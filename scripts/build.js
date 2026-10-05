import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { checkInputs, isCode, listFiles, root, sourceDirectories } from './build-inputs.js';

// Disposable output: a deleted or renamed source must never survive a rebuild.
await rm(path.join(root, 'dist'), { recursive: true, force: true });
await checkInputs();
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')], { cwd: root, stdio: 'inherit' });
for (const directory of sourceDirectories) {
  for (const filename of await listFiles(directory)) {
    if (isCode(filename)) continue;
    const destination = path.join(root, 'dist', filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, filename), destination);
  }
}
