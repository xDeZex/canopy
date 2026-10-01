import path from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseComments } from './comments.js';

// IO stays at this boundary; anchors are checked, never read here.
async function readSidecar(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Sidecar is not a regular file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export function createCommentLoader(io = { lstat, realpath, readFile: readSidecar }) {
  async function check(root, relative) {
    const parts = relative.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = await io.lstat(current);
      // Reject even internal symlinks: lstat also catches dangling links and
      // avoids probing targets outside the registered root.
      if (stat.isSymbolicLink()) throw new Error('Symlink anchors and sidecars are unavailable');
      if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
        throw new Error('Path is not a regular file or directory');
      }
    }
    return current;
  }
  return async (worktreePath) => {
    try {
      const root = await io.realpath(worktreePath);
      const sidecar = await check(root, '.canopy/comments.yaml');
      const result = parseComments(await io.readFile(sidecar, 'utf8'));
      return { ...result, threads: await Promise.all(result.threads.map(async (thread) => {
        if (!Object.hasOwn(thread, 'file')) return thread;
        let unavailable = null;
        try { await check(root, thread.file); }
        catch (err) { unavailable = err.code === 'ENOENT' ? 'Anchor file is missing' : `Anchor unavailable: ${err.message}`; }
        return { ...thread, unavailable };
      })) };
    } catch (err) {
      return { threads: [], warning: err.code === 'ENOENT' ? null : `Cannot load comments: ${err.message}` };
    }
  };
}
