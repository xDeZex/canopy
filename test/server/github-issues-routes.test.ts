import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler, type RequestDependencies, type RequestDescription } from '../../server/handle-request.js';
import { GitHubIssuesError, type GitHubIssues } from '../../server/github-issues.js';

function handler(githubIssues?: GitHubIssues) {
  const unused = async (): Promise<never> => { throw new Error('Unrelated IO must not run'); };
  const dependencies: RequestDependencies = {
    githubIssues, getWorktrees: unused, getTree: unused, getContent: unused, getCommits: unused,
    getComments: unused, createComment: unused, watchWorktree: () => { throw new Error('No watcher'); },
    subscribeToWorktreeChanges: () => { throw new Error('No watcher'); },
    subscribeToActivity: () => { throw new Error('No watcher'); },
    readStatic: unused, publicDir: '/public', worktreeDeletion: { preview: unused, remove: unused },
  };
  return createRequestHandler(dependencies);
}

function request(url = '/api/github/issues', method = 'GET'): RequestDescription {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  return { pathname, searchParams, method };
}

const payload = { repositories: [{ id: 'github.com/team/repo', host: 'github.com', owner: 'team', name: 'repo' }],
  repository: null, issues: [] };

test('issues endpoint forwards optional explicit selection and returns fixed choice contract without worktree IO', async () => {
  const calls: (string | undefined)[] = [];
  const run = handler({ list: async (repository) => { calls.push(repository); return payload; } });
  for (const url of ['/api/github/issues', '/api/github/issues?repository=github.com%2Fteam%2Frepo&worktree=/arbitrary']) {
    const response = await run(request(url));
    assert.equal(response.status, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(String(response.body)), payload);
  }
  assert.deepEqual(calls, [undefined, 'github.com/team/repo']);
});

test('HEAD matches GET headers but has no response body; mutation methods do not invoke the service', async () => {
  let calls = 0;
  const run = handler({ list: async () => { calls++; return payload; } });
  const get = await run(request());
  const head = await run(request('/api/github/issues', 'HEAD'));
  assert.equal(head.status, 200);
  assert.deepEqual(head.headers, get.headers);
  assert.equal(head.body, undefined);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await run(request('/api/github/issues', method))).status, 404);
  assert.equal(calls, 2);
});

test('typed service errors have suitable HTTP status and stable actionable JSON; unknown errors are redacted', async () => {
  for (const [error, status, body] of [
    [new GitHubIssuesError(503, 'missing-gh', 'Install gh and authenticate.'), 503, { error: 'Install gh and authenticate.', code: 'missing-gh' }],
    [new GitHubIssuesError(401, 'auth', 'Run gh auth login.'), 401, { error: 'Run gh auth login.', code: 'auth' }],
    [new Error('token secret /private/path'), 500, { error: 'Could not load GitHub issues. Try refreshing.', code: 'internal' }],
  ] as const) {
    const response = await handler({ list: async () => { throw error; } })(request());
    assert.equal(response.status, status);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(String(response.body)), body);
  }
});

test('older dependency factories can omit the optional service and get a structured unavailable response', async () => {
  const response = await handler()(request());
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(String(response.body)), { error: 'GitHub issues are unavailable in this server.', code: 'unavailable' });
});

const detailPayload = { issue: { number: 42, title: 'Issue 42', body: 'Markdown', createdAt: '2026-10-01T12:00:00Z',
  url: 'https://github.com/team/repo/issues/42', author: 'author', state: 'open' as const, labels: ['bug'], comments: [] } };

test('detail route forwards positive issue number and optional explicit repository without invoking list', async () => {
  const calls: { number: number; repository: string | undefined }[] = [];
  const run = handler({ list: async () => { throw new Error('Do not list on detail requests'); },
    details: async (number, repository) => { calls.push({ number, repository }); return detailPayload; } });
  for (const url of ['/api/github/issues/42', '/api/github/issues/42?repository=github.com%2Fteam%2Frepo']) {
    const response = await run(request(url));
    assert.equal(response.status, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(String(response.body)), detailPayload);
  }
  assert.deepEqual(calls, [{ number: 42, repository: undefined }, { number: 42, repository: 'github.com/team/repo' }]);
});

test('detail route rejects malformed, non-positive and unsafe numbers before invoking the service', async () => {
  const unused = async (): Promise<never> => { throw new Error('Must validate before service'); };
  const run = handler({ list: unused, details: unused });
  for (const segment of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '01', '1e2', '9007199254740992', '42/comments', '%34%32']) {
    const response = await run(request(`/api/github/issues/${segment}`));
    assert.equal(response.status, 400, segment);
    assert.deepEqual(JSON.parse(String(response.body)), { error: 'Choose an issue with a positive integer number and retry.', code: 'invalid-issue-number' });
  }
});

test('detail HEAD matches GET while mutation methods never invoke either service operation', async () => {
  let calls = 0;
  const run = handler({ list: async () => { throw new Error('No list'); }, details: async () => { calls++; return detailPayload; } });
  const get = await run(request('/api/github/issues/42'));
  const head = await run(request('/api/github/issues/42', 'HEAD'));
  assert.equal(head.status, 200);
  assert.deepEqual(head.headers, get.headers);
  assert.equal(head.body, undefined);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await run(request('/api/github/issues/42', method))).status, 404);
  assert.equal(calls, 2);
});

test('detail errors preserve typed failures and redact unexpected exceptions', async () => {
  for (const [error, status, code] of [
    [new GitHubIssuesError(400, 'repository-required', 'Choose a repository.'), 400, 'repository-required'],
    [new GitHubIssuesError(502, 'invalid-response', 'Refresh and check gh version.'), 502, 'invalid-response'],
    [new Error('private token'), 500, 'internal'],
  ] as const) {
    const response = await handler({ list: async () => payload, details: async () => { throw error; } })(request('/api/github/issues/42'));
    assert.equal(response.status, status);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    const body: unknown = JSON.parse(String(response.body));
    assert.deepEqual(body, { error: status === 500 ? 'Could not load GitHub issues. Try refreshing.' : error.message, code });
  }
});

test('list-only or absent services return structured unavailable for details', async () => {
  for (const service of [undefined, { list: async () => payload }]) {
    const response = await handler(service)(request('/api/github/issues/42'));
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(String(response.body)), { error: 'GitHub issues are unavailable in this server.', code: 'unavailable' });
  }
});
