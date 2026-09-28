// The one place that spawns `git`. Every module that needs git takes a
// `runGit(args, cwd, options)` parameter defaulting to this, so tests can
// pass a fake that returns canned stdout instead.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runGit(args, cwd, options = {}) {
  const { stdout } = await execFileAsync('git', args, { cwd, ...options });
  return stdout;
}
