// The one place that spawns `git`. Every module that needs git takes a
// `runGit(args, cwd, options)` parameter defaulting to this, so tests can
// pass a fake that returns canned stdout instead.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitOptions } from './git-port.js';

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd: string, options: GitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, ...options });
  return stdout;
}
