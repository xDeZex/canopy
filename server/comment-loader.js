import { parseComments, commentsRevision, ABSENT_REVISION } from './comments.js';
import { SIDECAR, checkPath, defaultReadIo } from './sidecar-path.js';

export function createCommentLoader(io = defaultReadIo) {
  return async (worktreePath) => {
    try {
      const root = await io.realpath(worktreePath);
      const sidecar = await checkPath(io, root, SIDECAR);
      const source = await io.readFile(sidecar, 'utf8');
      const result = parseComments(source);
      return { ...result, revision: commentsRevision(source), threads: await Promise.all(result.threads.map(async (thread) => {
        if (!Object.hasOwn(thread, 'file')) return thread;
        let unavailable = null;
        try { await checkPath(io, root, thread.file); }
        catch (err) { unavailable = err.code === 'ENOENT' ? 'Anchor file is missing' : `Anchor unavailable: ${err.message}`; }
        return { ...thread, unavailable };
      })) };
    } catch (err) {
      return err.code === 'ENOENT'
        ? { threads: [], warning: null, revision: ABSENT_REVISION }
        : { threads: [], warning: `Cannot load comments: ${err.message}`, revision: null };
    }
  };
}
