import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorktreeList } from './porcelain.js';

const execFileAsync = promisify(execFile);

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Creates the Canopy HTTP server. `repoRoot` is the git repo to inspect;
// `listWorktrees` can be injected to bypass the real `git` call.
export function createApp({ repoRoot = process.cwd(), listWorktrees } = {}) {
  const getWorktrees =
    listWorktrees ??
    (async () => {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
      });
      return parseWorktreeList(stdout);
    });

  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const isReadable = req.method === 'GET' || req.method === 'HEAD';
      const includeBody = req.method !== 'HEAD';

      if (isReadable && pathname === '/api/worktrees') {
        const worktrees = await getWorktrees();
        respondJson(res, 200, worktrees, { includeBody });
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
