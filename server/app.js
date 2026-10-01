import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createListWorktrees, defaultDeps } from './default-deps.js';
import { pollWorktrees } from './worktree-watch.js';
import { createFanOut } from './fan-out.js';
import { createRequestHandler } from './handle-request.js';
import { createActivityFeed } from './worktree-activity.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Creates the Canopy HTTP server. `repoRoot` is the git repo to inspect;
// `listWorktrees`, `getFileTree`, `getFileContent`, `listCommits`, and
// `watchWorktree` can be injected to bypass the real `git`/filesystem-
// watching calls. An injected `listCommits(worktreePath, file)` receives the
// open file (or null) and should set `touchesFile` on each commit only when
// a file is given (see `markTouching`).
export function createApp({
  repoRoot = process.cwd(),
  listWorktrees,
  getFileTree,
  getFileContent,
  listCommits,
  watchWorktree = defaultDeps.watchWorktree,
  watchWorktreeList,
  activityFeed,
} = {}) {
  const getWorktrees = listWorktrees ?? createListWorktrees(repoRoot);

  // Defaults to polling `getWorktrees` itself (see worktree-watch.js for why
  // polling rather than a filesystem watch), so an injected `listWorktrees`
  // fake is also what drives this channel in tests.
  const watchWorktrees =
    watchWorktreeList ?? ((onChange, options) => pollWorktrees(getWorktrees, onChange, options));

  // Shares one poll across every open `/api/watch-worktrees` connection.
  const subscribeToWorktreeChanges = createFanOut(watchWorktrees);
  const activity = activityFeed ?? createActivityFeed(getWorktrees);

  const getTree = getFileTree ?? defaultDeps.getFileTree;
  const getContent = getFileContent ?? defaultDeps.getFileContent;
  const getCommits = listCommits ?? defaultDeps.listCommits;

  const handleRequest = createRequestHandler({
    getWorktrees,
    getTree,
    getContent,
    getCommits,
    watchWorktree,
    subscribeToWorktreeChanges,
    subscribeToActivity: (callback) => activity.subscribe(callback),
    readStatic: readFile,
    publicDir: PUBLIC_DIR,
  });

  // Translates between Node's `req`/`res` and the pure request handler.
  return createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      const response = await handleRequest({ method: req.method, pathname, searchParams });

      res.writeHead(response.status, response.headers);

      if (response.stream) {
        // writeHead() alone only queues the status line/headers; without a
        // body write, Node won't put them on the wire until end() — which
        // never comes for a long-lived stream. Flush explicitly so the
        // client's connection is confirmed open right away.
        res.flushHeaders();
        const cleanup = response.stream.subscribe((frame) => res.write(frame));
        req.on('close', cleanup);
        return;
      }

      res.end(response.body);
    } catch (err) {
      console.error(err);
      const payload = JSON.stringify({ error: 'Internal server error' });
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    }
  });
}
