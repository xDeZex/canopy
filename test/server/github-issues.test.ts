import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubIssues, GitHubIssuesError, parseGitHubRemotes } from '../../server/github-issues.js';

const repository = { id: 'github.com/team/project', host: 'github.com', owner: 'team', name: 'project' };
const remotes = 'origin\tgit@github.com:team/project.git (fetch)\norigin\tgit@github.com:team/project.git (push)\n';
const row = (number = 1, createdAt = '2026-10-01T12:00:00Z') => ({ number, title: `Issue ${number}`, body: 'Markdown **body**',
  created_at: createdAt, html_url: `https://github.com/team/project/issues/${number}` });
const endpoint = (page: number, owner = 'team', name = 'project') =>
  `repos/${owner}/${name}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`;

function fixture(options: { remotes?: string; pages?: unknown[]; failure?: unknown; gitFailure?: boolean } = {}) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  let page = 0;
  const service = createGitHubIssues('/project', async (args, cwd) => {
    calls.push({ command: 'git', args, cwd });
    if (options.gitFailure) throw new Error('private path');
    return options.remotes ?? remotes;
  }, async (args, cwd) => {
    calls.push({ command: 'gh', args, cwd });
    if (options.failure) throw options.failure;
    const value = options.pages?.[page++] ?? [];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  return { service, calls };
}

async function rejectsCode(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GitHubIssuesError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(error.message.length > 25);
    return true;
  });
}

test('remote parsing supports SSH, SCP and HTTPS enterprise URLs, de-duplicates identities and ignores local paths', () => {
  assert.deepEqual(parseGitHubRemotes([
    'origin git@github.com:team/project.git (fetch)',
    'origin https://github.com/team/project.git (push)',
    'mirror ssh://git@GITHUB.COM/team/project (fetch)',
    'enterprise ssh://git@github.example.com:2222/other/repo.git (fetch)',
    'https https://github.example.com/other/repo/ (push)',
    'local /home/me/repo (fetch)',
    'file file:///repo.git (fetch)',
    'invalid https://github.com/team/repo/extra (fetch)',
    'query https://github.com/team/repo?token=secret (fetch)',
    'credentials https://secret@github.com/team/repo (fetch)',
    'invalid ssh://git@-bad.example/team/repo (fetch)',
  ].join('\n')), [repository,
    { id: 'github.example.com/other/repo', host: 'github.example.com', owner: 'other', name: 'repo' }]);
});

test('list crosses real parsing/service units with fake subprocesses and preserves Markdown', async () => {
  const { service, calls } = fixture({ pages: [[row(1), row(2, '2026-10-02T12:00:00Z')]] });
  const response = await service.list();
  assert.deepEqual(response, { repositories: [repository], repository, issues: [
    { number: 2, title: 'Issue 2', body: 'Markdown **body**', createdAt: '2026-10-02T12:00:00Z', url: 'https://github.com/team/project/issues/2' },
    { number: 1, title: 'Issue 1', body: 'Markdown **body**', createdAt: '2026-10-01T12:00:00Z', url: 'https://github.com/team/project/issues/1' },
  ] });
  assert.deepEqual(calls, [
    { command: 'git', args: ['remote', '-v'], cwd: '/project' },
    { command: 'gh', args: ['api', '--hostname', 'github.com', endpoint(1)], cwd: '/project' },
  ]);
});

test('all pages are read, including full pages containing only PRs, without an arbitrary page cap', async () => {
  const prPage = Array.from({ length: 100 }, () => ({ pull_request: {} }));
  const { service, calls } = fixture({ pages: [...Array.from({ length: 12 }, () => prPage), [row(99)]] });
  assert.deepEqual((await service.list()).issues.map((issue) => issue.number), [99]);
  assert.deepEqual(calls.slice(1), Array.from({ length: 13 }, (_, index) => ({ command: 'gh',
    args: ['api', '--hostname', 'github.com', endpoint(index + 1)], cwd: '/project' })));
});

test('exactly full issue pages require another raw page and null bodies are empty Markdown', async () => {
  const { service, calls } = fixture({ pages: [Array.from({ length: 100 }, (_, index) => ({ ...row(index + 1), body: null })), []] });
  const response = await service.list();
  assert.equal(response.issues.length, 100);
  assert.ok(response.issues.every((issue) => issue.body === ''));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1)?.args, ['api', '--hostname', 'github.com', endpoint(2)]);
});

test('ambiguous remotes return a choice without contacting GitHub; explicit choice uses its hostname', async () => {
  const { service, calls } = fixture({ remotes: `${remotes}upstream https://github.example.com/upstream/base.git (fetch)\n` });
  const choice = await service.list();
  assert.equal(choice.repositories.length, 2);
  assert.equal(choice.repository, null);
  assert.deepEqual(choice.issues, []);
  assert.equal(calls.length, 1);
  const selected = await service.list('github.example.com/upstream/base');
  assert.equal(selected.repository?.id, 'github.example.com/upstream/base');
  assert.deepEqual(calls.at(-1), { command: 'gh', args: ['api', '--hostname', 'github.example.com', endpoint(1, 'upstream', 'base')], cwd: '/project' });
});

test('explicit repository must exactly match discovered remotes, never arbitrary API input', async () => {
  for (const id of ['', 'github.com/attacker/repo', 'github.com/team/project?query=x', 'GITHUB.COM/team/project']) {
    const { service, calls } = fixture();
    await rejectsCode(service.list(id), 'invalid-repository', 400);
    assert.equal(calls.length, 1);
  }
});

test('missing, unsupported or unreadable remotes are actionable without gh calls', async () => {
  for (const options of [{ remotes: '' }, { remotes: 'origin /local/repo (fetch)' }, { gitFailure: true }]) {
    const { service, calls } = fixture(options);
    await rejectsCode(service.list(), 'remote', 422);
    assert.equal(calls.length, 1);
  }
});

test('export-controlled owner is rejected before any gh access, even alongside an allowed remote', async () => {
  const { service, calls } = fixture({ remotes: `${remotes}blocked git@github.com:SAAB-XC/repo.git (fetch)` });
  await rejectsCode(service.list(repository.id), 'blocked-repository', 403);
  assert.equal(calls.length, 1);
});

test('CLI failures distinguish installation, authentication, access and connectivity without leaking stderr', async () => {
  for (const [failure, code, status] of [
    [{ code: 'ENOENT' }, 'missing-gh', 503],
    [{ stderr: 'gh: HTTP 401: Bad credentials secret' }, 'auth', 401],
    [{ stderr: 'To get started with GitHub CLI, please run: gh auth login' }, 'auth', 401],
    [{ stderr: 'gh: HTTP 403: forbidden secret' }, 'access', 403],
    [{ stderr: 'gh: HTTP 404: Not Found secret' }, 'access', 403],
    [{ stderr: 'connect timeout secret' }, 'github-failed', 502],
  ] as const) {
    const { service } = fixture({ failure });
    await rejectsCode(service.list(), code, status);
    await assert.rejects(service.list(), (error: unknown) => error instanceof Error && !error.message.includes('secret') && error.message.includes(repository.id));
  }
});

test('malformed payloads and rows fail atomically, including a malformed later page', async () => {
  for (const value of ['invalid JSON', {}, [null], [{ ...row(), number: 0 }], [{ ...row(), number: 1.5 }],
    [{ ...row(), title: null }], [{ ...row(), body: {} }], [{ ...row(), created_at: 'yesterday' }],
    [{ ...row(), html_url: 'javascript:alert(1)' }], [{ ...row(), pull_request: null }],
    Array.from({ length: 101 }, () => row())]) {
    const { service } = fixture({ pages: [value] });
    await rejectsCode(service.list(), 'invalid-response', 502);
  }
  const { service } = fixture({ pages: [Array.from({ length: 100 }, (_, index) => row(index + 1)), '{}'] });
  await rejectsCode(service.list(), 'invalid-response', 502);
});

const detailRow = () => ({ ...row(42), user: { login: 'issue-author' }, state: 'open', labels: [{ name: 'bug' }, { name: 'help wanted' }] });
const commentRow = (id: number, createdAt = '2026-10-03T12:00:00Z') => ({ id, body: `Comment **${id}**`, user: { login: `author-${id}` }, created_at: createdAt });
const detailEndpoint = 'repos/team/project/issues/42';
const commentsEndpoint = (page: number) => `${detailEndpoint}/comments?per_page=100&page=${page}`;

function detailFixture(responses: { endpoint: string; value?: unknown; failure?: unknown }[] = [], remoteOutput = remotes) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  let responseIndex = 0;
  const service = createGitHubIssues('/project', async (args, cwd) => {
    calls.push({ command: 'git', args, cwd });
    assert.deepEqual(args, ['remote', '-v']);
    assert.equal(cwd, '/project');
    return remoteOutput;
  }, async (args, cwd) => {
    calls.push({ command: 'gh', args, cwd });
    const response = responses[responseIndex++];
    assert.ok(response, `Unexpected gh call: ${args.join(' ')}`);
    assert.deepEqual(args, ['api', '--hostname', 'github.com', response.endpoint]);
    assert.equal(cwd, '/project');
    if (response.failure) throw response.failure;
    return typeof response.value === 'string' ? response.value : JSON.stringify(response.value);
  });
  return { service, calls, assertConsumed: () => assert.equal(responseIndex, responses.length) };
}

test('details loads metadata and all comments on demand with exact repository-scoped REST commands', async () => {
  const { service, calls, assertConsumed } = detailFixture([
    { endpoint: detailEndpoint, value: detailRow() },
    { endpoint: commentsEndpoint(1), value: [commentRow(2), commentRow(3, '2026-10-02T12:00:00Z'), commentRow(1)] },
  ]);
  const response = await service.details(42, repository.id);
  assert.deepEqual(response, { issue: { number: 42, title: 'Issue 42', body: 'Markdown **body**',
    createdAt: '2026-10-01T12:00:00Z', url: 'https://github.com/team/project/issues/42', author: 'issue-author', state: 'open',
    labels: ['bug', 'help wanted'], comments: [
      { id: 3, body: 'Comment **3**', author: 'author-3', createdAt: '2026-10-02T12:00:00Z' },
      { id: 1, body: 'Comment **1**', author: 'author-1', createdAt: '2026-10-03T12:00:00Z' },
      { id: 2, body: 'Comment **2**', author: 'author-2', createdAt: '2026-10-03T12:00:00Z' },
    ] } });
  assert.deepEqual(calls, [
    { command: 'git', args: ['remote', '-v'], cwd: '/project' },
    { command: 'gh', args: ['api', '--hostname', 'github.com', detailEndpoint], cwd: '/project' },
    { command: 'gh', args: ['api', '--hostname', 'github.com', commentsEndpoint(1)], cwd: '/project' },
  ]);
  assertConsumed();
});

test('details reads more than 100 comments without a cap and probes after exact full pages', async () => {
  for (const finalPage of [[], [commentRow(1301)]]) {
    const responses = [{ endpoint: detailEndpoint, value: detailRow() },
      ...Array.from({ length: 13 }, (_, index) => ({ endpoint: commentsEndpoint(index + 1),
        value: Array.from({ length: 100 }, (_, offset) => commentRow(index * 100 + offset + 1)) })),
      { endpoint: commentsEndpoint(14), value: finalPage }];
    const { service, assertConsumed } = detailFixture(responses);
    const result = await service.details(42);
    assert.equal(result.issue.comments.length, 1300 + finalPage.length);
    assert.deepEqual(result.issue.comments.map(({ id }) => id), Array.from({ length: 1300 + finalPage.length }, (_, index) => index + 1));
    assertConsumed();
  }
});

test('exactly 100 comments requires a second empty page rather than stopping from a count field', async () => {
  const { service, assertConsumed } = detailFixture([
    { endpoint: detailEndpoint, value: { ...detailRow(), comments: 0 } },
    { endpoint: commentsEndpoint(1), value: Array.from({ length: 100 }, (_, index) => commentRow(index + 1)) },
    { endpoint: commentsEndpoint(2), value: [] },
  ]);
  assert.equal((await service.details(42)).issue.comments.length, 100);
  assertConsumed();
});

test('details represents empty/null Markdown, deleted users, closed state and empty labels defensively', async () => {
  for (const user of [null, {}, { login: null }, { login: '' }]) {
    const { service, assertConsumed } = detailFixture([
      { endpoint: detailEndpoint, value: { ...detailRow(), body: null, user, state: 'closed', labels: [] } },
      { endpoint: commentsEndpoint(1), value: [{ ...commentRow(1), body: null, user }, { ...commentRow(2), body: '', user }] },
    ]);
    const { issue } = await service.details(42);
    assert.equal(issue.body, '');
    assert.equal(issue.author, 'Deleted user');
    assert.equal(issue.state, 'closed');
    assert.deepEqual(issue.labels, []);
    assert.ok(issue.comments.every(({ body, author }) => body === '' && author === 'Deleted user'));
    assertConsumed();
  }
  const { service } = detailFixture([
    { endpoint: detailEndpoint, value: { ...detailRow(), body: '', labels: ['bug'] } },
    { endpoint: commentsEndpoint(1), value: [] },
  ]);
  assert.deepEqual((await service.details(42)).issue.labels, ['bug']);
});

test('details rejects invalid numbers before any Git or gh IO', async () => {
  for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { service, calls } = detailFixture();
    await rejectsCode(service.details(number), 'invalid-issue-number', 400);
    assert.deepEqual(calls, []);
  }
});

test('details requires explicit ambiguous remote selection and rejects unknown/blocked repositories before gh', async () => {
  for (const [remoteOutput, id, code, status] of [
    [`${remotes}other https://github.com/other/repo (fetch)`, undefined, 'repository-required', 400],
    [remotes, 'github.com/other/repo', 'invalid-repository', 400],
    [remotes, '', 'invalid-repository', 400],
    ['', undefined, 'remote', 422],
    [`${remotes}blocked git@github.com:saab-xc/repo.git (fetch)`, repository.id, 'blocked-repository', 403],
  ] as const) {
    const { service, calls } = detailFixture([], remoteOutput);
    await rejectsCode(service.details(42, id), code, status);
    assert.equal(calls.length, 1);
  }
});

test('explicit enterprise detail choice pins both issue and comment requests to the discovered hostname', async () => {
  const calls: string[][] = [];
  const service = createGitHubIssues('/project', async () => `${remotes}enterprise git@github.example.com:team/project.git (fetch)`, async (args) => {
    calls.push(args);
    if (calls.length === 1) {
      assert.deepEqual(args, ['api', '--hostname', 'github.example.com', detailEndpoint]);
      return JSON.stringify({ ...detailRow(), html_url: 'https://github.example.com/team/project/issues/42' });
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(args, ['api', '--hostname', 'github.example.com', commentsEndpoint(1)]);
    return '[]';
  });
  assert.equal((await service.details(42, 'github.example.com/team/project')).issue.number, 42);
  assert.equal(calls.length, 2);
});

test('pull request details are rejected before comments are requested', async () => {
  const { service, assertConsumed } = detailFixture([{ endpoint: detailEndpoint, value: { ...detailRow(), pull_request: {} } }]);
  await rejectsCode(service.details(42), 'not-an-issue', 404);
  assertConsumed();
});

test('malformed detail metadata, mismatched numbers and unsafe URLs fail before comment IO', async () => {
  for (const value of ['invalid JSON', [], null, { ...detailRow(), number: 41 }, { ...detailRow(), user: 123 },
    { ...detailRow(), user: { login: 123 } }, { ...detailRow(), state: 'unknown' }, { ...detailRow(), labels: {} },
    { ...detailRow(), labels: [{ name: null }] }, { ...detailRow(), labels: [''] },
    { ...detailRow(), html_url: 'http://github.com/team/project/issues/42' },
    { ...detailRow(), html_url: 'https://user:secret@github.com/team/project/issues/42' },
    { ...detailRow(), html_url: 'javascript:alert(1)' }]) {
    const { service, assertConsumed } = detailFixture([{ endpoint: detailEndpoint, value }]);
    await rejectsCode(service.details(42), 'invalid-response', 502);
    assertConsumed();
  }
});

test('malformed comments fail the complete detail operation rather than returning partial results', async () => {
  for (const value of [{}, 'bad JSON', [null], [{ ...commentRow(1), id: 0 }], [{ ...commentRow(1), id: 1.5 }],
    [{ ...commentRow(1), body: {} }], [{ ...commentRow(1), user: false }], [{ ...commentRow(1), created_at: 'invalid' }],
    Array.from({ length: 101 }, (_, index) => commentRow(index + 1))]) {
    const { service, assertConsumed } = detailFixture([
      { endpoint: detailEndpoint, value: detailRow() },
      { endpoint: commentsEndpoint(1), value: Array.from({ length: 100 }, (_, index) => commentRow(index + 1)) },
      { endpoint: commentsEndpoint(2), value },
    ]);
    await rejectsCode(service.details(42), 'invalid-response', 502);
    assertConsumed();
  }
});

test('CLI failures at issue or later comment pages stay actionable and redact private stderr', async () => {
  for (const later of [false, true]) {
    for (const [failure, code, status] of [
      [{ code: 'ENOENT', stderr: 'private secret' }, 'missing-gh', 503],
      [{ stderr: 'HTTP 401 private secret' }, 'auth', 401],
      [{ stderr: 'HTTP 403 private secret' }, 'access', 403],
      [{ stderr: 'HTTP 404 private secret' }, 'access', 403],
      [{ stderr: 'timeout private secret' }, 'github-failed', 502],
    ] as const) {
      const { service, assertConsumed } = detailFixture(later ? [
        { endpoint: detailEndpoint, value: detailRow() },
        { endpoint: commentsEndpoint(1), value: Array.from({ length: 100 }, (_, index) => commentRow(index + 1)) },
        { endpoint: commentsEndpoint(2), failure },
      ] : [{ endpoint: detailEndpoint, failure }]);
      await assert.rejects(service.details(42), (error: unknown) => {
        assert.ok(error instanceof GitHubIssuesError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.equal(error.message.includes('private'), false);
        assert.equal(error.message.includes('secret'), false);
        return true;
      });
      assertConsumed();
    }
  }
});
