import { createHash } from 'node:crypto';
import { Document, parseDocument, visit, isNode } from 'yaml';
import { COMMENTS_HEADER } from './comments-header.js';

const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq']
  .map((name) => `tag:yaml.org,2002:${name}`));
export interface CommentMessage { id: string; author: 'user' | 'agent'; text: string; created_at: string }
interface Conversation { id: string; created_at: string; resolved: boolean; messages: CommentMessage[] }
export interface AnchoredThread extends Conversation { file: string; side: 'modified'; line_range: { start: number; end: number } }
export type CommentThread = Conversation | AnchoredThread;
interface Sidecar { version: 1; threads: CommentThread[] }
export interface NewThreadInput { file: string; line: number; endLine?: number; text: string }
export interface ReplyInput { threadId: string; text: string }
export interface ResolutionInput { threadId: string; resolved: boolean }
export interface ThreadIdentity { threadId: string; messageId: string; createdAt: string }
export interface MutationResult { thread: CommentThread; source: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function timestamp(value: unknown): value is string {
  if (!string(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) return false;
  // Date.parse normalizes February 30 instead of rejecting it.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1] && Number(value.slice(11, 13)) < 24;
}
const hasExactKeys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> => record(value) && Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const uniqueIds = (values: readonly { id: string }[]) => new Set(values.map((value) => value.id)).size === values.length;

export function validAnchorPath(file: unknown): file is string {
  return string(file) && !/[:\\\x00-\x1f\x7f]/.test(file) &&
    file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validMessage(message: unknown): message is CommentMessage {
  return hasExactKeys(message, ['id', 'author', 'text', 'created_at']) && string(message.id) &&
    (message.author === 'user' || message.author === 'agent') && typeof message.text === 'string' && timestamp(message.created_at);
}

function validThread(thread: unknown): thread is CommentThread {
  const common = ['id', 'created_at', 'resolved', 'messages'];
  const general = hasExactKeys(thread, common);
  const anchored = hasExactKeys(thread, [...common, 'file', 'side', 'line_range']) &&
    validAnchorPath(thread.file) && thread.side === 'modified' &&
    hasExactKeys(thread.line_range, ['start', 'end']) && typeof thread.line_range.start === 'number' && Number.isSafeInteger(thread.line_range.start) &&
    typeof thread.line_range.end === 'number' && Number.isSafeInteger(thread.line_range.end) && thread.line_range.start >= 1 &&
    thread.line_range.end >= thread.line_range.start;
  return record(thread) && (general || anchored) && string(thread.id) && timestamp(thread.created_at) &&
    typeof thread.resolved === 'boolean' && Array.isArray(thread.messages) && thread.messages.length > 0 &&
    thread.messages.every(validMessage) && uniqueIds(thread.messages);
}

// Validated version-1 document exactly as stored (no reordering), or a throw.
function parseSidecar(source: string): Sidecar {
  const doc = parseDocument(source, { schema: 'core', resolveKnownTags: false });
  if (doc.errors.length || doc.warnings.length) throw new Error('Malformed YAML or unsupported tag');
  visit(doc, (_key, node) => {
    if (isNode(node) && node.tag && !CORE_TAGS.has(node.tag)) throw new Error('Unsupported YAML tag');
  });
  const data: unknown = doc.toJS({ maxAliasCount: 100 });
  if (!hasExactKeys(data, ['version', 'threads']) || data.version !== 1 || !Array.isArray(data.threads) ||
      !data.threads.every(validThread) || !uniqueIds(data.threads)) throw new Error('Invalid version 1 schema');
  return { version: data.version, threads: data.threads };
}

export function parseComments(source: string): { warning: string | null; threads: CommentThread[] } {
  try {
    const data = parseSidecar(source);
    return { warning: null, threads: data.threads.map((thread) => ({ ...thread,
      messages: [...thread.messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    })).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)) };
  } catch (err) {
    return { threads: [], warning: `Cannot load comments: ${errorDetails(err).message}` };
  }
}

// The revision names the exact sidecar bytes a client has seen; an absent
// sidecar has its own revision so first saves are checked too.
export const ABSENT_REVISION = 'absent';
export const commentsRevision = (source: string | null) =>
  source === null ? ABSENT_REVISION : createHash('sha256').update(source).digest('hex');

export const MAX_COMMENT_LENGTH = 20000;

// Pure validation of a client's request for a new thread. `endLine` is the
// inclusive last line of a range and defaults to `line`.
export function validateNewThread({ file, line, endLine = line, text }: { file?: unknown; line?: unknown; endLine?: unknown; text?: unknown } = {}) {
  if (!validAnchorPath(file)) return 'Invalid file path';
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return 'Invalid line number';
  if (typeof endLine !== 'number' || !Number.isSafeInteger(endLine) || endLine < line) return 'Invalid end line number';
  if (typeof text !== 'string' || text.trim() === '') return 'Comment text is required';
  if (text.length > MAX_COMMENT_LENGTH) return `Comment text is limited to ${MAX_COMMENT_LENGTH} characters`;
  return null;
}

export function validateReply({ threadId, text }: { threadId?: unknown; text?: unknown } = {}) {
  if (!string(threadId)) return 'Thread id is required';
  if (typeof text !== 'string' || text.trim() === '') return 'Comment text is required';
  if (text.length > MAX_COMMENT_LENGTH) return `Comment text is limited to ${MAX_COMMENT_LENGTH} characters`;
  return null;
}

export function validateResolution({ threadId, resolved, text }: { threadId?: unknown; resolved?: unknown; text?: unknown } = {}) {
  if (!string(threadId)) return 'Thread id is required';
  if (typeof resolved !== 'boolean') return 'Resolved must be a boolean';
  if (text !== undefined) return 'Resolution cannot include a reply';
  return null;
}

// Caught IO/parser values are not necessarily Error instances.
export function errorDetails(error: unknown): Record<string, unknown> {
  return record(error) ? error : {};
}
export const isNewThreadInput = (input: Record<string, unknown>): input is Record<string, unknown> & NewThreadInput => validateNewThread(input) === null;
export const isReplyInput = (input: Record<string, unknown>): input is Record<string, unknown> & ReplyInput => validateReply(input) === null;
export const isResolutionInput = (input: Record<string, unknown>): input is Record<string, unknown> & ResolutionInput => validateResolution(input) === null;

// Timestamps are quoted so YAML 1.1 readers in external tools keep them strings.
function serialize(data: Sidecar) {
  const doc = new Document(data);
  visit(doc, { Scalar(_key, node) {
    if (typeof node.value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(node.value)) node.type = 'QUOTE_DOUBLE';
  } });
  return `${COMMENTS_HEADER}\n${doc.toString()}`;
}

// Appends a new user thread to the stored sidecar text and returns the new
// text plus the thread. Every existing thread and message is kept as stored.
// Throws when the existing text is not a valid version-1 document, so the
// caller refuses rather than replacing data it does not understand.
export function appendThread(source: string | null, { file, line, endLine = line, text }: NewThreadInput, { threadId, messageId, createdAt }: ThreadIdentity) {
  const data: Sidecar = source === null ? { version: 1, threads: [] } : parseSidecar(source);
  const thread: AnchoredThread = {
    id: threadId, file, side: 'modified', line_range: { start: line, end: endLine },
    created_at: createdAt, resolved: false,
    messages: [{ id: messageId, author: 'user', text, created_at: createdAt }],
  };
  if (data.threads.some((existing) => existing.id === threadId)) throw new Error('Duplicate thread id');
  return { thread, source: serialize({ version: 1, threads: [...data.threads, thread] }) };
}

// User replies always reopen the chosen conversation. Text has no bearing on
// resolution, and stored messages (including their order) remain untouched.
export function appendReply(source: string | null, { threadId, text }: ReplyInput, { messageId, createdAt }: Omit<ThreadIdentity, 'threadId'>) {
  const data: Sidecar = source === null ? { version: 1, threads: [] } : parseSidecar(source);
  const previous = data.threads.find((thread) => thread.id === threadId);
  if (!previous) throw new Error('Thread not found');
  if (previous.messages.some((message) => message.id === messageId)) throw new Error('Duplicate message id');
  const thread: CommentThread = { ...previous, resolved: false, messages: [...previous.messages,
    { id: messageId, author: 'user', text, created_at: createdAt }] };
  return { thread, source: serialize({ version: 1,
    threads: data.threads.map((existing) => existing.id === threadId ? thread : existing) }) };
}

// Resolution is an explicit flag change, never inferred from message text.
export function setThreadResolved(source: string | null, { threadId, resolved }: ResolutionInput) {
  const data: Sidecar = source === null ? { version: 1, threads: [] } : parseSidecar(source);
  const previous = data.threads.find((thread) => thread.id === threadId);
  if (!previous) throw new Error('Thread not found');
  const thread = { ...previous, resolved };
  return { thread, source: serialize({ version: 1,
    threads: data.threads.map((existing) => existing.id === threadId ? thread : existing) }) };
}
