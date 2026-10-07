import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createListWorktrees, defaultDeps } from './default-deps.js';
import { pollWorktrees } from './worktree-watch.js';
import { createFanOut } from './fan-out.js';
import { createRequestHandler, WorktreeUnavailableError, type RequestDependencies, type WorktreeChanges, type PollError } from './handle-request.js';
import { createActivityFeed } from './worktree-activity.js';
import { createWorktreeDeletion } from './worktree-delete.js';
import { createCommentLoader } from './comment-loader.js';
import { createCommentStore } from './comment-store.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const input: unknown = value;
    if (!Buffer.isBuffer(input) && typeof input !== 'string') return undefined;
    const chunk = typeof input === 'string' ? Buffer.from(input) : input;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Creates the Canopy HTTP server. `repoRoot` is the git repo to inspect;
// `listWorktrees`, `getFileTree`, `getFileContent`, `listCommits`, and
// `watchWorktree` can be injected to bypass the real `git`/filesystem-
// watching calls. An injected `listCommits(worktreePath, file)` receives the
// open file (or null) and should set `touchesFile` on each commit only when
// a file is given (see `markTouching`).
export type AppOptions = {
  repoRoot?: string;
  listWorktrees?: RequestDependencies['getWorktrees'];
  listDeletionWorktrees?: RequestDependencies['getDeletionWorktrees'];
  statWorktree?: RequestDependencies['statWorktree'];
  getFileTree?: RequestDependencies['getTree'];
  getFileContent?: RequestDependencies['getContent'];
  listCommits?: RequestDependencies['getCommits'];
  getComments?: RequestDependencies['getComments'];
  createComment?: RequestDependencies['createComment'];
  watchWorktree?: RequestDependencies['watchWorktree'];
  watchWorktreeList?: (onChange: WorktreeChanges, options: { onError: PollError }) => { close: () => void };
  activityFeed?: { subscribe: RequestDependencies['subscribeToActivity'] };
  worktreeDeletion?: RequestDependencies['worktreeDeletion'];
  readStatic?: RequestDependencies['readStatic'];
};

export function createApp({
  repoRoot = process.cwd(),
  listWorktrees,
  listDeletionWorktrees,
  statWorktree,
  getFileTree,
  getFileContent,
  listCommits,
  getComments = createCommentLoader(),
  createComment = createCommentStore().create,
  watchWorktree = defaultDeps.watchWorktree,
  watchWorktreeList,
  activityFeed,
  worktreeDeletion,
  readStatic = readFile,
}: AppOptions = {}) {
  const getWorktrees: RequestDependencies['getWorktrees'] = listWorktrees ?? createListWorktrees(repoRoot);

  // Defaults to polling `getWorktrees` itself (see worktree-watch.js for why
  // polling rather than a filesystem watch), so an injected `listWorktrees`
  // fake is also what drives this channel in tests.
  const watchWorktrees: NonNullable<AppOptions['watchWorktreeList']> =
    watchWorktreeList ?? ((onChange, options) => pollWorktrees(getWorktrees, onChange, {
      onError: (error: unknown) => {
        const message = error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message : String(error);
        options.onError({ message });
      },
    }));

  // Shares one poll across every open `/api/watch-worktrees` connection.
  const subscribeToWorktreeChanges: RequestDependencies['subscribeToWorktreeChanges'] = createFanOut(watchWorktrees);
  const activity: NonNullable<AppOptions['activityFeed']> = activityFeed ?? createActivityFeed(getWorktrees);

  const getTree: RequestDependencies['getTree'] = getFileTree ?? defaultDeps.getFileTree;
  const getContent: RequestDependencies['getContent'] = getFileContent ?? defaultDeps.getFileContent;
  const getCommits: RequestDependencies['getCommits'] = listCommits ?? defaultDeps.listCommits;

  const handleRequest = createRequestHandler({
    getWorktrees,
    // Deletion assesses Git registrations, including prunable paths that are
    // no longer usable for browsing. Keep its existing safety checks intact.
    getDeletionWorktrees: listDeletionWorktrees ?? listWorktrees ?? createListWorktrees(repoRoot, undefined, { includeMissing: true }),
    statWorktree,
    getTree,
    getContent,
    getCommits,
    getComments,
    createComment,
    watchWorktree,
    subscribeToWorktreeChanges,
    subscribeToActivity: (callback, options) => activity.subscribe(callback, options),
    readStatic,
    publicDir: PUBLIC_DIR,
    worktreeDeletion: worktreeDeletion ?? createWorktreeDeletion(repoRoot),
  });

  // Translates between Node's `req`/`res` and the pure request handler.
  return createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
      // Rejecting an oversized body can detach req.socket during iteration.
      const protocol = 'encrypted' in req.socket && req.socket.encrypted ? 'https:' : 'http:';
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const response = await handleRequest({ method: req.method ?? 'GET', pathname, searchParams, headers: req.headers,
        protocol, body });

      if (response.stream) {
        // Subscribe before committing SSE headers: validation can still reject
        // a directory removed while the response was being awaited. Hold any
        // synchronous initial frames until the successful headers are flushed.
        const earlyFrames: string[] = [];
        let live = false;
        const cleanup = response.stream.subscribe((frame) => {
          if (live) res.write(frame);
          else earlyFrames.push(frame);
        });
        req.on('close', cleanup);
        res.writeHead(response.status, response.headers);
        // writeHead() alone only queues the status line/headers; without a
        // body write, Node won't put them on the wire until end() — which
        // never comes for a long-lived stream. Flush explicitly so the
        // client's connection is confirmed open right away.
        res.flushHeaders();
        live = true;
        for (const frame of earlyFrames) res.write(frame);
        return;
      }

      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (err) {
      const missingWorktree = err instanceof WorktreeUnavailableError;
      if (!missingWorktree) console.error(err);
      // Never attempt a second status line after a transport/write failure.
      if (res.headersSent) { res.destroy(); return; }
      const payload = JSON.stringify({ error: missingWorktree ? err.message : 'Internal server error' });
      res.writeHead(missingWorktree ? 404 : 500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    }
  });
}
