// One repository-wide issue selection, independent of the active worktree.
import type { GitHubRepository, GitHubIssue, GitHubIssueDetails, GitHubIssueComment } from './issue-contracts.js';
export interface IssuesState {
  repositories: GitHubRepository[];
  repository: GitHubRepository | null;
  issues: GitHubIssue[];
  selectedNumber: number | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  notice: string | null;
  details: GitHubIssueDetails | null;
  detailsStatus: 'idle' | 'loading' | 'ready' | 'error';
  detailsError: string | null;
}

interface IssuesOptions {
  fetch(url: string): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
  onChange(): void;
}

export function createIssuesStore({ fetch, onChange }: IssuesOptions) {
  let state: IssuesState = { repositories: [], repository: null, issues: [], selectedNumber: null, status: 'idle', error: null, notice: null,
    details: null, detailsStatus: 'idle', detailsError: null };
  let generation = 0;
  let detailsGeneration = 0;
  let disposed = false;
  const detailsCache = new Map<string, GitHubIssueDetails>();

  async function fetchJson(url: string) {
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) {
      const message = record(body) && 'error' in body ? String(body.error) : `request failed with status ${response.status}`;
      throw new Error(message);
    }
    return body;
  }

  async function loadDetails() {
    const { repository, selectedNumber } = state;
    if (disposed || !repository || selectedNumber === null) return;
    const current = ++detailsGeneration;
    state = { ...state, detailsStatus: 'loading', detailsError: null };
    onChange();
    try {
      const result = parseDetails(await fetchJson(`/api/github/issues/${selectedNumber}?repository=${encodeURIComponent(repository.id)}`));
      if (current !== detailsGeneration || disposed) return;
      if (result.number !== selectedNumber) throw new Error('Invalid issue details response');
      detailsCache.set(`${repository.id}#${selectedNumber}`, result);
      state = { ...state, details: result, detailsStatus: 'ready' };
    } catch (error) {
      if (current !== detailsGeneration || disposed) return;
      state = { ...state, detailsStatus: 'error', detailsError: error instanceof Error ? error.message : String(error) };
    }
    onChange();
  }

  function showSelectedDetails() {
    const cached = detailsCache.get(`${state.repository?.id}#${state.selectedNumber}`);
    if (cached) {
      state = { ...state, details: cached, detailsStatus: 'ready', detailsError: null };
      onChange();
    } else void loadDetails();
  }

  async function load(repository: string | null | undefined = state.repository?.id) {
    if (disposed) return;
    const current = ++generation;
    detailsGeneration++;
    state = { ...state, status: 'loading', error: null };
    onChange();
    try {
      const result = parseList(await fetchJson(`/api/github/issues${repository ? `?repository=${encodeURIComponent(repository)}` : ''}`));
      if (current !== generation) return;
      detailsCache.clear();
      const selectedNumber = result.repository?.id === state.repository?.id && result.issues.some((issue) => issue.number === state.selectedNumber)
        ? state.selectedNumber : result.issues[0]?.number ?? null;
      const sameRepository = result.repository?.id === state.repository?.id;
      const sameSelection = sameRepository && selectedNumber === state.selectedNumber;
      const notice = sameRepository && state.selectedNumber !== null && !sameSelection
        ? `Issue #${state.selectedNumber} is no longer in the open issues list.${selectedNumber === null ? ' No open issues remain.' : ` Showing #${selectedNumber}.`}` : null;
      if (!sameSelection) detailsGeneration++;
      state = { ...state, ...result, selectedNumber, status: 'ready', error: null, notice,
        ...(!sameSelection ? { details: null, detailsStatus: 'idle' as const, detailsError: null } : {}) };
    } catch (error) {
      if (current !== generation) return;
      state = { ...state, status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    onChange();
    void loadDetails();
  }

  function select(number: number) {
    if (disposed || !state.issues.some((issue) => issue.number === number) || state.selectedNumber === number) return;
    detailsGeneration++;
    state = { ...state, selectedNumber: number, details: null, detailsStatus: 'idle', detailsError: null, notice: null };
    onChange();
    showSelectedDetails();
  }

  function step(direction: number) {
    if (!state.issues.length) return;
    const index = state.issues.findIndex((issue) => issue.number === state.selectedNumber);
    select(state.issues[(index + direction + state.issues.length) % state.issues.length]!.number);
  }

  return { getState: () => state, load, loadDetails, select, step, dispose: () => { disposed = true; generation++; detailsGeneration++; } };
}

const record = (input: unknown): input is Record<string, unknown> => typeof input === 'object' && input !== null;
const issue = (input: unknown): input is GitHubIssue => record(input) && Number.isSafeInteger(input.number) && Number(input.number) > 0
  && ['title', 'body', 'createdAt', 'url'].every((key) => typeof input[key] === 'string');

function parseList(value: unknown): Pick<IssuesState, 'repositories' | 'repository' | 'issues'> {
  const repository = (input: unknown): input is GitHubRepository => record(input)
    && ['id', 'host', 'owner', 'name'].every((key) => typeof input[key] === 'string');
  if (!record(value) || !Array.isArray(value.repositories) || !value.repositories.every(repository)
    || !(value.repository === null || repository(value.repository)) || !Array.isArray(value.issues) || !value.issues.every(issue)) {
    throw new Error('Invalid issues response');
  }
  return { repositories: value.repositories, repository: value.repository, issues: value.issues };
}

function parseDetails(value: unknown): GitHubIssueDetails {
  const comment = (input: unknown): input is GitHubIssueComment => record(input) && Number.isSafeInteger(input.id) && Number(input.id) > 0
    && ['body', 'author', 'createdAt'].every((key) => typeof input[key] === 'string');
  if (!record(value) || !issue(value.issue) || !('author' in value.issue) || typeof value.issue.author !== 'string'
    || !('state' in value.issue) || !['open', 'closed'].includes(String(value.issue.state))
    || !('labels' in value.issue) || !Array.isArray(value.issue.labels) || !value.issue.labels.every((label) => typeof label === 'string')
    || !('comments' in value.issue) || !Array.isArray(value.issue.comments) || !value.issue.comments.every(comment)) {
    throw new Error('Invalid issue details response');
  }
  return { ...value.issue, author: value.issue.author, state: value.issue.state === 'open' ? 'open' : 'closed',
    labels: value.issue.labels, comments: value.issue.comments };
}
