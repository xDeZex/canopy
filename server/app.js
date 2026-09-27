import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorktreeList } from './porcelain.js';
import { parseStatus, buildFileTree } from './status.js';
import { readFileContent } from './file-content.js';

const execFileAsync = promisify(execFile);

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Creates the Canopy HTTP server. `repoRoot` is the git repo to inspect;
// `listWorktrees` and `getFileTree` can be injected to bypass the real
// `git` calls.
export function createApp({ repoRoot = process.cwd(), listWorktrees, getFileTree, getFileContent } = {}) {
  const getWorktrees =
    listWorktrees ??
    (async () => {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
      });
      return parseWorktreeList(stdout);
    });

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

        const worktrees = await getWorktrees();
        const isKnownWorktree = worktrees.some((worktree) => worktree.path === worktreePath);
        if (!isKnownWorktree) {
          respondJson(res, 404, { error: 'Unknown worktree' }, { includeBody });
          return;
        }

        const tree = await getTree(worktreePath);
        respondJson(res, 200, tree, { includeBody });
        return;
      }

      if (isReadable && pathname === '/api/file-content') {
        const worktreePath = searchParams.get('worktree');
        const filePath = searchParams.get('file');
        if (!worktreePath || !filePath) {
          respondJson(res, 400, { error: 'Missing "worktree" or "file" query param' }, { includeBody });
          return;
        }

        const worktrees = await getWorktrees();
        const isKnownWorktree = worktrees.some((worktree) => worktree.path === worktreePath);
        if (!isKnownWorktree) {
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

        const { head, working } = await getContent(worktreePath, filePath);
        if (head === null && working === null) {
          respondJson(res, 404, { error: 'Not found' }, { includeBody });
          return;
        }

        respondJson(res, 200, { path: filePath, head, working }, { includeBody });
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
