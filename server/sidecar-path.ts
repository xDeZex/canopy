import path from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';

export const SIDECAR = '.canopy/comments.yaml';

// IO stays at this boundary; anchors are checked, never read here.
export interface PathStat { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export interface ReadIo {
  realpath(file: string): Promise<string>;
  lstat(file: string): Promise<PathStat>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
}

async function readSidecar(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Sidecar is not a regular file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export const defaultReadIo: ReadIo = { lstat, realpath, readFile: readSidecar };

// Walks `relative` below `root`, requiring directories and a final regular
// file, and rejecting even internal symlinks: lstat also catches dangling
// links and avoids probing targets outside the registered root.
export async function checkPath(io: Pick<ReadIo, 'lstat'>, root: string, relative: string) {
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await io.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symlink anchors and sidecars are unavailable');
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error('Path is not a regular file or directory');
    }
  }
  return current;
}
