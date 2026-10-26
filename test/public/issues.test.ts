import assert from 'node:assert/strict';
import test from 'node:test';
import { createIssuesStore } from '../../public/issues-state.js';
import { createIssuesView } from '../../public/issues-view.js';
import { Element } from './fake-dom.js';
import type { GitHubIssueDetails } from '../../public/issue-contracts.js';

const repository = { id: 'github.com/team/project', host: 'github.com', owner: 'team', name: 'project' };
const issues = [9, 4].map((number) => ({ number, title: `Issue ${number}`, body: '<script>untrusted</script>\nDescription', createdAt: '2026-10-01', url: `https://github.com/team/project/issues/${number}` }));
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const details = (number = 9, overrides: Partial<GitHubIssueDetails> = {}): GitHubIssueDetails => ({
  ...issues.find((issue) => issue.number === number)!, number, author: 'octocat', state: 'open', labels: ['feature'], comments: [], ...overrides,
});
const text = (node: Element): string => node.textContent + node.children.map(text).join('');
const descendants = (node: Element): Element[] => [node, ...node.children.flatMap(descendants)];

function fixture(fetch: Parameters<typeof createIssuesStore>[0]['fetch']) {
  const railEl = new Element('nav');
  const mainEl = new Element('main');
  const toolbarEl = new Element('div');
  const document = { createElement: (tag: string) => new Element(tag), addEventListener() {}, removeEventListener() {} };
  const store = createIssuesStore({ fetch, onChange: () => view.render() });
  const view = createIssuesView({ document, railEl, mainEl, toolbarEl, store });
  return { store, railEl, mainEl, toolbarEl };
}

test('repository choice, list selection and wrapping navigation use the real store and view', async () => {
  const urls: string[] = [];
  const f = fixture(async (url) => {
    urls.push(url);
    if (url.startsWith('/api/github/issues/')) return { ok: true, json: async () => ({ issue: details(Number(url.split('/').at(-1)!.split('?')[0])) }) };
    return { ok: true, json: async () => ({ repositories: [repository, { ...repository, id: 'other', name: 'other' }],
      repository: url.includes('?') ? repository : null, issues: url.includes('?') ? issues : [] }) };
  });
  await f.store.load();
  assert.equal(f.mainEl.children[0]!.textContent, 'Choose a repository to view issues.');
  assert.equal(f.railEl.children.length, 0);
  f.mainEl.querySelector('.issues-repository')!.click();
  await settle();
  assert.deepEqual(urls, ['/api/github/issues', '/api/github/issues?repository=github.com%2Fteam%2Fproject',
    '/api/github/issues/9?repository=github.com%2Fteam%2Fproject']);
  assert.equal(f.toolbarEl.children[0]!.textContent, 'github.com/team/project');
  assert.deepEqual(f.railEl.children.map((row) => row.textContent), ['#9 Issue 9', '#4 Issue 4']);
  assert.equal(f.mainEl.querySelector('.issues-title')!.textContent, '#9 Issue 9');
  assert.equal(text(f.mainEl.querySelector('.issues-description')!), issues[0]!.body);
  assert.equal(descendants(f.mainEl).some((node) => node.tag === 'script'), false, 'body remains inert text');
  f.railEl.children[1]!.click();
  assert.equal(f.store.getState().selectedNumber, 4);
  f.store.step(1);
  assert.equal(f.store.getState().selectedNumber, 9);
  f.store.step(-1);
  assert.equal(f.store.getState().selectedNumber, 4);
});

test('loading, empty, failed request and retry are distinct visible states', async () => {
  let resolve!: (value: { ok: boolean; json(): Promise<unknown> }) => void;
  let attempt = 0;
  const f = fixture(async () => {
    if (++attempt === 1) return new Promise((done) => { resolve = done; });
    return { ok: true, json: async () => ({ repositories: [repository], repository, issues: [] }) };
  });
  const loading = f.store.load();
  assert.equal(f.mainEl.children[0]!.textContent, 'Loading issues…');
  resolve({ ok: false, json: async () => ({ error: 'Authenticate with gh', code: 'authentication' }) });
  await loading;
  assert.equal(f.mainEl.children[0]!.textContent, 'Failed to load issues: Authenticate with gh');
  f.mainEl.querySelector('.issues-retry')!.click();
  await settle();
  assert.equal(f.mainEl.children[0]!.textContent, 'No open issues.');
  f.store.step(1);
  assert.equal(f.store.getState().selectedNumber, null);
});

test('a stale repository response and disposed requests cannot overwrite the latest choice', async () => {
  const pending: ((value: { ok: boolean; json(): Promise<unknown> }) => void)[] = [];
  const f = fixture((url) => url.startsWith('/api/github/issues/')
    ? Promise.resolve({ ok: true, json: async () => ({ issue: details() }) }) : new Promise((resolve) => pending.push(resolve)));
  const first = f.store.load('first');
  const second = f.store.load(repository.id);
  pending[1]!({ ok: true, json: async () => ({ repositories: [repository], repository, issues }) });
  await second;
  pending[0]!({ ok: true, json: async () => ({ repositories: [], repository: null, issues: [] }) });
  await first;
  assert.equal(f.store.getState().repository?.id, repository.id);
  const third = f.store.load();
  f.store.dispose();
  pending[2]!({ ok: false, json: async () => ({ error: 'late error' }) });
  await third;
  assert.equal(f.store.getState().error, null);
});

test('only selected conversations load; metadata, safe Markdown and every comment including the tail render', async () => {
  const urls: string[] = [];
  const body = '# Heading\n\n**bold** and `code`\n\n[relative](4)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))';
  const comments = Array.from({ length: 137 }, (_, index) => ({ id: index + 1, author: index === 136 ? '[deleted]' : `reader-${index}`,
    body: `**Comment ${index + 1}**`, createdAt: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString() }));
  const f = fixture(async (url) => {
    urls.push(url);
    return { ok: true, json: async () => url.startsWith('/api/github/issues/')
      ? { issue: details(Number(url.split('/').at(-1)!.split('?')[0]), { body, comments, author: '<img src=x onerror=alert(1)>', state: 'closed', labels: ['bug', '<script>label</script>'] }) }
      : { repositories: [repository], repository, issues } };
  });
  await f.store.load();
  await settle();
  assert.deepEqual(urls, ['/api/github/issues', '/api/github/issues/9?repository=github.com%2Fteam%2Fproject']);
  assert.equal(f.mainEl.querySelector('.issues-author')!.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(f.mainEl.querySelector('.issues-state')!.textContent, 'closed');
  assert.deepEqual(f.mainEl.querySelectorAll('.issues-label').map((node) => node.textContent), ['bug', '<script>label</script>']);
  const articles = f.mainEl.querySelectorAll('.issues-comment');
  assert.equal(articles.length, 137);
  assert.deepEqual(articles.map((article) => article.querySelector('.issues-comment__time')!.getAttribute('datetime')), comments.map((comment) => comment.createdAt));
  assert.equal(articles[136]!.querySelector('.issues-comment__author')!.textContent, '[deleted]');
  assert.equal(articles[136]!.querySelector('.issues-comment__time')!.getAttribute('datetime'), comments[136]!.createdAt);
  assert.match(text(articles[136]!), /Comment 137/);
  const nodes = descendants(f.mainEl);
  assert.ok(nodes.some((node) => node.tag === 'strong' && text(node) === 'bold'));
  assert.ok(nodes.some((node) => node.tag === 'code' && text(node) === 'code'));
  assert.equal(nodes.some((node) => ['script', 'img', 'iframe'].includes(node.tag)), false);
  assert.ok(text(f.mainEl).includes('<script>alert(1)</script>'));
  const links = nodes.filter((node) => node.tag === 'a');
  assert.equal(links.length, 2);
  assert.equal(links.every((node) => node.getAttribute('href')?.startsWith('https://github.com/team/project/issues/')), true);
  const open = f.mainEl.querySelector('.issues-open-link')!;
  assert.equal(open.getAttribute('href'), issues[0]!.url);
  assert.equal(open.getAttribute('target'), '_blank');
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
  f.store.select(9);
  assert.equal(urls.length, 2, 'reselecting the same issue does not refetch');
  f.store.select(4);
  await settle();
  assert.equal(urls.at(-1), '/api/github/issues/4?repository=github.com%2Fteam%2Fproject');
  f.store.select(9);
  assert.equal(urls.length, 3, 'returning to a loaded issue uses its cached conversation');
  assert.equal(f.mainEl.querySelectorAll('.issues-comment').length, 137);
});

test('conversation loading and error are explicit and retry fetches only the current issue', async () => {
  let resolve!: (value: { ok: boolean; json(): Promise<unknown> }) => void;
  const urls: string[] = [];
  const f = fixture(async (url) => {
    urls.push(url);
    return url.startsWith('/api/github/issues/') ? new Promise((done) => { resolve = done; })
      : { ok: true, json: async () => ({ repositories: [repository], repository, issues }) };
  });
  await f.store.load();
  assert.equal(f.mainEl.querySelector('.issues-title')!.textContent, '#9 Issue 9');
  assert.equal(f.mainEl.querySelector('.issues-detail-status')!.textContent, 'Loading issue conversation…');
  resolve({ ok: false, json: async () => ({ error: 'Issue unavailable. Check repository access.', code: 'access' }) });
  await settle();
  assert.equal(f.mainEl.querySelector('.issues-detail-status')!.textContent, 'Failed to load issue conversation: Issue unavailable. Check repository access.');
  f.mainEl.querySelector('.issues-retry')!.click();
  assert.equal(f.mainEl.querySelector('.issues-detail-status')!.textContent, 'Loading issue conversation…');
  resolve({ ok: true, json: async () => ({ issue: details() }) });
  await settle();
  assert.equal(f.mainEl.querySelector('.issues-detail-status'), null);
  assert.equal(f.mainEl.querySelector('.issues-author')!.textContent, 'octocat');
  assert.deepEqual(urls, ['/api/github/issues', ...Array(2).fill('/api/github/issues/9?repository=github.com%2Fteam%2Fproject')]);
});

test('rapid selection, repository changes and disposal reject stale conversation successes and failures', async () => {
  const pending: { url: string; resolve(value: { ok: boolean; json(): Promise<unknown> }): void }[] = [];
  let notifications = 0;
  const f = fixture((url) => url.startsWith('/api/github/issues/') ? new Promise((resolve) => pending.push({ url, resolve }))
    : Promise.resolve({ ok: true, json: async () => ({ repositories: [repository], repository: url.includes('other') ? { ...repository, id: 'other' } : repository, issues }) }));
  await f.store.load();
  f.store.select(4);
  f.store.select(9);
  pending[2]!.resolve({ ok: true, json: async () => ({ issue: details(9, { title: 'Latest nine' }) }) });
  await settle();
  pending[0]!.resolve({ ok: true, json: async () => ({ issue: details(9, { title: 'Stale nine' }) }) });
  pending[1]!.resolve({ ok: false, json: async () => ({ error: 'Stale four' }) });
  await settle();
  assert.equal(f.mainEl.querySelector('.issues-title')!.textContent, '#9 Latest nine');
  assert.equal(f.store.getState().detailsError, null);
  f.store.select(4);
  await f.store.load('other');
  pending[4]!.resolve({ ok: true, json: async () => ({ issue: details(9, { author: 'other repository' }) }) });
  await settle();
  pending[3]!.resolve({ ok: true, json: async () => ({ issue: details(4, { author: 'wrong repository' }) }) });
  await settle();
  assert.equal(f.mainEl.querySelector('.issues-author')!.textContent, 'other repository');
  const loading = f.store.loadDetails();
  const state = f.store.getState();
  f.store.dispose();
  pending[5]!.resolve({ ok: false, json: async () => { notifications++; return { error: 'After dispose' }; } });
  await loading;
  assert.equal(notifications, 1, 'request may finish but cannot publish into disposed UI');
  assert.equal(f.store.getState(), state);
});

test('unsafe or mismatched issue URLs never become Open in GitHub links or Markdown bases', async () => {
  for (const url of ['javascript:alert(1)', 'http://github.com/team/project/issues/9', 'https://evil.example/team/project/issues/9',
    'https://github.com@evil.example/team/project/issues/9', 'https://github.com/team/other/issues/9', 'https://github.com/team/project/issues/4',
    'https://github.com/team/project/issues/9\n', 'https://github.com\\evil.example/team/project/issues/9']) {
    const f = fixture(async (path) => ({ ok: true, json: async () => path.startsWith('/api/github/issues/')
      ? { issue: details(9, { url, body: '[relative](../4)' }) } : { repositories: [repository], repository, issues } }));
    await f.store.load();
    await settle();
    assert.equal(f.mainEl.querySelector('.issues-open-link'), null, url);
    assert.equal(descendants(f.mainEl).some((node) => node.tag === 'a'), false, url);
  }
});

test('malformed conversations fail atomically and never render partial metadata or comments', async () => {
  for (const issue of [details(4), details(9, { comments: [{ id: 1, author: 'reader', createdAt: '', body: 'valid' }, { id: 2, author: 'reader', createdAt: '', body: 42 as unknown as string }] }),
    { ...details(), labels: ['valid', 42] }, { ...details(), state: 'unknown' }]) {
    const f = fixture(async (url) => ({ ok: true, json: async () => url.startsWith('/api/github/issues/')
      ? { issue } : { repositories: [repository], repository, issues } }));
    await f.store.load();
    await settle();
    assert.match(f.mainEl.querySelector('.issues-detail-status')!.textContent, /Invalid issue details response/);
    assert.equal(f.mainEl.querySelector('.issues-author'), null);
    assert.equal(f.mainEl.querySelectorAll('.issues-comment').length, 0);
  }
});

test('manual refresh reloads the list and cached selected conversation without losing selection', async () => {
  const urls: string[] = [];
  let revision = 1;
  const f = fixture(async (url) => {
    urls.push(url);
    return { ok: true, json: async () => url.startsWith('/api/github/issues/')
      ? { issue: details(Number(url.split('/').at(-1)!.split('?')[0]), { body: `Description ${revision}`,
        comments: [{ id: 1, author: 'reader', createdAt: '', body: `Comment ${revision}` }] }) }
      : { repositories: [repository], repository, issues } };
  });
  await f.store.load();
  await settle();
  f.store.select(4);
  await settle();
  revision = 2;
  f.toolbarEl.require('.issues-refresh').click();
  await settle();
  assert.equal(f.store.getState().selectedNumber, 4);
  assert.equal(text(f.mainEl.require('.issues-description')), 'Description 2');
  assert.match(text(f.mainEl.require('.issues-comments')), /Comment 2/);
  assert.deepEqual(urls.slice(-2), ['/api/github/issues?repository=github.com%2Fteam%2Fproject',
    '/api/github/issues/4?repository=github.com%2Fteam%2Fproject']);
});

test('successful refresh keeps selected content while reloading and fetches previously visited conversations on demand', async () => {
  const urls: string[] = [];
  let four = details(4, { body: 'Original four' });
  let refreshing = false;
  let resolveNine!: (value: { ok: boolean; json(): Promise<unknown> }) => void;
  const f = fixture(async (url) => {
    urls.push(url);
    if (url.startsWith('/api/github/issues/9')) {
      if (refreshing) return new Promise((resolve) => { resolveNine = resolve; });
      return { ok: true, json: async () => ({ issue: details(9, { body: 'Original nine' }) }) };
    }
    return { ok: true, json: async () => url.startsWith('/api/github/issues/4')
      ? { issue: four } : { repositories: [repository], repository, issues } };
  });
  await f.store.load();
  await settle();
  f.store.select(4);
  await settle();
  assert.equal(text(f.mainEl.require('.issues-description')), 'Original four');
  f.store.select(9);
  assert.equal(urls.length, 3, 'returning before refresh uses the cached conversation');
  four = details(4, { body: 'Updated four', comments: [{ id: 1, author: 'reader', createdAt: '', body: 'New comment on four' }] });
  refreshing = true;
  f.toolbarEl.require('.issues-refresh').click();
  await settle();
  assert.equal(f.store.getState().selectedNumber, 9);
  assert.equal(text(f.mainEl.require('.issues-description')), 'Original nine', 'selected content stays readable while its fresh conversation loads');
  assert.deepEqual(urls.slice(3), ['/api/github/issues?repository=github.com%2Fteam%2Fproject',
    '/api/github/issues/9?repository=github.com%2Fteam%2Fproject'], 'refresh does not prefetch other conversations');
  resolveNine({ ok: true, json: async () => ({ issue: details(9, { body: 'Updated nine' }) }) });
  await settle();
  f.railEl.children[1]!.click();
  await settle();
  assert.equal(text(f.mainEl.require('.issues-description')), 'Updated four');
  assert.match(text(f.mainEl.require('.issues-comments')), /New comment on four/);
  assert.deepEqual(urls.slice(5), ['/api/github/issues/4?repository=github.com%2Fteam%2Fproject'], 'revisiting fetches the refreshed conversation on demand');
});

test('failed list and conversation refreshes keep the loaded conversation and offer retries', async () => {
  let failure = '';
  let resolveList!: (value: { ok: boolean; json(): Promise<unknown> }) => void;
  const f = fixture(async (url) => {
    if (failure === 'pending' && !url.startsWith('/api/github/issues/')) return new Promise((done) => { resolveList = done; });
    const failed = failure === 'list' && !url.startsWith('/api/github/issues/') || failure === 'details' && url.startsWith('/api/github/issues/');
    return { ok: !failed, json: async () => failed ? { error: 'Check repository access.' }
      : url.startsWith('/api/github/issues/') ? { issue: details(Number(url.split('/').at(-1)!.split('?')[0]),
        { body: 'Loaded description', comments: [{ id: 1, author: 'reader', body: 'Loaded comment', createdAt: '' }] }) }
        : { repositories: [repository], repository, issues } };
  });
  await f.store.load();
  await settle();
  failure = 'pending';
  const pending = f.store.load();
  assert.equal(text(f.mainEl.require('.issues-description')), 'Loaded description', 'loading keeps readable content');
  assert.equal(f.railEl.children.length, 2);
  resolveList({ ok: false, json: async () => ({ error: 'Check repository access.' }) });
  await pending;
  assert.match(text(f.mainEl), /Failed to load issues: Check repository access/);
  assert.match(text(f.mainEl.require('.issues-comments')), /Loaded comment/);
  failure = 'details';
  f.mainEl.require('.issues-retry').click();
  await settle();
  assert.match(text(f.mainEl), /Failed to load issue conversation: Check repository access/);
  assert.equal(text(f.mainEl.require('.issues-description')), 'Loaded description');
  assert.match(text(f.mainEl.require('.issues-comments')), /Loaded comment/);
  failure = '';
  f.mainEl.require('.issues-retry').click();
  await settle();
  assert.equal(f.mainEl.querySelector('.issues-detail-status'), null);
});

test('navigation during a list refresh wins over its starting selection and stays usable after failure', async () => {
  let pending = false;
  let resolve!: (value: { ok: boolean; json(): Promise<unknown> }) => void;
  const f = fixture(async (url) => {
    if (url.startsWith('/api/github/issues/')) return { ok: true, json: async () => ({ issue: details(Number(url.split('/').at(-1)!.split('?')[0])) }) };
    if (pending) return new Promise((done) => { resolve = done; });
    return { ok: true, json: async () => ({ repositories: [repository], repository, issues }) };
  });
  await f.store.load();
  await settle();
  pending = true;
  const refresh = f.store.load();
  f.store.step(1);
  assert.equal(f.store.getState().selectedNumber, 4);
  resolve({ ok: true, json: async () => ({ repositories: [repository], repository, issues }) });
  await refresh;
  await settle();
  assert.equal(f.mainEl.require('.issues-title').textContent, '#4 Issue 4');
  assert.equal(f.store.getState().details?.number, 4);
  const failing = f.store.load();
  resolve({ ok: false, json: async () => ({ error: 'Offline. Retry.' }) });
  await failing;
  f.railEl.children[0]!.click();
  await settle();
  assert.equal(f.mainEl.require('.issues-title').textContent, '#9 Issue 9');
  assert.equal(f.store.getState().details?.number, 9);
  assert.match(text(f.mainEl), /Offline. Retry/);
});

test('a selected issue leaving the open list explains the fallback or empty state without showing its old conversation', async () => {
  let open = issues;
  let pendingDetails = false;
  const f = fixture(async (url) => {
    if (url.startsWith('/api/github/issues/')) {
      if (pendingDetails) return new Promise(() => {});
      return { ok: true, json: async () => ({ issue: details() }) };
    }
    return { ok: true, json: async () => ({ repositories: [repository], repository, issues: open }) };
  });
  await f.store.load();
  await settle();
  open = issues.slice(1);
  pendingDetails = true;
  await f.store.load();
  assert.equal(f.store.getState().selectedNumber, 4);
  assert.equal(f.mainEl.require('.issues-title').textContent, '#4 Issue 4');
  assert.equal(f.mainEl.querySelector('.issues-description'), null);
  assert.match(text(f.mainEl.require('.issues-notice')), /#9.*no longer.*open.*#4/);
  open = [];
  await f.store.load();
  assert.equal(f.store.getState().selectedNumber, null);
  assert.match(text(f.mainEl.require('.issues-notice')), /#4.*no longer.*open/);
  assert.match(text(f.mainEl), /No open issues/);
  assert.equal(f.mainEl.querySelector('.issues-description'), null);
});

test('an invalid selected remote can re-resolve candidates and never lends its conversation to the new repository', async () => {
  const other = { ...repository, id: 'github.com/team/other', name: 'other' };
  let changed = false;
  const urls: string[] = [];
  const f = fixture(async (url) => {
    urls.push(url);
    if (url.startsWith('/api/github/issues/')) {
      if (changed) return new Promise(() => {});
      return { ok: true, json: async () => ({ issue: details() }) };
    }
    if (changed && url.includes(encodeURIComponent(repository.id))) return { ok: false,
      json: async () => ({ code: 'invalid-repository', error: 'Choose a repository from this project’s Git remotes and retry.' }) };
    return { ok: true, json: async () => changed
      ? { repositories: [other, repository], repository: url.includes('?') ? other : null, issues: url.includes('?') ? issues : [] }
      : { repositories: [repository], repository, issues } };
  });
  await f.store.load();
  await settle();
  changed = true;
  await f.store.load();
  assert.ok(f.mainEl.querySelector('.issues-description'), 'invalid remote retains the last conversation');
  f.mainEl.require('.issues-resolve-repositories').click();
  await settle();
  assert.equal(urls.at(-1), '/api/github/issues');
  assert.match(text(f.mainEl), /Choose a repository to view issues/);
  f.mainEl.require('.issues-repository').click();
  await settle();
  assert.equal(f.store.getState().repository?.id, other.id);
  assert.equal(f.mainEl.querySelector('.issues-description'), null, 'same number in another repository is not the old conversation');
  assert.equal(f.mainEl.require('.issues-title').textContent, '#9 Issue 9');
});

test('a failed list refresh still refreshes the selected conversation instead of stranding an earlier detail request', async () => {
  let listFails = false;
  const pending: ((value: { ok: boolean; json(): Promise<unknown> }) => void)[] = [];
  const f = fixture(async (url) => {
    if (url.startsWith('/api/github/issues/')) return new Promise((resolve) => pending.push(resolve));
    return { ok: !listFails, json: async () => listFails ? { error: 'List unavailable' } : { repositories: [repository], repository, issues } };
  });
  await f.store.load();
  assert.equal(pending.length, 1);
  listFails = true;
  await f.store.load();
  assert.equal(pending.length, 2, 'each refresh requests the selected conversation even if listing fails');
  pending[1]!({ ok: true, json: async () => ({ issue: details(9, { body: 'Fresh despite list failure' }) }) });
  await settle();
  pending[0]!({ ok: false, json: async () => ({ error: 'Obsolete detail failure' }) });
  await settle();
  assert.equal(text(f.mainEl.require('.issues-description')), 'Fresh despite list failure');
  assert.match(text(f.mainEl), /List unavailable/);
  assert.equal(f.store.getState().detailsError, null);
});

test('refresh failures remain visible in the toolbar while reading retained content far down the conversation', async () => {
  let fails = false;
  const f = fixture(async (url) => ({ ok: !fails, json: async () => fails ? { error: 'Run gh auth login and retry.' }
    : url.startsWith('/api/github/issues/') ? { issue: details() } : { repositories: [repository], repository, issues } }));
  await f.store.load();
  await settle();
  fails = true;
  f.toolbarEl.require('.issues-refresh').click();
  await settle();
  assert.match(text(f.toolbarEl.require('.issues-refresh-status')), /Run gh auth login and retry/);
  assert.equal(f.toolbarEl.require('.issues-refresh-status').getAttribute('role'), 'status');
  assert.equal(f.toolbarEl.require('.issues-refresh').textContent, 'Retry refresh');
  assert.ok(f.mainEl.querySelector('.issues-description'));
  fails = false;
  f.toolbarEl.require('.issues-refresh').click();
  assert.equal(f.toolbarEl.require('.issues-refresh').textContent, 'Refreshing…');
  await settle();
  assert.equal(f.toolbarEl.querySelector('.issues-refresh-status'), null);
});

test('choosing another issue dismisses the old automatic fallback explanation', async () => {
  let refreshed = false;
  const f = fixture(async (url) => ({ ok: true, json: async () => url.startsWith('/api/github/issues/')
    ? { issue: details(9, { number: Number(url.split('/').at(-1)!.split('?')[0]) }) }
    : { repositories: [repository], repository, issues: refreshed ? [issues[1], { ...issues[0], number: 3 }] : issues } }));
  await f.store.load();
  await settle();
  refreshed = true;
  await f.store.load();
  await settle();
  assert.match(text(f.mainEl.require('.issues-notice')), /Showing #4/);
  f.store.select(3);
  assert.equal(f.mainEl.querySelector('.issues-notice'), null, 'the explanation must not claim a different issue is still being shown');
});
