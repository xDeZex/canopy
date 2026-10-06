import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { runGit } from './git.js';
import { parseWorktreeListZ } from './porcelain.js';
import type { Worktree, WorktreeZ } from './porcelain.js';
import type { Git } from './git-port.js';

interface Target { path: string; branch: string | null; head: string }
interface Samples {
  listing: string; indexFlags: string; sparse: string; staged: string;
  status: string; diff: string; cached: string; untracked: string;
  ignored: string; hashes: string; remotes: string; countOutput: string;
}
export interface DeletionPreview {
  path: string;
  branch: string | null;
  reason?: string;
  head?: string;
  confirmation?: string;
  hasUncommittedWork?: boolean;
  ignoredFileCount?: number;
  localOnlyCommitCount?: number;
  remoteCheck?: string;
}

function errorMessage(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : undefined;
}

// One owner for assessment and confirmed deletion. Git is the IO boundary;
// previews never fetch. Tokens are bound to the full assessed snapshot, path
// and branch, and signed with a per-server secret (not a client-chosen hash).
export function createWorktreeDeletion(repoRoot: string, git: Git = runGit, { secret = randomBytes(32) }: { secret?: Buffer } = {}) {
  let removing = false;
  const fingerprint = (snapshot: Target & Samples) => createHmac('sha256', secret).update(JSON.stringify(snapshot)).digest('hex');

  async function assess(worktreePath: string): Promise<DeletionPreview> {
    const listing = await git(['worktree', 'list', '--porcelain', '-z'], repoRoot);
    const worktrees = validatedWorktrees(listing);
    const worktree = worktrees.find(({ path }) => path === worktreePath);
    if (!worktree) throw failure(404, 'Unknown worktree');
    const branch = worktree.branch;
    const reason = worktreeDeletionReason(worktree, worktrees, repoRoot);
    if (reason) return { path: worktree.path, branch, reason };
    if (branch) await git(['check-ref-format', `refs/heads/${branch}`], repoRoot);
    const [indexFlags, sparse, staged] = await Promise.all([
      git(['ls-files', '-v', '-z'], worktree.path),
      git(['config', '--type=bool', '--default=false', '--get', 'core.sparseCheckout'], worktree.path),
      git(['ls-files', '--stage', '-z'], worktree.path),
    ]);
    const indexReason = hiddenIndexReason(indexFlags, sparse) || submoduleReason(staged);
    if (indexReason) return { path: worktree.path, branch, reason: indexReason };
    const head = (await git(['rev-parse', '--verify', 'HEAD'], worktree.path)).trim();
    if (!isSha(head)) throw failure(409, 'Cannot safely assess HEAD');
    const [status, diff, cached, untracked, ignored, remotes, countOutput] = await Promise.all([
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree.path),
      git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--'], worktree.path),
      git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--'], worktree.path),
      git(['ls-files', '--others', '--exclude-standard', '-z'], worktree.path),
      git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], worktree.path),
      git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/'], repoRoot),
      git(['rev-list', '--count', head, '--not', '--remotes'], worktree.path),
    ]);
    const extraFiles = extraFilePaths(untracked, ignored);
    const hashes = extraFiles.length ? await git(['hash-object', '--no-filters', '--', ...extraFiles], worktree.path) : '';
    const { preview, snapshot } = assessedSnapshot({ path: worktree.path, branch, head },
      { listing, indexFlags, sparse, staged, status, diff, cached, untracked, ignored, hashes, remotes, countOutput });
    return { ...preview, confirmation: fingerprint(snapshot) };
  }

  return {
    preview: assess,
    async remove(worktreePath: string, confirmation: string | null | undefined) {
      if (removing) throw failure(409, 'Another worktree deletion is in progress');
      removing = true;
      try {
        const preview = await assess(worktreePath);
        if (preview.reason) throw failure(403, preview.reason);
        if (!confirmation || confirmation !== preview.confirmation) throw failure(409, 'Worktree changed; preview and confirm again');
        try {
          await git(['worktree', 'remove', '--force', '--', preview.path], repoRoot);
        } catch (err) {
          throw Object.assign(failure(409, `Git removal failed; worktree may be partially removed. Local branch was not deleted: ${errorMessage(err)}`),
            { removed: null, branchDeleted: false, branch: preview.branch });
        }
        try {
          if (preview.branch) {
            const currentWorktrees = validatedWorktrees(await git(['worktree', 'list', '--porcelain', '-z'], repoRoot));
            if (currentWorktrees.some((worktree) => worktree.branch === preview.branch)) {
              throw new Error('Local branch is in use by another worktree');
            }
            // Compare-and-delete under Git's ref lock: never delete a newer
            // tip. Leave branch config intact; cleanup could race recreation.
            if (!preview.head) throw failure(409, 'Cannot safely assess HEAD');
            await git(['update-ref', '--no-deref', '-d', `refs/heads/${preview.branch}`, preview.head], repoRoot);
          }
        } catch (err) {
          throw Object.assign(failure(409, `Worktree removed, but local branch "${preview.branch}" was not deleted: ${errorMessage(err)}`),
            { removed: true, branchDeleted: false, branch: preview.branch });
        }
        return { removed: true, branchDeleted: Boolean(preview.branch), branch: preview.branch };
      } finally {
        removing = false;
      }
    },
  };
}

// Input order must be Git's order, before selectedFirst moves the running
// worktree to the front for display. Also used to label disabled UI controls.
export function worktreeDeletionReason(worktree: Pick<Worktree, 'path' | 'branch' | 'bare' | 'locked' | 'prunable'>, worktrees: readonly Pick<Worktree, 'path' | 'branch'>[], repoRoot: string) {
  if (worktree.path === worktrees[0]?.path) return 'Main worktree cannot be deleted';
  if (worktree.path === null) throw new TypeError('Worktree path must be a string');
  const runningRelativePath = path.relative(worktree.path, repoRoot);
  if (!runningRelativePath || (!runningRelativePath.startsWith(`..${path.sep}`) && runningRelativePath !== '..' && !path.isAbsolute(runningRelativePath))) {
    return 'Server is running in this worktree';
  }
  if (worktree.bare) return 'Bare worktree cannot be deleted';
  if (worktree.locked) return 'Locked worktree cannot be deleted';
  if (worktree.prunable) return 'Prunable worktree cannot be safely assessed';
  if (worktree.branch === 'main' || worktree.branch === 'master') return 'Protected branch cannot be deleted';
  if (worktree.branch && (!worktree.branch.length || worktree.branch.startsWith('-') || worktree.branch.includes('\0'))) return 'Invalid local branch';
  if (worktree.branch && worktrees.some((item) => item.path !== worktree.path && item.branch === worktree.branch)) return 'Local branch is in use by another worktree';
  return null;
}

function failure(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function hiddenIndexReason(indexFlags: string, sparse: string) {
  const records = nulRecords(indexFlags);
  if (records.some((record) => !/^[A-Za-z?] .+$/s.test(record))) throw failure(409, 'Cannot safely assess index flags');
  if (records.some((record) => /^[a-z]/.test(record))) return 'Worktree contains assume-unchanged files; deletion cannot safely assess hidden changes';
  if (records.some((record) => record.startsWith('S '))) return 'Worktree contains skip-worktree files; deletion cannot safely assess hidden changes';
  const enabled = sparse.trim();
  if (enabled !== 'true' && enabled !== 'false') throw failure(409, 'Cannot safely assess sparse-checkout configuration');
  return enabled === 'true' ? 'Sparse-checkout worktrees cannot be safely assessed for deletion' : null;
}

function nulRecords(output: string) {
  if (output && !output.endsWith('\0')) throw failure(409, 'Cannot safely assess malformed Git records');
  return output ? output.slice(0, -1).split('\0') : [];
}

function submoduleReason(staged: string) {
  const entries = nulRecords(staged).map((record) => record.match(/^([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t(.+)$/s));
  if (entries.some((entry) => !entry)) throw failure(409, 'Cannot safely assess index entries');
  return entries.some((entry) => entry?.[1] === '160000')
    ? 'Worktree contains submodules (gitlinks); deletion cannot safely assess their contents, even when unpopulated'
    : null;
}

function validatedWorktrees(listing: string): (WorktreeZ & { path: string })[] {
  const malformed = () => failure(409, 'Cannot safely assess malformed Git worktree listing');
  if (!listing || !listing.endsWith('\0\0')) throw malformed();
  const blocks = listing.slice(0, -2).split('\0\0');
  for (const block of blocks) {
    const keys = block.split('\0').map((field) => field.split(' ')[0]);
    if (keys.filter((key) => key === 'worktree').length !== 1 ||
        ['HEAD', 'branch', 'detached', 'bare'].some((key) => keys.filter((item) => item === key).length > 1)) throw malformed();
  }
  const worktrees = parseWorktreeListZ(listing);
  if (new Set(worktrees.map((worktree) => worktree.path)).size !== worktrees.length) throw malformed();
  return worktrees.map((worktree) => {
    if (!worktree.path || !path.isAbsolute(worktree.path) ||
        (!worktree.bare && !isSha(worktree.head)) ||
        (worktree.branchRef !== null && (!worktree.branchRef.startsWith('refs/heads/') || !worktree.branch)) ||
        (!worktree.bare && !worktree.branchRef && !worktree.detached) ||
        (worktree.branchRef && worktree.detached)) throw malformed();
    return { ...worktree, path: worktree.path };
  });
}

function isSha(value: string | null) {
  return value !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function extraFilePaths(untracked: string, ignored: string) {
  const files = [...new Set([...nulRecords(untracked), ...nulRecords(ignored)])];
  if (files.some((file) => !file || path.isAbsolute(file) || file.split('/').some((part) => part === '..' || part === '.'))) {
    throw failure(409, 'Cannot safely assess malformed Git file paths');
  }
  return files;
}

function assessedSnapshot(target: Target, samples: Samples) {
  const { status, ignored, untracked, hashes, countOutput } = samples;
  const fileHashes = hashes.trim().split('\n').filter(Boolean);
  if (fileHashes.length !== extraFilePaths(untracked, ignored).length || fileHashes.some((hash) => !isSha(hash))) {
    throw failure(409, 'Cannot safely assess untracked and ignored file contents');
  }
  const count = countOutput.trim();
  if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw failure(409, 'Cannot safely count local-only commits');
  return {
    preview: { ...target, hasUncommittedWork: status.length > 0,
      ignoredFileCount: nulRecords(ignored).length, localOnlyCommitCount: Number(count),
      remoteCheck: 'Locally known remote-tracking refs only; no fetch.' },
    snapshot: { ...target, ...samples },
  };
}
