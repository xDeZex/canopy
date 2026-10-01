// Parses `git log`'s output (formatted with LOG_FORMAT below) into
// structured commits: sha, message (subject line), and an ISO commit date.
// Relative time ("3 hours ago") is a presentation concern and is derived
// client-side from the ISO date instead, since baking a live-relative
// string into a JSON response would go stale the moment it's cached.
//
// Field separator: ASCII unit separator (0x1f), which can't appear in a
// commit subject, so no escaping is needed. Git inserts a newline between
// commits automatically, with no trailing newline after the last one.

import { runGit as defaultRunGit } from './git.js';

export const LOG_FORMAT = '%H%x1f%s%x1f%cI';

export function parseCommitLog(output) {
  const trimmed = output.replace(/\r?\n$/, '');
  if (!trimmed) return [];

  return trimmed.split('\n').map((line) => {
    const [sha, message, date] = line.split('\x1f');
    return { sha, message, date };
  });
}

// Marks each commit with whether it appears in `touchingSha` (the shas from
// `git log -- <file>`). `touchesFile` is present only when a file was asked
// about: absent means "no file open, no marking", `false` means "didn't touch".
export function markTouching(commits, touchingSha) {
  const touched = new Set(touchingSha);
  return commits.map((commit) => ({ ...commit, touchesFile: touched.has(commit.sha) }));
}

// Flags the commit `origin/main` points at (`originSha`) so the client can draw
// a divider there. When origin/main is unknown or not in the listed history
// the commits come back unchanged: no marker rather than a wrong one.
export function markOriginMain(commits, originSha) {
  if (!commits.some((commit) => commit.sha === originSha)) return commits;
  return commits.map((commit) => ({ ...commit, isOriginMain: commit.sha === originSha }));
}

// Shas of commits that touched `file` (following renames), or null when the
// filter fails (e.g. a path outside the worktree): that must only cost the
// marking, never the commit list itself.
async function shasTouching(worktreePath, file, runGit) {
  try {
    const stdout = await runGit(['--literal-pathspecs', 'log', '--follow', '--pretty=format:%H', '--', file], worktreePath);
    return stdout.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

// Sha `origin/main` points at, or null when there is no such remote branch.
export async function originMainSha(worktreePath, runGit = defaultRunGit) {
  try {
    const stdout = await runGit(['rev-parse', '--verify', '-q', 'refs/remotes/origin/main^{commit}'], worktreePath);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function listCommits(worktreePath, file, runGit = defaultRunGit) {
  try {
    const [stdout, touching, originSha] = await Promise.all([
      runGit(['log', `--pretty=format:${LOG_FORMAT}`], worktreePath),
      file ? shasTouching(worktreePath, file, runGit) : null,
      originMainSha(worktreePath, runGit),
    ]);
    const commits = parseCommitLog(stdout);
    return markOriginMain(touching ? markTouching(commits, touching) : commits, originSha);
  } catch {
    // `git log` exits non-zero for a repo with no commits yet; treat
    // that the same as "no commit history" rather than an error.
    return [];
  }
}
