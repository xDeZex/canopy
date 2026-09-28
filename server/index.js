#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createApp } from './app.js';

const [target, ...extra] = process.argv.slice(2);

if (target === '--help' || target === '-h') {
  console.log('Usage: canopy <folder>\n\nOpen a Git repository or worktree in Canopy.');
  process.exit(0);
}

if (!target || extra.length > 0) {
  console.error('Usage: canopy <folder>\nExample: canopy .');
  process.exit(1);
}

let repoRoot;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: path.resolve(target),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!repoRoot) throw new Error('Not a Git worktree');
} catch {
  console.error(`Cannot open ${target}: expected a folder inside a Git worktree (Git must be installed).`);
  process.exit(1);
}

const PORT = process.env.PORT || 4173;

const server = createApp({ repoRoot });
server.listen(PORT, () => {
  console.log(`Canopy viewing ${repoRoot} at http://localhost:${PORT}`);
});
