import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { appendThread, commentsRevision, validateNewThread } from './comments.js';
import { SIDECAR, checkPath, defaultReadIo } from './sidecar-path.js';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// Sync before the rename so a crash cannot leave a renamed empty file.
async function writeExclusive(file, data) {
  const handle = await open(file, 'wx', 0o644);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const defaultIo = { ...defaultReadIo, mkdir, rename, rm, writeExclusive };

// The shared revision-checked mutation path for the sidecar. IO, ids and the
// clock are injected; the logic lives in comments.js. Mutations in this process are serialized per worktree;
// arbitrary external writers are only guarded by the revision recheck (see
// docs/review-comments.md).
export function createCommentStore({ io = defaultIo, newId = randomUUID, now = () => new Date() } = {}) {
  const queues = new Map();

  async function readCurrent(root) {
    try {
      return await io.readFile(await checkPath(io, root, SIDECAR), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw fail(409, `Cannot use comments file: ${err.message}`);
    }
  }

  async function save(worktreePath, { revision, ...input }) {
    const invalid = validateNewThread(input);
    if (invalid) throw fail(400, invalid);
    if (typeof revision !== 'string') throw fail(400, 'Missing comments revision');
    const root = await io.realpath(worktreePath);
    try { await checkPath(io, root, input.file); }
    catch (err) { throw fail(400, `File is unavailable: ${err.code === 'ENOENT' ? 'missing' : err.message}`); }

    const source = await readCurrent(root);
    const latest = commentsRevision(source);
    if (latest !== revision) {
      throw fail(409, 'Comments changed since you loaded them. They were reloaded; review them and save again.',
        { conflict: true, revision: latest });
    }
    let next;
    try {
      next = appendThread(source, input, { threadId: `thread-${newId()}`, messageId: `message-${newId()}`,
        createdAt: now().toISOString() });
    } catch (err) {
      throw fail(409, `Refusing to modify the comments file: ${err.message}`);
    }

    const target = path.join(root, SIDECAR);
    const temp = `${target}.${newId()}.tmp`;
    await io.mkdir(path.dirname(target), { recursive: true });
    try {
      await io.writeExclusive(temp, next.source);
      await io.rename(temp, target);
    } catch (err) {
      await io.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
    return { thread: next.thread, revision: commentsRevision(next.source) };
  }

  return {
    create(worktreePath, input) {
      const previous = queues.get(worktreePath) ?? Promise.resolve();
      const run = previous.then(() => save(worktreePath, input));
      const tail = run.catch(() => {});
      queues.set(worktreePath, tail);
      tail.then(() => { if (queues.get(worktreePath) === tail) queues.delete(worktreePath); });
      return run;
    },
  };
}
