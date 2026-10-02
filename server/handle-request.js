import path from 'node:path';
import { isInsideWorktree, formatChangeEvent, formatWorktreeListEvent, formatPollErrorEvent } from './route-logic.js';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

// A same-origin check for state-changing requests. No CORS opt-in: cross-site
// HTML forms cannot set custom headers or a JSON content type. Fetch metadata
// also excludes sibling origins, and Origin must match Host.
const crossOrigin = (headers, protocol) => !headers.host || (headers['sec-fetch-site'] && headers['sec-fetch-site'] !== 'same-origin') ||
  (headers.origin && headers.origin !== `${protocol}//${headers.host}`);

// Request handling as a function from a request description to a response
// description, with no `req`/`res`, server or port involved. The caller
// (app.js) translates between Node's HTTP objects and these descriptions.
//
// Request: `{ method, pathname, searchParams, headers, protocol }`.
// Response: `{ status, headers, body }` where `body` is a string/Buffer (or
// undefined for HEAD), or `{ status, headers, stream }` for server-sent
// events, where `stream.subscribe(write)` starts pushing frames through
// `write` and returns the cleanup to run when the connection closes.
// A HEAD request for an SSE route gets the headers and no `stream`.
//
// Dependencies: `getWorktrees`, `getTree`, `getContent`, `getCommits`,
// `watchWorktree(worktreePath, onChange, { onStatusChange })`, `subscribeToWorktreeChanges`,
// `readStatic(filePath)` and `publicDir`.
export function createRequestHandler({
  getWorktrees,
  getTree,
  getContent,
  getCommits,
  getComments,
  createComment,
  watchWorktree,
  subscribeToWorktreeChanges,
  subscribeToActivity,
  readStatic,
  publicDir,
  worktreeDeletion,
}) {
  return async function handleRequest({ method, pathname, searchParams, headers = {}, protocol = 'http:', body }) {
    const isReadable = method === 'GET' || method === 'HEAD';
    const includeBody = method !== 'HEAD';
    const ignoreGitignore = searchParams.get('ignoreGitignore') !== 'false';
    const json = (status, body) => jsonResponse(status, body, { includeBody });
    const noStoreJson = (status, payload) => {
      const response = json(status, payload);
      response.headers['Cache-Control'] = 'no-store';
      return response;
    };

    // Reject missing and unknown worktrees before any route operates on a
    // path. Returns `{ worktreePath }` or `{ error }` (a ready response).
    // file-content uses a different missing-param message to preserve its API.
    const resolveWorktree = async (missingError = 'Missing "worktree" query param') => {
      const worktreePath = searchParams.get('worktree');
      if (!worktreePath) return { error: json(400, { error: missingError }) };

      const worktrees = await getWorktrees();
      if (!worktrees.some((worktree) => worktree.path === worktreePath)) {
        return { error: json(404, { error: 'Unknown worktree' }) };
      }
      return { worktreePath };
    };

    async function handleWorktreeDeletion() {
      const { worktreePath, error } = await resolveWorktree();
      if (error) return error;
      if (method === 'DELETE') {
        if (!headers['x-canopy-confirmation'] || typeof headers['x-canopy-confirmation'] !== 'string' ||
            crossOrigin(headers, protocol)) {
          return noStoreJson(403, { error: 'Same-origin request with confirmation header required' });
        }
      }
      try {
        const result = method === 'DELETE'
          ? await worktreeDeletion.remove(worktreePath, headers['x-canopy-confirmation'])
          : await worktreeDeletion.preview(worktreePath);
        return noStoreJson(200, result);
      } catch (err) {
        return noStoreJson(err.status ?? 500, { error: err.message, removed: err.removed === undefined ? false : err.removed,
          branchDeleted: err.branchDeleted ?? false, branch: err.branch ?? null });
      }
    }

    async function handleCommentCreation() {
      const { worktreePath, error } = await resolveWorktree();
      if (error) return error;
      if (crossOrigin(headers, protocol) || !/^application\/json\b/i.test(headers['content-type'] ?? '')) {
        return noStoreJson(403, { error: 'Same-origin JSON request required' });
      }
      let input;
      try { input = JSON.parse(body ?? ''); } catch { return noStoreJson(400, { error: 'Invalid JSON body' }); }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return noStoreJson(400, { error: 'Invalid JSON body' });
      try {
        return noStoreJson(201, await createComment(worktreePath, input));
      } catch (err) {
        return noStoreJson(err.status ?? 500, { error: err.status ? err.message : 'Could not save comment',
          conflict: err.conflict ?? false, revision: err.revision ?? null });
      }
    }

    if (pathname === '/api/worktree-deletion' && (isReadable || method === 'DELETE')) {
      return handleWorktreeDeletion();
    }

    if (pathname === '/api/comments' && method === 'POST') {
      return handleCommentCreation();
    }

    if (!isReadable) return jsonResponse(404, { error: 'Not found' });

    if (pathname === '/api/worktrees') {
      return json(200, await getWorktrees());
    }

    if (pathname === '/api/comments') {
      const { worktreePath, error } = await resolveWorktree();
      if (error) return error;
      return noStoreJson(200, await getComments(worktreePath));
    }

    if (pathname === '/api/files') {
      const { worktreePath, error } = await resolveWorktree();
      if (error) return error;

      return json(200, await getTree(worktreePath, searchParams.get('ref') || 'HEAD'));
    }

    if (pathname === '/api/watch') {
      const { worktreePath, error } = await resolveWorktree();
      if (error) return error;

      // Server-sent events: a one-way push channel is all a change
      // notification needs (README: "pushes change events to the
      // frontend"), and it rides plain HTTP/GET, so it needs no extra
      // dependency or upgrade handshake the way WebSocket would.
      //
      // One watcher per connection, scoped to that connection's worktree:
      // the client re-opens this connection (closing the old one) when it
      // switches worktrees, so tearing down is all the re-scoping this MVP
      // needs (see server/watcher.js's header comment).
      return sseResponse(includeBody, (write) => {
        const watcher = watchWorktree(worktreePath, (paths) => write(formatChangeEvent(paths)), {
          ignoreGitignore,
          onStatusChange: () => write('event: status-invalidated\ndata: {}\n\n'),
        });
        return () => watcher.close();
      });
    }

    if (pathname === '/api/watch-worktrees') {
      // A separate, worktree-independent SSE channel from `/api/watch`
      // above: the worktree list itself isn't scoped to any one worktree,
      // so it's opened once for the app's lifetime rather than re-opened
      // per active worktree (#12).
      return sseResponse(includeBody, (write) =>
        subscribeToWorktreeChanges({
          onChange: (worktreeList) => write(formatWorktreeListEvent(worktreeList)),
          onError: (err) => write(formatPollErrorEvent(err)),
        })
      );
    }

    if (pathname === '/api/watch-activity') {
      return sseResponse(includeBody, (write) => subscribeToActivity(
        (timestamps) => write(`data: ${JSON.stringify(timestamps)}\n\n`), { ignoreGitignore }
      ));
    }

    if (pathname === '/api/file-content') {
      const missingError = 'Missing "worktree" or "file" query param';
      const filePath = searchParams.get('file');
      if (!filePath) return json(400, { error: missingError });

      const { worktreePath, error } = await resolveWorktree(missingError);
      if (error) return error;

      // The old path of a renamed file, whose ref side is read from there.
      const oldPath = searchParams.get('oldFile');

      // Defense in depth: keep the resolved paths inside the worktree even
      // though callers are expected to pass paths from /api/files.
      if (![filePath, oldPath].every((candidate) => !candidate || isInsideWorktree(worktreePath, candidate))) {
        return json(403, { error: 'Forbidden' });
      }

      const { head, working } = await getContent(
        worktreePath, filePath, searchParams.get('ref') || 'HEAD', oldPath ? { oldPath } : undefined,
      );
      if (head === null && working === null) return json(404, { error: 'Not found' });

      return json(200, { path: filePath, head, working });
    }

    if (pathname === '/api/commits') {
      const { worktreePath, error } = await resolveWorktree();
      if (error) return error;

      return json(200, await getCommits(worktreePath, searchParams.get('file') || null));
    }

    return serveStatic(pathname, { includeBody, readStatic, publicDir });
  };
}

async function serveStatic(pathname, { includeBody, readStatic, publicDir }) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(publicDir, relativePath);

  // Keep resolved paths inside publicDir (defense in depth; the URL parser
  // upstream already collapses `..` segments before we get here).
  if (!filePath.startsWith(publicDir)) return jsonResponse(403, { error: 'Forbidden' }, { includeBody });

  try {
    const data = await readStatic(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
    return {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Length': data.length },
      body: includeBody ? data : undefined,
    };
  } catch {
    return jsonResponse(404, { error: 'Not found' }, { includeBody });
  }
}

// HEAD: confirm the endpoint exists without opening a live watcher.
function sseResponse(includeBody, subscribe) {
  return includeBody
    ? { status: 200, headers: SSE_HEADERS, stream: { subscribe } }
    : { status: 200, headers: SSE_HEADERS, body: undefined };
}

function jsonResponse(status, body, { includeBody = true } = {}) {
  const payload = JSON.stringify(body);
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    },
    body: includeBody ? payload : undefined,
  };
}
