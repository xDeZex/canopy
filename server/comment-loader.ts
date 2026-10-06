import { parseComments, commentsRevision, ABSENT_REVISION, errorDetails } from './comments.js';
import type { CommentThread } from './comments.js';
import type { ReadIo } from './sidecar-path.js';
import { SIDECAR, checkPath, defaultReadIo } from './sidecar-path.js';

export type LoadedThread = CommentThread & { unavailable?: string | null };
export interface LoadedComments { threads: LoadedThread[]; warning: string | null; revision: string | null }
export function createCommentLoader(io: ReadIo = defaultReadIo) {
  return async (worktreePath: string): Promise<LoadedComments> => {
    try {
      const root = await io.realpath(worktreePath);
      const sidecar = await checkPath(io, root, SIDECAR);
      const source = await io.readFile(sidecar, 'utf8');
      const result = parseComments(source);
      return { ...result, revision: commentsRevision(source), threads: await Promise.all(result.threads.map(async (thread) => {
        if (!('file' in thread)) return thread;
        let unavailable: string | null = null;
        try { await checkPath(io, root, thread.file); }
        catch (error) { const err = errorDetails(error); unavailable = err.code === 'ENOENT' ? 'Anchor file is missing' : `Anchor unavailable: ${err.message}`; }
        return { ...thread, unavailable };
      })) };
    } catch (error) {
      const err = errorDetails(error);
      return err.code === 'ENOENT'
        ? { threads: [], warning: null, revision: ABSENT_REVISION }
        : { threads: [], warning: `Cannot load comments: ${err.message}`, revision: null };
    }
  };
}
