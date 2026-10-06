import path from 'node:path';
import { readFileSync, lstatSync } from 'node:fs';
import ignore from 'ignore';
import { SIDECAR } from './sidecar-path.js';
import type { PathStat } from './sidecar-path.js';
import type { Ignore } from 'ignore';

export type WatchStats = Partial<PathStat> & { mtimeMs?: number };
export interface WatchPolicyOptions {
  ignoreGitignore?: boolean;
  observeSidecar?: boolean;
  readFile?: (file: string, encoding: 'utf8') => string;
  stat?: (file: string) => WatchStats & Pick<PathStat, 'isFile'>;
}
export type WatchPolicy = (filePath: string, stats?: WatchStats) => boolean;

// Kept for callers of the original bookkeeping predicate. Watch policies apply
// it only to paths relative to their worktree, never to parent directories.
export const IGNORE_GIT_DIR = /(^|[/\\])\.git([/\\]|$)/;

// Evaluate already-loaded ancestor rules in order, without filesystem access
// or policy-cache mutation. Later negations override earlier exclusions.
function excludedByAncestors(parts: string[], isDirectory: boolean, ancestors: { depth: number; rules: Ignore }[]) {
  return ancestors.reduce((excluded, { depth, rules }) => {
    const candidate = parts.slice(depth).join('/') + (isDirectory ? '/' : '');
    const result = rules.test(candidate);
    if (result.ignored) return true;
    if (result.unignored) return false;
    return excluded;
  }, false);
}

// Chokidar calls ignored before descending into directories. Load only the
// ancestor rules needed for that decision, and cache them for this watch's
// lifetime; restarting observation reloads edited .gitignore files.
export function createWatchPolicy(worktreePath: string, {
  ignoreGitignore = true, observeSidecar = false, readFile = readFileSync, stat = lstatSync,
}: WatchPolicyOptions = {}): WatchPolicy {
  const root = path.resolve(worktreePath);
  const rules = new Map<string, Ignore>();
  const reported = new Set<string>();
  // Missing paths are normal during deletes. Genuine IO failures are reported
  // once and fail open; they are not watcher failures that invalidate activity.
  function report(file: string, err: unknown) {
    const code = err !== null && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || reported.has(file)) return;
    reported.add(file);
    console.error('canopy: watch policy error', file, err);
  }
  function rulesAt(directory: string): Ignore {
    const cached = rules.get(directory);
    if (cached) return cached;
    const file = path.join(root, directory, '.gitignore');
    let contents = '';
    try {
      if (stat(file).isFile()) contents = readFile(file, 'utf8');
    }
    catch (err) { report(file, err); }
    const loaded = ignore({ ignorecase: false }).add(contents);
    rules.set(directory, loaded);
    return loaded;
  }

  return (filePath, stats) => {
    const normalized = filePath.replaceAll('\\', '/');
    const relative = path.relative(root, path.resolve(root, normalized)).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../')) return false;
    if (IGNORE_GIT_DIR.test(relative)) return true;
    // Conversations are edited by agents and may be gitignored; a content
    // watcher opts in to always observing the sidecar and its directory.
    if (observeSidecar && (relative === SIDECAR || relative === path.posix.dirname(SIDECAR))) return false;
    if (!ignoreGitignore) return false;
    if (typeof stats?.isDirectory !== 'function') {
      const file = path.join(root, relative);
      try { stats = stat(file); }
      catch (err) { report(file, err); }
    }
    const parts = relative.split('/');
    const ancestors = [];
    for (let index = 0; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/');
      ancestors.push({ depth: index, rules: rulesAt(directory) });
      const isDirectory = index < parts.length - 1 || stats?.isDirectory?.() === true;
      if (excludedByAncestors(parts.slice(0, index + 1), isDirectory, ancestors)) return true;
    }
    return false;
  };
}
