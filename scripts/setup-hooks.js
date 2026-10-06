import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

try {
  const config = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
  if (config.error) throw config.error;
  if (config.status === 0) {
    throw new Error(`core.hooksPath is already configured (${config.stdout.trim()}). Keep your existing hook setup or explicitly remove that setting before retrying.`);
  }
  if (config.status !== 1) throw new Error(config.stderr.trim() || 'Could not inspect core.hooksPath.');

  const destination = path.resolve(root, git(['rev-parse', '--git-path', 'hooks/pre-push']));
  const source = await readFile(path.join(root, '.githooks/pre-push'));
  let existing;
  try {
    existing = await lstat(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (existing) {
    if (!existing.isFile() || !(await readFile(destination)).equals(source)) {
      throw new Error(`An existing pre-push hook at ${destination} was left unchanged. Integrate the checks into that hook manually.`);
    }
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, { flag: 'wx', mode: 0o755 });
  }
  await chmod(destination, 0o755);
  console.log(`Installed pre-push hook at ${destination}. Applies to this clone and its linked worktrees.`);
} catch (error) {
  console.error(`Could not install pre-push hook: ${error.message}`);
  process.exitCode = 1;
}
