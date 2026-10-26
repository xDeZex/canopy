import type { Git } from './git-port.js';
import type { Gh } from './gh.js';
import type { GitHubIssue, GitHubIssueComment, GitHubIssueDetails, GitHubIssueDetailsResponse, GitHubIssuesResponse, GitHubRepository } from '../public/issue-contracts.js';

export class GitHubIssuesError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export interface GitHubIssues {
  list: (repository?: string) => Promise<GitHubIssuesResponse>;
  details?: (number: number, repository?: string) => Promise<GitHubIssueDetailsResponse>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new GitHubIssuesError(502, 'invalid-response', 'GitHub returned an invalid response. Try refreshing; check your GitHub CLI version if this persists.');
}

function remoteRepository(remote: string): GitHubRepository | null {
  let host: string;
  let repositoryPath: string;
  if (/^(https|ssh):\/\//i.test(remote)) {
    let url: URL;
    try { url = new URL(remote); } catch { return null; }
    if (url.search || url.hash || url.password || (url.protocol === 'https:' && url.username)) return null;
    host = url.hostname;
    repositoryPath = url.pathname.replace(/^\//, '');
  } else {
    const match = /^(?:[^@\s/:]+@)?([^\s/:]+):([^\s]+)$/.exec(remote);
    if (!match) return null;
    [, host, repositoryPath] = match;
  }
  host = host.toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) || !host.includes('.')) return null;
  const match = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(repositoryPath);
  if (!match || match[2] === '.' || match[2] === '..') return null;
  const [, owner, name] = match;
  return { id: `${host}/${owner}/${name}`, host, owner, name };
}

export function parseGitHubRemotes(output: string): GitHubRepository[] {
  const repositories = new Map<string, GitHubRepository>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\S+\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line);
    const repository = match ? remoteRepository(match[1]) : null;
    if (!repository) continue;
    if (repository.owner.toLowerCase() === 'saab-xc') {
      throw new GitHubIssuesError(403, 'blocked-repository', 'The saab-xc organization is outside this data boundary. Stop and use an approved environment.');
    }
    const key = repository.id.toLowerCase();
    if (!repositories.has(key)) repositories.set(key, repository);
  }
  return [...repositories.values()];
}

function issue(value: unknown): GitHubIssue {
  if (!object(value) || !Number.isSafeInteger(value.number) || typeof value.number !== 'number' || value.number <= 0 ||
      typeof value.title !== 'string' || (value.body !== null && typeof value.body !== 'string') ||
      typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at)) || typeof value.html_url !== 'string') invalidResponse();
  let url: URL;
  try { url = new URL(value.html_url); } catch { return invalidResponse(); }
  if (url.protocol !== 'https:' || url.username || url.password) invalidResponse();
  return { number: value.number, title: value.title, body: value.body ?? '', createdAt: value.created_at, url: value.html_url };
}

function author(value: unknown): string {
  if (value === null) return 'Deleted user';
  if (!object(value)) invalidResponse();
  if (value.login === undefined || value.login === null || value.login === '') return 'Deleted user';
  if (typeof value.login !== 'string') invalidResponse();
  return value.login;
}

function comment(value: unknown): GitHubIssueComment {
  if (!object(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0 ||
      (value.body !== null && typeof value.body !== 'string') || typeof value.created_at !== 'string' ||
      !Number.isFinite(Date.parse(value.created_at))) invalidResponse();
  return { id: value.id, body: value.body ?? '', author: author(value.user), createdAt: value.created_at };
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) invalidResponse();
  return value.map((label: unknown) => {
    const name = object(label) ? label.name : label;
    if (typeof name !== 'string' || !name) invalidResponse();
    return name;
  });
}

function ghFailure(error: unknown, { host, id }: GitHubRepository): GitHubIssuesError {
  const details = object(error) ? error : {};
  const message = [details.message, details.stderr].filter((value) => typeof value === 'string').join('\n');
  if (details.code === 'ENOENT') return new GitHubIssuesError(503, 'missing-gh', `GitHub CLI (gh) is missing; cannot load ${id}. Install gh and authenticate with gh auth login --hostname ${host}.`);
  if (/HTTP 401|authentication|not logged|auth login|bad credentials|token.*(?:invalid|expired)/i.test(message)) {
    return new GitHubIssuesError(401, 'auth', `GitHub authentication failed for ${id}. Run gh auth login --hostname ${host} and retry.`);
  }
  if (/HTTP (403|404)|forbidden|not found|permission|access denied/i.test(message)) {
    return new GitHubIssuesError(403, 'access', `Cannot access ${id}. Check repository permissions and gh auth status --hostname ${host}.`);
  }
  return new GitHubIssuesError(502, 'github-failed', `Could not load GitHub issues from ${id}. Check connectivity and gh auth status --hostname ${host}, then retry.`);
}

export function createGitHubIssues(repoRoot: string, git: Git, gh: Gh): GitHubIssues & { details: NonNullable<GitHubIssues['details']> } {
  async function resolveRepository(repositoryId?: string) {
    let output: string;
    try { output = await git(['remote', '-v'], repoRoot); }
    catch { throw new GitHubIssuesError(422, 'remote', 'Could not read Git remotes. Check this repository with git remote -v.'); }
    const repositories = parseGitHubRemotes(output);
    if (!repositories.length) throw new GitHubIssuesError(422, 'remote', 'No supported GitHub remote found. Add an HTTPS or SSH repository remote with git remote add.');
    const repository = repositoryId === undefined
      ? (repositories.length === 1 ? repositories[0] : null)
      : repositories.find((candidate) => candidate.id === repositoryId);
    if (repository === undefined) throw new GitHubIssuesError(400, 'invalid-repository', 'Choose a repository from this project’s Git remotes and retry.');
    return { repositories, repository };
  }

  async function request(repository: GitHubRepository, endpoint: string): Promise<unknown> {
    let stdout: string;
    try { stdout = await gh(['api', '--hostname', repository.host, endpoint], repoRoot); }
    catch (error) { throw ghFailure(error, repository); }
    try { return JSON.parse(stdout); } catch { return invalidResponse(); }
  }

  async function page(repository: GitHubRepository, endpoint: string): Promise<unknown[]> {
    const rows = await request(repository, endpoint);
    if (!Array.isArray(rows) || rows.length > 100) invalidResponse();
    return rows;
  }

  return {
    async list(repositoryId) {
      const { repositories, repository } = await resolveRepository(repositoryId);
      if (repository === null) return { repositories, repository, issues: [] };
      const issues: GitHubIssue[] = [];
      for (let pageNumber = 1; ; pageNumber++) {
        const endpoint = `repos/${repository.owner}/${repository.name}/issues?state=open&sort=created&direction=desc&per_page=100&page=${pageNumber}`;
        const rows = await page(repository, endpoint);
        for (const row of rows) {
          if (!object(row)) invalidResponse();
          if ('pull_request' in row) {
            if (!object(row.pull_request)) invalidResponse();
            continue;
          }
          issues.push(issue(row));
        }
        if (rows.length < 100) break;
      }
      issues.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number);
      return { repositories, repository, issues };
    },
    async details(number, repositoryId) {
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new GitHubIssuesError(400, 'invalid-issue-number', 'Choose an issue with a positive integer number and retry.');
      }
      const { repository } = await resolveRepository(repositoryId);
      if (repository === null) throw new GitHubIssuesError(400, 'repository-required', 'Choose a repository from this project’s Git remotes before opening an issue.');
      const endpoint = `repos/${repository.owner}/${repository.name}/issues/${number}`;
      const value = await request(repository, endpoint);
      if (!object(value)) invalidResponse();
      if ('pull_request' in value) throw new GitHubIssuesError(404, 'not-an-issue', 'This number identifies a pull request. Choose an issue from the issues list.');
      const summary = issue(value);
      if (summary.number !== number || (value.state !== 'open' && value.state !== 'closed')) invalidResponse();
      const metadata: Pick<GitHubIssueDetails, 'author' | 'state' | 'labels'> = {
        author: author(value.user), state: value.state, labels: labels(value.labels),
      };
      const comments: GitHubIssueComment[] = [];
      for (let pageNumber = 1; ; pageNumber++) {
        const rows = await page(repository, `${endpoint}/comments?per_page=100&page=${pageNumber}`);
        comments.push(...rows.map(comment));
        if (rows.length < 100) break;
      }
      comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
      return { issue: { ...summary, ...metadata, comments } };
    },
  };
}
