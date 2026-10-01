import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../../public/app.js';
import { Element } from './fake-dom.js';

function browserStub() {
  const elements = Object.fromEntries(['tabs-wrapper', 'tabs', 'body', 'rail', 'rail-divider', 'toolbar', 'main', 'shortcut-help'].map((id) => [id, new Element('div')]));
  elements.body.clientWidth = 1006;
  elements['rail-divider'].offsetWidth = 6;
  elements.toolbar.isRoot = true;
  const document = {
    getElementById: (id) => elements[id],
    addEventListener() {}, removeEventListener() {},
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
  };
  const window = { localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {} };
  return { document, window, elements };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
class EventSourceStub { addEventListener() {} close() {} }

test('toolbar deletion works without a file, confirms fresh risks, cancels, then deletes both worktree and branch', async () => {
  const { document, window, elements } = browserStub();
  let worktrees = [{ path: '/linked', branch: 'feature', deletionReason: null },
    { path: '/main', branch: 'main', deletionReason: 'Main worktree cannot be deleted' }];
  let confirmed = false;
  const messages = [];
  window.confirm = (message) => { messages.push(message); return confirmed; };
  const requests = [];
  const app = await startApp({ document, window, EventSource: EventSourceStub,
    now: () => 1000, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      let body = [];
      if (url === '/api/worktrees') body = worktrees;
      if (url.startsWith('/api/worktree-deletion')) {
        if (options?.method === 'DELETE') {
          worktrees = worktrees.slice(1);
          body = { removed: true, branchDeleted: true };
        } else body = { path: '/linked', branch: 'feature', hasUncommittedWork: true,
          ignoredFileCount: 3, localOnlyCommitCount: 2, confirmation: 'fresh-token' };
      }
      return { ok: true, json: async () => body };
    },
  });
  try {
    await settle();
    const button = elements.toolbar.querySelector('.viewer__delete-worktree');
    assert.ok(button);
    assert.equal(button.disabled, false);
    const ignoreButton = elements.toolbar.querySelector('.watch-ignore');
    assert.equal(ignoreButton['aria-pressed'], 'true');
    ignoreButton.click();
    assert.equal(ignoreButton['aria-pressed'], 'false');
    assert.equal(elements.toolbar.querySelector('.viewer__delete-worktree'), button);
    assert.equal(button.disabled, false);
    button.click();
    await settle();
    assert.match(messages[0], /\/linked/);
    assert.match(messages[0], /feature/);
    assert.match(messages[0], /Uncommitted work: yes/);
    assert.match(messages[0], /Local-only commits: 2/);
    assert.match(messages[0], /Ignored files: 3/);
    assert.match(messages[0], /remote-tracking refs.*no fetch/i);
    assert.match(messages[0], /irreversib/i);
    assert.equal(requests.some(({ options }) => options?.method === 'DELETE'), false);
    confirmed = true;
    button.click();
    await settle();
    await settle();
    const mutations = requests.filter(({ options }) => options?.method === 'DELETE');
    assert.deepEqual(mutations, [{ url: '/api/worktree-deletion?worktree=%2Flinked',
      options: { method: 'DELETE', headers: { 'X-Canopy-Confirmation': 'fresh-token' } } }]);
    assert.equal(elements.tabs.children.length, 1);
    const protectedButton = elements.toolbar.querySelector('.viewer__delete-worktree');
    assert.equal(protectedButton.disabled, true);
    assert.match(protectedButton.title, /Main worktree/);
    assert.equal(elements.toolbar.querySelector('.watch-ignore')['aria-pressed'], 'false');
  } finally { app.dispose(); }
});

test('switching tabs during preview keeps the clicked path, prevents repeat deletion and refreshes after partial failure', async () => {
  const { document, window, elements } = browserStub();
  const original = [{ path: '/linked', branch: 'feature' }, { path: '/other', branch: 'other' }];
  const requests = [];
  let resolvePreview;
  const pending = new Promise((resolve) => { resolvePreview = resolve; });
  window.confirm = () => true;
  let removed = false;
  const app = await startApp({ document, window, EventSource: EventSourceStub,
    now: () => 1000, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith('/api/worktree-deletion')) {
        if (!options) return pending;
        removed = true;
        return { ok: false, json: async () => ({ removed: true,
          error: 'Worktree removed, but local branch "feature" was not deleted: Git refused' }) };
      }
      return { ok: true, json: async () => url === '/api/worktrees' ? (removed ? original.slice(1) : original) : [] };
    },
  });
  try {
    await settle();
    const clicked = elements.toolbar.querySelector('.viewer__delete-worktree');
    clicked.click();
    clicked.click();
    assert.equal(clicked.disabled, true);
    elements.tabs.children[1].click();
    elements.toolbar.querySelector('.viewer__delete-worktree').click();
    resolvePreview({ ok: true, json: async () => ({ path: '/linked', branch: 'feature',
      hasUncommittedWork: false, ignoredFileCount: 0, localOnlyCommitCount: 0, confirmation: 'clicked-token' }) });
    await settle();
    await settle();
    assert.equal(requests.filter(({ url }) => url.startsWith('/api/worktree-deletion')).length, 2);
    const mutation = requests.find(({ options }) => options?.method === 'DELETE');
    assert.equal(mutation.url, '/api/worktree-deletion?worktree=%2Flinked');
    assert.equal(elements.tabs.children.length, 1);
    assert.match(elements.tabs.children[0].querySelector('.tabs__path').textContent, /\/other/);
    assert.match(elements.toolbar.querySelector('.viewer__deletion-status').textContent, /removed.*branch.*not deleted/);
    assert.equal(elements.toolbar.querySelector('.viewer__delete-worktree').disabled, false);
  } finally { app.dispose(); }
});

test('protected or failed fresh preview shows an error without asking for confirmation or deleting', async () => {
  for (const result of [
    { ok: true, body: { path: '/linked', branch: 'feature', reason: 'Locked worktree cannot be deleted' } },
    { ok: true, body: { path: '/linked', branch: 'feature', reason: 'Worktree contains assume-unchanged files; deletion cannot safely assess hidden changes' } },
    { ok: true, body: { path: '/linked', branch: 'feature', reason: 'Worktree contains skip-worktree files; deletion cannot safely assess hidden changes' } },
    { ok: true, body: { path: '/linked', branch: 'feature', reason: 'Sparse-checkout worktrees cannot be safely assessed for deletion' } },
    { ok: true, body: { path: '/linked', branch: 'feature', reason: 'Worktree contains submodules (gitlinks); deletion cannot safely assess their contents, even when unpopulated' } },
    { ok: false, body: { error: 'Cannot safely assess Git state' } },
  ]) {
    const { document, window, elements } = browserStub();
    const requests = [];
    window.confirm = () => { assert.fail('Unsafe preview must never reach confirmation'); };
    const app = await startApp({ document, window, EventSource: EventSourceStub,
      now: () => 1000, setInterval: () => 1, clearInterval() {},
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (url.startsWith('/api/worktree-deletion')) return { ok: result.ok, json: async () => result.body };
        return { ok: true, json: async () => url === '/api/worktrees' ? [{ path: '/linked' }] : [] };
      },
    });
    try {
      elements.toolbar.querySelector('.viewer__delete-worktree').click();
      await settle();
      assert.equal(elements.toolbar.querySelector('.viewer__deletion-status').textContent, result.body.reason ?? result.body.error);
      assert.equal(requests.some(({ options }) => options?.method === 'DELETE'), false);
    } finally { app.dispose(); }
  }
});
