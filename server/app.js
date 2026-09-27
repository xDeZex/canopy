import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorktreeList } from './porcelain.js';
import { parseStatus, buildFileTree } from './status.js';
import { readFileContent } from './file-content.js';
import { parseCommitLog, LOG_FORMAT } from './commits.js';
import { watchWorktree as watchWorktreeReal } from './watcher.js';
import { pollWorktrees } from './worktree-watch.js';

const execFileAsync = promisify(execFile);

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Creates the Canopy HTTP server. `repoRoot` is the git repo to inspect;
// `listWorktrees`, `getFileTree`, `getFileContent`, `listCommits`, and
// `watchWorktree` can be injected to bypass the real `git`/filesystem-
// watching calls.
export function createApp({
  repoRoot = process.cwd(),
  listWorktrees,
  getFileTree,
  getFileContent,
  listCommits,
  watchWorktree = watchWorktreeReal,
  watchWorktreeList,
} = {}) {
  const getWorktrees =
    listWorktrees ??
    (async () => {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
      });
      return parseWorktreeList(stdout);
    });

  // Defaults to polling `getWorktrees` itself (see worktree-watch.js for why
  // polling rather than a filesystem watch), so an injected `listWorktrees`
  // fake is also what drives this channel in tests.
  const watchWorktrees =
    watchWorktreeList ?? ((onChange, options) => pollWorktrees(getWorktrees, onChange, options));

  // Fans one underlying poll out to every open `/api/watch-worktrees`
  // connection instead of starting a new `watchWorktrees` (and, by default,
  // a new `git worktree list` poll loop) per connection: without this, each
  // open browser tab — or each EventSource auto-reconnect — would multiply
  // the poll's process-spawn cost indefinitely. The poll starts on the first
  // subscriber and stops when the last one disconnects.
  let worktreesFanOut = null;

  function subscribeToWorktreeChanges({ onChange, onError }) {
    if (!worktreesFanOut) {
      const subscribers = new Set();
      const poll = watchWorktrees(
        (worktreeList) => {
          for (const subscriber of subscribers) subscriber.onChange(worktreeList);
        },
        {
          onError: (err) => {
            for (const subscriber of subscribers) subscriber.onError?.(err);
          },
        }
      );
      worktreesFanOut = { poll, subscribers };
    }

    const subscriber = { onChange, onError };
    worktreesFanOut.subscribers.add(subscriber);

    return () => {
      worktreesFanOut.subscribers.delete(subscriber);
      if (worktreesFanOut.subscribers.size === 0) {
        worktreesFanOut.poll.close();
        worktreesFanOut = null;
      }
    };
  }

  const getTree =
    getFileTree ??
    (async (worktreePath) => {
      const [{ stdout: statusOut }, { stdout: lsOut }] = await Promise.all([
        execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: worktreePath,
        }),
        execFileAsync('git', ['ls-files'], { cwd: worktreePath }),
      ]);
      const trackedPaths = lsOut.split('\n').filter(Boolean);
      return buildFileTree(trackedPaths, parseStatus(statusOut));
    });

  const getContent = getFileContent ?? readFileContent;

  const getCommits =
    listCommits ??
    (async (worktreePath) => {
      try {
        const { stdout } = await execFileAsync('git', ['log', `--pretty=format:${LOG_FORMAT}`], {
          cwd: worktreePath,
        });
        return parseCommitLog(stdout);
      } catch {
        // `git log` exits non-zero for a repo with no commits yet; treat
        // that the same as "no commit history" rather than an error.
        return [];
      }
    });

  return createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      const isReadable = req.method === 'GET' || req.method === 'HEAD';
      const includeBody = req.method !== 'HEAD';

      if (isReadable && pathname === '/api/worktrees') {
        const worktrees = await getWorktrees();
        respondJson(res, 200, worktrees, { includeBody });
        return;
      }

      if (isReadable && pathname === '/api/files') {
        const worktreePath = searchParams.get('worktree');
        if (!worktreePath) {
          respondJson(res, 400, { error: 'Missing "worktree" query param' }, { includeBody });
          return;
        }

        if (!(await isKnownWorktree(getWorktrees, worktreePath))) {
          respondJson(res, 404, { error: 'Unknown worktree' }, { includeBody });
          return;
        }

        const tree = await getTree(worktreePath);
        respondJson(res, 200, tree, { includeBody });
        return;
      }

      if (isReadable && pathname === '/api/watch') {
        const worktreePath = searchParams.get('worktree');
        if (!worktreePath) {
          respondJson(res, 400, { error: 'Missing "worktree" query param' }, { includeBody });
          return;
        }

        if (!(await isKnownWorktree(getWorktrees, worktreePath))) {
          respondJson(res, 404, { error: 'Unknown worktree' }, { includeBody });
          return;
        }

        // Server-sent events: a one-way push channel is all a change
        // notification needs (README: "pushes change events to the
        // frontend"), and it rides plain HTTP/GET, so it needs no extra
        // dependency or upgrade handshake the way WebSocket would.
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (!includeBody) {
          // HEAD: confirm the endpoint exists without opening a live watcher.
          res.end();
          return;
        }

        // writeHead() alone only queues the status line/headers; without a
        // body write, Node won't put them on the wire until end() — which
        // never comes for a long-lived stream. Flush explicitly so the
        // client's connection is confirmed open right away.
        res.flushHeaders();

        const watcher = watchWorktree(worktreePath, (paths) => {
          res.write(`data: ${JSON.stringify({ paths })}\n\n`);
        });

        // One watcher per connection, scoped to that connection's worktree:
        // the client re-opens this connection (closing the old one) when it
        // switches worktrees, so tearing down here is all the re-scoping
        // this MVP needs (see server/watcher.js's header comment).
        req.on('close', () => {
          watcher.close();
        });
        return;
      }

      if (isReadable && pathname === '/api/watch-worktrees') {
        // A separate, worktree-independent SSE channel from `/api/watch`
        // above: the worktree list itself isn't scoped to any one worktree,
        // so it's opened once for the app's lifetime rather than re-opened
        // per active worktree (#12).
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (!includeBody) {
          res.end();
          return;
        }

        res.flushHeaders();

        const unsubscribe = subscribeToWorktreeChanges({
          onChange: (worktreeList) => {
            res.write(`data: ${JSON.stringify(worktreeList)}\n\n`);
          },
          onError: (err) => {
            res.write(`event: worktree-poll-error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
          },
        });

        req.on('close', () => {
          unsubscribe();
        });
        return;
      }

      if (isReadable && pathname === '/api/file-content') {
        const worktreePath = searchParams.get('worktree');
        const filePath = searchParams.get('file');
        if (!worktreePath || !filePath) {
          respondJson(res, 400, { error: 'Missing "worktree" or "file" query param' }, { includeBody });
          return;
        }

        if (!(await isKnownWorktree(getWorktrees, worktreePath))) {
          respondJson(res, 404, { error: 'Unknown worktree' }, { includeBody });
          return;
        }

        // Defense in depth: keep the resolved path inside the worktree even
        // though callers are expected to pass paths from /api/files.
        const worktreeRoot = path.resolve(worktreePath);
        const resolvedPath = path.resolve(worktreeRoot, filePath);
        if (resolvedPath !== worktreeRoot && !resolvedPath.startsWith(worktreeRoot + path.sep)) {
          respondJson(res, 403, { error: 'Forbidden' }, { includeBody });
          return;
        }

        const ref = searchParams.get('ref') || 'HEAD';
        const { head, working } = await getContent(worktreePath, filePath, ref);
        if (head === null && working === null) {
          respondJson(res, 404, { error: 'Not found' }, { includeBody });
          return;
        }

        respondJson(res, 200, { path: filePath, head, working }, { includeBody });
        return;
      }

      if (isReadable && pathname === '/api/commits') {
        const worktreePath = searchParams.get('worktree');
        if (!worktreePath) {
          respondJson(res, 400, { error: 'Missing "worktree" query param' }, { includeBody });
          return;
        }

        if (!(await isKnownWorktree(getWorktrees, worktreePath))) {
          respondJson(res, 404, { error: 'Unknown worktree' }, { includeBody });
          return;
        }

        const commits = await getCommits(worktreePath);
        respondJson(res, 200, commits, { includeBody });
        return;
      }

      if (isReadable) {
        await serveStatic(res, pathname, { includeBody });
        return;
      }

      respondJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error(err);
      respondJson(res, 500, { error: 'Internal server error' });
    }
  });
}

// Shared by the /api/files, /api/file-content, /api/commits, and /api/watch
// routes, each of which only accepts a `worktree` param that's one of the
// real (or injected) worktrees, to guard against operating on an arbitrary
// path.
async function isKnownWorktree(getWorktrees, worktreePath) {
  const worktrees = await getWorktrees();
  return worktrees.some((worktree) => worktree.path === worktreePath);
}

async function serveStatic(res, pathname, { includeBody = true } = {}) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  // Keep resolved paths inside PUBLIC_DIR (defense in depth; the URL parser
  // above already collapses `..` segments before we get here).
  if (!filePath.startsWith(PUBLIC_DIR)) {
    respondJson(res, 403, { error: 'Forbidden' }, { includeBody });
    return;
  }

  try {
    const data = await readFile(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
    res.end(includeBody ? data : undefined);
  } catch {
    respondJson(res, 404, { error: 'Not found' }, { includeBody });
  }
}

function respondJson(res, status, body, { includeBody = true } = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(includeBody ? payload : undefined);
}
