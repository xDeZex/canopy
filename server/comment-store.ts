import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { appendThread, appendReply, setThreadResolved, commentsRevision, validateNewThread, validateReply, validateResolution } from './comments.js';
import { SIDECAR, checkPath, defaultReadIo } from './sidecar-path.js';
import { errorDetails, isNewThreadInput, isReplyInput, isResolutionInput } from './comments.js';
import type { MutationResult } from './comments.js';
import type { ReadIo } from './sidecar-path.js';

export interface WriteIo extends ReadIo {
  mkdir(file: string, options: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options: { force: true }): Promise<void>;
  writeExclusive(file: string, data: string): Promise<void>;
}
export interface CommentStoreOptions { io?: WriteIo; newId?: () => string; now?: () => { toISOString(): string } }

const fail = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

function checkRevision(source: string | null, revision: string) {
  const latest = commentsRevision(source);
  if (latest !== revision) {
    throw fail(409, 'Comments changed since you loaded them. They were reloaded; review them and save again.',
      { conflict: true, revision: latest });
  }
}

// Sync before the rename so a crash cannot leave a renamed empty file.
async function writeExclusive(file: string, data: string) {
  const handle = await open(file, 'wx', 0o644);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const defaultIo: WriteIo = { ...defaultReadIo, mkdir, rename, rm, writeExclusive };

// The shared revision-checked mutation path for the sidecar. IO, ids and the
// clock are injected; the logic lives in comments.js. Mutations in this process are serialized per worktree;
// External edits during the temp write are caught by a final safe-path revision
// recheck. An external writer can still race between that recheck and rename;
// preventing that requires a cooperating lock or compare-and-swap protocol.
export function createCommentStore({ io = defaultIo, newId = randomUUID, now = () => new Date() }: CommentStoreOptions = {}) {
  const queues = new Map<string, Promise<void>>();

  async function readCurrent(root: string) {
    try {
      return await io.readFile(await checkPath(io, root, SIDECAR), 'utf8');
    } catch (error) {
      const err = errorDetails(error);
      if (err.code === 'ENOENT') return null;
      throw fail(409, `Cannot use comments file: ${err.message}`);
    }
  }

  async function save(worktreePath: string, { revision, ...input }: Record<string, unknown>) {
    const resolution = input.action === 'set-resolved';
    if (input.action !== undefined && !resolution) throw fail(400, 'Unknown comment action');
    if (!resolution && Object.hasOwn(input, 'resolved')) throw fail(400, 'Resolution requires the set-resolved action');
    const reply = !resolution && Object.hasOwn(input, 'threadId');
    const invalid = resolution ? validateResolution(input) : reply ? validateReply(input) : validateNewThread(input);
    if (invalid) throw fail(400, invalid);
    if (typeof revision !== 'string') throw fail(400, 'Missing comments revision');
    const root = await io.realpath(worktreePath);
    if (!reply && !resolution) {
      if (!isNewThreadInput(input)) throw fail(400, 'Invalid file path');
      try { await checkPath(io, root, input.file); }
      catch (error) { const err = errorDetails(error); throw fail(400, `File is unavailable: ${err.code === 'ENOENT' ? 'missing' : err.message}`); }
    }

    const source = await readCurrent(root);
    checkRevision(source, revision);
    let next: MutationResult;
    try {
      if (resolution && isResolutionInput(input)) next = setThreadResolved(source, input);
      else if (reply && isReplyInput(input)) next = appendReply(source, input, { messageId: `message-${newId()}`, createdAt: now().toISOString() });
      else if (isNewThreadInput(input)) next = appendThread(source, input, { threadId: `thread-${newId()}`, messageId: `message-${newId()}`, createdAt: now().toISOString() });
      else throw new Error('Invalid comment input');
    } catch (error) {
      const err = errorDetails(error);
      throw fail(409, `Refusing to modify the comments file: ${err.message}`);
    }

    const target = path.join(root, SIDECAR);
    const temp = `${target}.${newId()}.tmp`;
    await io.mkdir(path.dirname(target), { recursive: true });
    try {
      await io.writeExclusive(temp, next.source);
      checkRevision(await readCurrent(root), revision);
      await io.rename(temp, target);
    } catch (err) {
      await io.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
    return { thread: next.thread, revision: commentsRevision(next.source) };
  }

  return {
    create(worktreePath: string, input: Record<string, unknown>) {
      const previous = queues.get(worktreePath) ?? Promise.resolve();
      const run = previous.then(() => save(worktreePath, input));
      const tail = run.then(() => {}, () => {});
      queues.set(worktreePath, tail);
      tail.then(() => { if (queues.get(worktreePath) === tail) queues.delete(worktreePath); });
      return run;
    },
  };
}
