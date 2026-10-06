// JSON is unknown at the network edge. These are consumed browser contracts,
// not a replacement for the server's Git or sidecar validation.
import type { CommentMessage, CommentThread } from './comment-dom.js';
import type { CommentsLoad } from './comments-after-load.js';
export interface WorkspaceWorktree {
  [key: string]: unknown;
  path: string | null;
  head?: string | null;
  branch?: string | null;
  originMainSha?: string | null;
  detached?: boolean;
  bare?: boolean;
  locked?: boolean;
  lockedReason?: string | null;
  prunable?: boolean;
  prunableReason?: string | null;
}

export interface WorkspaceFile {
  type: 'file'; path: string; name: string; status: string;
  oldPath?: string; mtimeMs?: number;
}
export interface WorkspaceDirectory {
  type: 'dir'; path: string; name: string; children: WorkspaceNode[];
}
export type WorkspaceNode = WorkspaceFile | WorkspaceDirectory;
// split() always produces a SHA field, even for malformed log lines. Later
// fields can be undefined and are then omitted by JSON serialization.
export interface WorkspaceCommit {
  sha: string; message?: string; date?: string;
  touchesFile?: boolean; isOriginMain?: boolean;
}
export interface FileContent { head: string | null; working: string | null }
export interface RequestOptions { method: 'POST'; headers: Record<string, string>; body: string }
export interface JsonResponse { ok: boolean; status?: number; json?(): Promise<unknown> }
export type WorkspaceFetch = (url: string, options?: RequestOptions) => Promise<JsonResponse>;
export type ActivitySnapshot = Record<string, number | null>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
}

export function parseFileContent(value: unknown): FileContent {
  if (!isRecord(value) || !(value.head === null || typeof value.head === 'string') ||
      !(value.working === null || typeof value.working === 'string')) throw new Error('Invalid file content response');
  return { head: value.head, working: value.working };
}

function isWorkspaceNode(value: unknown): value is WorkspaceNode {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.name !== 'string') return false;
  if (value.type === 'dir') return Array.isArray(value.children) && value.children.every(isWorkspaceNode);
  return value.type === 'file' && typeof value.status === 'string' &&
    (value.oldPath === undefined || typeof value.oldPath === 'string') &&
    (value.mtimeMs === undefined || (typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs)));
}

export function parseFileTree(value: unknown): WorkspaceNode[] {
  if (!Array.isArray(value) || !value.every(isWorkspaceNode)) throw new Error('Invalid file tree response');
  return value;
}

function isCommit(value: unknown): value is WorkspaceCommit {
  return isRecord(value) && typeof value.sha === 'string' && ['message', 'date'].every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    ['touchesFile', 'isOriginMain'].every((key) => value[key] === undefined || typeof value[key] === 'boolean');
}

export function parseCommits(value: unknown): WorkspaceCommit[] {
  if (!Array.isArray(value) || !value.every(isCommit)) throw new Error('Invalid commits response');
  return value;
}

function isMessage(value: unknown): value is CommentMessage {
  return isRecord(value) && typeof value.id === 'string' && typeof value.author === 'string' &&
    typeof value.text === 'string' && (value.created_at === undefined || typeof value.created_at === 'string');
}

function isThread(value: unknown): value is CommentThread {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.messages) || !value.messages.every(isMessage) ||
      !(value.created_at === undefined || typeof value.created_at === 'string') ||
      !(value.resolved === undefined || typeof value.resolved === 'boolean') ||
      !(value.unavailable === undefined || value.unavailable === null || typeof value.unavailable === 'string')) return false;
  if (!Object.hasOwn(value, 'file')) return !Object.hasOwn(value, 'line_range') && !Object.hasOwn(value, 'side');
  const range = value.line_range;
  return typeof value.file === 'string' && (value.side === undefined || value.side === 'modified') && isRecord(range) &&
    typeof range.start === 'number' && Number.isSafeInteger(range.start) && range.start >= 1 &&
    typeof range.end === 'number' && Number.isSafeInteger(range.end) && range.end >= range.start;
}

function isComments(value: unknown): value is CommentsLoad<CommentThread> {
  return isRecord(value) && Array.isArray(value.threads) && value.threads.every(isThread) &&
    (value.warning === undefined || value.warning === null || typeof value.warning === 'string') &&
    (value.revision === undefined || value.revision === null || typeof value.revision === 'string');
}

export function parseComments(value: unknown): CommentsLoad<CommentThread> {
  if (!isComments(value)) throw new Error('Invalid comments response');
  return value;
}

function isWorktree(value: unknown): value is WorkspaceWorktree {
  return isRecord(value) && (typeof value.path === 'string' || value.path === null) &&
    ['head', 'branch', 'originMainSha', 'lockedReason', 'prunableReason'].every((key) =>
      value[key] === undefined || value[key] === null || typeof value[key] === 'string') &&
    ['detached', 'bare', 'locked', 'prunable'].every((key) => value[key] === undefined || typeof value[key] === 'boolean');
}

export function parseWorktrees(value: unknown): WorkspaceWorktree[] {
  if (!Array.isArray(value) || !value.every(isWorktree)) throw new Error('Invalid worktrees response');
  return value;
}

export function parseChangedPaths(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.paths) || !value.paths.every((path: unknown): path is string => typeof path === 'string')) {
    throw new Error('Invalid changed paths event');
  }
  return value.paths;
}

function isActivity(value: unknown): value is ActivitySnapshot {
  return isRecord(value) && Object.values(value).every((time) => time === null || (typeof time === 'number' && Number.isFinite(time)));
}

export function parseActivity(value: unknown): ActivitySnapshot {
  if (!isActivity(value)) throw new Error('Invalid activity event');
  return value;
}

export function parsePollError(value: unknown): string {
  if (!isRecord(value) || typeof value.message !== 'string') throw new Error('Invalid worktree poll error event');
  return value.message;
}
