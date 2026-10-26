// The production GitHub CLI boundary. Services require an injected runner so
// tests cannot accidentally fall through to authentication or network access.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export type Gh = (args: string[], cwd: string) => Promise<string>;

export const runGh: Gh = async (args, cwd) => {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};
