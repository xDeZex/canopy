import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../../public/app.js';
import { Element } from './fake-dom.js';
import { EventEmitter } from 'node:events';
import { createRequestHandler } from '../../server/handle-request.js';
import { watchWorktree } from '../../server/watcher.js';
import { getFileTree } from '../../server/status.js';

function browserStub() {
  const elements = Object.fromEntries(['tabs-wrapper', 'tabs', 'body', 'rail', 'rail-divider', 'toolbar', 'main', 'shortcut-help'].map((id) => [id, new Element('div')]));
  elements.body.clientWidth = 1006;
  elements['rail-divider'].offsetWidth = 6;
  elements.toolbar.isRoot = true;
  elements['shortcut-help'].hidden = true;
  const listeners = { keydown: new Set(), click: new Set() };
  const document = {
    getElementById: (id) => elements[id],
    addEventListener: (event, listener) => listeners[event].add(listener),
    removeEventListener: (event, listener) => listeners[event].delete(listener),
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
  };
  const windowListeners = new Map();
  const window = {
    localStorage: { getItem: () => null },
    addEventListener(event, listener) {
      if (!windowListeners.has(event)) windowListeners.set(event, new Set());
      windowListeners.get(event).add(listener);
    },
    removeEventListener(event, listener) { windowListeners.get(event)?.delete(listener); },
    emit(event) { windowListeners.get(event)?.forEach((listener) => listener()); },
  };
  const keydownListeners = listeners.keydown;
  const pressKey = (key, extra = {}) => [...keydownListeners].forEach((listener) => listener({
    key, target: { tagName: 'BODY' }, preventDefault() {}, ...extra,
  }));
  return { document, window, elements, keydownListeners, pressKey };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

class EventSourceStub {
  addEventListener() {}
  close() {}
}

test('malformed startup worktrees use the existing error UI without opening live streams', async () => {
  const browser = browserStub();
  let opened = 0;
  class EventSource extends EventSourceStub { constructor() { super(); opened++; } }
  const app = await startApp({ ...browser, EventSource,
    fetch: async () => ({ ok: true, json: async () => [{ path: 42 }] }),
    setInterval: () => { assert.fail('failed startup must not schedule updates'); }, clearInterval() {},
  });
  try {
    assert.match(browser.elements.main.children[0].textContent, /Failed to load worktrees: Invalid worktrees/);
    assert.equal(opened, 0);
  } finally { app.dispose(); }
});

test('sidebar to main navigation retains File preference, same-file mounts and refresh cleanup', async () => {
  const browser = browserStub();
  const anchored = { id: 't', file: 'a.js', side: 'modified', line_range: { start: 1, end: 2 },
    created_at: '2026-10-01T12:00:00Z', resolved: false,
    messages: [{ id: 'm', author: 'user', text: 'Anchored full text', created_at: '2026-10-01T12:00:00Z' }] };
  const { file, side, line_range, ...general } = { ...anchored, id: 'g', messages: [{ ...anchored.messages[0], text: 'General full text' }] };
  let threads = [anchored, general];
  const sources = [];
  class EventSource extends EventSourceStub {
    constructor(url) { super(); this.url = url; sources.push(this); }
  }
  const mounts = [];
  const reveals = [];
  const updates = [];
  let disposals = 0;
  const app = await startApp({ ...browser, EventSource, setInterval: () => 1, clearInterval() {},
    fetch: async (url) => ({ ok: true, json: async () => {
      if (url === '/api/worktrees') return [{ path: '/a' }];
      if (url.startsWith('/api/files')) return [{ type: 'file', name: 'a.js', path: 'a.js', status: 'clean' }];
      if (url.startsWith('/api/file-content')) return { head: 'one\ntwo', working: 'one\ntwo' };
      if (url.startsWith('/api/comments')) return { threads, warning: null };
      return [];
    } }),
    mountEditor: async (_container, options) => {
      mounts.push(options);
      return { dispose() { disposals++; }, revealThread: (id) => reveals.push(id), updateThreads: (next) => updates.push(next) };
    },
    mountDiffEditor() { assert.fail('navigation must retain File preference'); },
  });
  try {
    await settle();
    const buttons = () => browser.elements.rail.querySelectorAll('.comment-index__button');
    buttons()[0].click();
    assert.equal(browser.elements.main.querySelector('.review-thread__text').textContent, 'General full text');
    buttons()[1].click();
    await settle();
    assert.equal(mounts.length, 1);
    assert.deepEqual(reveals, ['t']);
    buttons()[1].click();
    assert.equal(mounts.length, 1);
    browser.elements.rail.querySelector('.rail__file').click();
    await settle();
    assert.equal(mounts.length, 1, 'picking the already-open file returns/stays in the editor without remount');
    threads = [general];
    sources.find((source) => source.url.startsWith('/api/watch?')).onmessage({ data: JSON.stringify({ paths: ['.canopy/comments.yaml'] }) });
    await settle();
    assert.deepEqual(updates.at(-1), []);
    assert.equal(buttons().length, 1);
    buttons()[0].click();
    assert.equal(disposals, 1);
    threads = [];
    sources.find((source) => source.url.startsWith('/api/watch?')).onmessage({ data: JSON.stringify({ paths: ['.canopy/comments.yaml'] }) });
    await settle();
    assert.match(browser.elements.main.querySelector('.empty').textContent, /No comments without a file/);
    browser.elements.rail.querySelector('.rail__file').click();
    await settle();
    assert.equal(mounts.length, 2);
  } finally { app.dispose(); }
});

test('toolbar ignore preference persists, reconnects live observation, and is available without an active worktree', async () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  async function launch(worktrees) {
    const browser = browserStub();
    browser.window.localStorage = storage;
    const sources = [];
    class EventSource {
      constructor(url) { this.url = url; this.closed = false; sources.push(this); }
      addEventListener() {}
      close() { this.closed = true; }
    }
    const app = await startApp({
      ...browser, EventSource,
      fetch: async (url) => ({ ok: true, json: async () => url === '/api/worktrees' ? worktrees : [] }),
      now: () => 1000, setInterval: () => 1, clearInterval: () => {},
    });
    return { ...browser, app, sources };
  }
  const first = await launch([{ path: '/linked' }]);
  const toggle = first.elements.toolbar.querySelector('.watch-ignore');
  assert.ok(toggle);
  assert.equal(toggle.textContent, 'Ignore .gitignore paths');
  assert.equal(toggle['aria-pressed'], 'true');
  assert.ok(first.sources.find((source) => source.url === '/api/watch-activity?ignoreGitignore=true'));
  toggle.click();
  assert.equal(toggle['aria-pressed'], 'false');
  assert.ok(first.sources.find((source) => source.url === '/api/watch?worktree=%2Flinked&ignoreGitignore=false'));
  assert.ok(first.sources.find((source) => source.url === '/api/watch-activity?ignoreGitignore=false'));
  assert.equal(first.sources.filter((source) => source.closed).length, 2);
  first.app.dispose();
  const second = await launch([]);
  const emptyToggle = second.elements.toolbar.querySelector('.watch-ignore');
  assert.equal(second.elements.toolbar.hidden, false);
  assert.equal(emptyToggle['aria-pressed'], 'false');
  emptyToggle.click();
  assert.equal(second.elements.toolbar.querySelector('.watch-ignore')['aria-pressed'], 'true');
  assert.equal(second.sources.at(-1).url, '/api/watch-activity?ignoreGitignore=true');
  second.app.dispose();
});

test('index startup reconciliation and later operations update both rails without reloading content or closing menus', async () => {
  const { document, window, elements } = browserStub();
  const watched = new Map();
  const timers = new Map();
  const urls = [];
  let timerId = 0;
  let phase = 'staged';
  let mounts = 0;
  let disposals = 0;
  const indexPath = '/main/.git/worktrees/linked/index';
  let resolveIndex;
  const pendingIndex = new Promise((resolve) => { resolveIndex = resolve; });
  // tracked.txt stays on disk; gone.txt is a staged addition already absent
  // from disk. Resetting staged.txt keeps it on disk and normalized as added.
  const snapshots = {
    staged: { tracked: 'tracked.txt\0staged.txt\0gone.txt\0', status: 'A  staged.txt\0AD gone.txt\0' },
    cachedRemoval: { tracked: 'staged.txt\0gone.txt\0', status: 'D  tracked.txt\0?? tracked.txt\0A  staged.txt\0AD gone.txt\0' },
    resetGone: { tracked: 'staged.txt\0', status: 'D  tracked.txt\0?? tracked.txt\0A  staged.txt\0' },
    resetPresent: { tracked: '', status: 'D  tracked.txt\0?? tracked.txt\0?? staged.txt\0' },
  };
  const runGit = async (args, cwd) => {
    assert.equal(cwd, '/linked');
    if (args[0] === 'rev-parse') return pendingIndex;
    if (args[0] === 'ls-files') return snapshots[phase].tracked;
    if (args[0] === 'status') return snapshots[phase].status;
    throw new Error(`unexpected Git request: ${args}`);
  };
  const handler = createRequestHandler({
    getWorktrees: async () => [{ path: '/linked', head: 'unchanged', branch: 'linked' }],
    getTree: (path, ref) => getFileTree(path, ref, runGit, async () => ({ mtimeMs: 1000 })),
    getContent: async () => ({ head: 'same HEAD content', working: 'same disk content' }),
    getCommits: async () => [{ sha: 'unchanged', message: 'same commit', date: '2026-01-01' }],
    watchWorktree: (path, onChange, options) => watchWorktree(path, onChange, {
      ...options, runGit,
      readFile: () => '', stat: () => ({ isDirectory: () => false, isFile: () => true }),
      watch: (target) => {
        const watcher = Object.assign(new EventEmitter(), { close: async () => {} });
        watched.set(target, watcher);
        return watcher;
      },
      setTimer: (fn) => { timers.set(++timerId, fn); return timerId; },
      clearTimer: (id) => timers.delete(id),
    }),
    subscribeToWorktreeChanges: () => () => {},
    subscribeToActivity: () => () => {},
  });
  const describeRequest = (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    return { method: 'GET', pathname, searchParams };
  };
  class EventSource {
    constructor(url) {
      this.listeners = new Map();
      this.ready = handler(describeRequest(url)).then((response) => {
        this.cleanup = response.stream.subscribe((frame) => {
          const name = frame.match(/^event: (.+)\n/)?.[1];
          const event = { data: frame.match(/data: (.+)\n/)[1] };
          if (name) this.listeners.get(name)?.(event);
          else this.onmessage?.(event);
        });
      });
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    close() { this.ready.then(() => this.cleanup()); }
  }
  const app = await startApp({
    document, window, EventSource,
    fetch: async (url) => {
      urls.push(url);
      const response = await handler(describeRequest(url));
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
    mountEditor: async () => { mounts++; return { dispose: () => disposals++ }; },
    now: () => 1000, setInterval: () => 1, clearInterval: () => {},
  });
  try {
    await settle();
    const rows = (selector) => elements.rail.querySelector(selector).querySelectorAll('.rail__file');
    const statuses = (selector) => rows(selector).map((row) => [row.title,
      row.className.match(/status-(\w+)/)[1]]);
    assert.deepEqual(statuses('.rail__tree'), [
      ['gone.txt', 'deleted'], ['staged.txt', 'added'], ['tracked.txt', 'clean'],
    ]);
    assert.deepEqual(statuses('.changed-files'), [['gone.txt', 'deleted'], ['staged.txt', 'added']]);
    rows('.rail__tree').find((row) => row.title === 'tracked.txt').click();
    await settle();
    assert.equal(mounts, 1);
    elements.toolbar.querySelector('.commit-picker__trigger').click();
    const menu = elements.toolbar.querySelector('.commit-picker__menu');
    const toolbarChildren = [...elements.toolbar.children];
    assert.equal(menu.classList.contains('is-open'), true);
    const before = urls.length;

    // The earlier API snapshot is mounted before index resolution or its
    // initial scan completes. Git changes only the index during that gap,
    // so ignoreInitial supplies no add/change event for the cached removal.
    assert.equal(watched.has(indexPath), false);
    watched.get('/linked').emit('ready');
    phase = 'cachedRemoval';
    resolveIndex(`${indexPath}\n`);
    await settle();
    assert.equal(urls.length, before, 'index resolution alone does not reconcile before observation starts');
    assert.deepEqual(statuses('.changed-files'), [['gone.txt', 'deleted'], ['staged.txt', 'added']]);
    watched.get(indexPath).emit('change', '/main/.git/index');
    assert.equal(timers.size, 0, 'another worktree cannot invalidate this status');
    watched.get(indexPath).emit('ready');
    await settle();
    assert.deepEqual(urls.slice(before), ['/api/files?worktree=%2Flinked']);
    assert.deepEqual(statuses('.rail__tree'), [
      ['gone.txt', 'deleted'], ['staged.txt', 'added'], ['tracked.txt', 'added'],
    ]);
    assert.deepEqual(statuses('.changed-files'), [
      ['gone.txt', 'deleted'], ['staged.txt', 'added'], ['tracked.txt', 'added'],
    ]);
    assert.equal(mounts, 1);
    assert.equal(disposals, 0);
    assert.equal(elements.toolbar.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.classList.contains('is-open'), true);

    // Subsequent operations still arrive as ordinary index replacements.
    const invalidate = async (nextPhase) => {
      phase = nextPhase;
      watched.get(indexPath).emit('unlink', indexPath);
      watched.get(indexPath).emit('add', indexPath);
      for (const fn of timers.values()) fn();
      timers.clear();
      await settle();
    };

    await invalidate('resetGone');
    assert.deepEqual(statuses('.rail__tree'), [['staged.txt', 'added'], ['tracked.txt', 'added']]);
    assert.deepEqual(statuses('.changed-files'), [['staged.txt', 'added'], ['tracked.txt', 'added']]);
    await invalidate('resetPresent');
    assert.deepEqual(statuses('.rail__tree'), [['staged.txt', 'added'], ['tracked.txt', 'added']]);
    assert.deepEqual(statuses('.changed-files'), [['staged.txt', 'added'], ['tracked.txt', 'added']]);
    assert.deepEqual(urls.slice(before), Array(3).fill('/api/files?worktree=%2Flinked'));
    assert.ok(rows('.rail__tree').find((row) => row.title === 'tracked.txt').classList.contains('is-active'));
    assert.ok(rows('.changed-files').find((row) => row.title === 'tracked.txt').classList.contains('is-active'));
    assert.equal(mounts, 1);
    assert.equal(disposals, 0);
    assert.deepEqual(elements.toolbar.children, toolbarChildren);
    assert.equal(elements.toolbar.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.classList.contains('is-open'), true);
  } finally {
    app.dispose();
  }
});

// Two worktrees, one modified file and no commits, served from memory.
function fakeFetch(urls = []) {
  const responses = {
    '/api/worktrees': [{ path: '/a', branch: 'a' }, { path: '/b', branch: 'b' }],
    '/api/files': [{ type: 'file', name: 'f.js', path: 'f.js', status: 'modified' }],
    '/api/commits': [],
    '/api/file-content': { head: 'old', working: 'new' },
  };
  return async (url) => {
    urls.push(url);
    return { ok: true, json: async () => responses[url.split('?')[0]] };
  };
}

test('startup renders an empty workspace and opens the repo-wide stream after loading', async () => {
  const { document, window, elements } = browserStub();
  const urls = [];
  const sources = [];
  class EventSource {
    constructor(url) { sources.push(this); this.url = url; }
    addEventListener() {}
    close() { this.closed = true; }
  }
  try {
    const app = await startApp({
      document, window, EventSource,
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, json: async () => [] };
      },
    });
    assert.deepEqual(urls, ['/api/worktrees']);
    assert.deepEqual(sources.map((source) => source.url), ['/api/watch-worktrees', '/api/watch-activity?ignoreGitignore=true']);
    assert.equal(elements.main.children[0].textContent, 'No worktrees found.');
    assert.equal(elements.toolbar.hidden, false);
    sources[0].onmessage({ data: '[]' });
    assert.equal(elements.main.children[0].textContent, 'No worktrees found.');
    app.dispose();
    assert.equal(sources[0].closed, true);
    assert.equal(sources[1].closed, true);
  } finally {
    // No browser globals are stubbed: every module takes its own dependencies.
  }
});

test('activity stream updates inactive tabs and elapsed labels tick without replacing tabs; dispose clears timer', async () => {
  const { document, window, elements } = browserStub();
  const sources = [];
  let tick;
  let cleared;
  class EventSource {
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener() {}
    close() { this.closed = true; }
  }
  const app = await startApp({ document, window, EventSource, fetch: fakeFetch(),
    now: () => 1_000_000,
    setInterval: (fn, ms) => { tick = fn; assert.equal(ms, 30_000); return 17; },
    clearInterval: (id) => { cleared = id; },
  });
  const tab = elements.tabs.children[1];
  sources.find((source) => source.url === '/api/watch-activity?ignoreGitignore=true').onmessage({ data: JSON.stringify({ '/a': null, '/b': 940_000 }) });
  assert.equal(tab.querySelector('.tabs__edit-time').textContent, '1m ago');
  tick();
  assert.equal(elements.tabs.children[1], tab);
  app.dispose();
  assert.equal(cleared, 17);
  assert.ok(sources.every((source) => source.closed));
});

test('commit ages share the single app interval across repeated menu opens and dispose cancels it', async () => {
  const { document, window, elements } = browserStub();
  const date = '2026-09-27T12:00:00Z';
  const timestamp = Date.parse(date);
  let currentTime = timestamp + 30_000;
  const timers = new Map();
  const cancelled = [];
  const sources = [];
  const urls = [];
  let subscriptions = 0;
  class EventSource {
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener() {}
    close() { this.closed = true; }
  }
  const request = fakeFetch(urls);
  const app = await startApp({
    document, window, EventSource, now: () => currentTime,
    fetch: (url) => {
      if (url.startsWith('/api/commits')) {
        urls.push(url);
        return Promise.resolve({ ok: true, json: async () => [{ sha: 'abcdef123', message: 'Base', date }] });
      }
      return request(url);
    },
    setInterval: (fn, ms) => {
      assert.equal(ms, 30_000);
      timers.set(++subscriptions, fn);
      return subscriptions;
    },
    clearInterval: (id) => { cancelled.push(id); timers.delete(id); },
  });
  try {
    await settle();
    const picker = elements.toolbar.querySelector('.commit-picker');
    const trigger = picker.querySelector('.commit-picker__trigger');
    const menu = picker.querySelector('.commit-picker__menu');
    const children = [...menu.children];
    const label = menu.querySelector('.commit-picker__item-time');
    const tab = elements.tabs.children[0];
    sources.find((source) => source.url === '/api/watch-activity?ignoreGitignore=true').onmessage({ data: JSON.stringify({ '/a': timestamp }) });
    assert.equal(label.textContent, 'just now');
    trigger.click();
    const requests = urls.length;
    const streams = sources.length;
    currentTime = timestamp + 60_000;
    assert.equal(timers.size, 1);
    timers.get(1)();
    assert.equal(label.textContent, '1 minute ago');
    assert.equal(tab.querySelector('.tabs__edit-time').textContent, '1m ago');
    assert.equal(elements.tabs.children[0], tab);
    assert.equal(menu.classList.contains('is-open'), true);
    trigger.click();
    currentTime = timestamp + 3_600_000;
    for (let i = 0; i < 3; i++) {
      trigger.click();
      assert.equal(label.textContent, '1 hour ago', 'opening refreshes without an interval tick');
      assert.equal(menu.classList.contains('is-open'), true);
      trigger.click();
    }
    assert.equal(elements.toolbar.querySelector('.commit-picker'), picker);
    assert.equal(picker.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.querySelector('.commit-picker__item-time'), label);
    assert.equal(menu.children.length, children.length);
    children.forEach((child, index) => assert.equal(menu.children[index], child));
    assert.equal(urls.length, requests);
    assert.equal(sources.length, streams);
    assert.equal(subscriptions, 1);
    assert.equal(timers.size, 1);
  } finally {
    app.dispose();
  }
  assert.equal(timers.size, 0);
  assert.deepEqual(cancelled, [1]);
  assert.ok(sources.every((source) => source.closed));
});

test('origin/main SSE refresh moves and removes the open dropdown divider without disturbing the locked viewer', async (t) => {
  const { document, window, elements } = browserStub();
  const urls = [];
  const sources = [];
  let origin = 'aaa';
  let mounts = 0;
  let disposals = 0;
  const worktrees = () => [
    { path: '/a', branch: 'main', head: 'bbb', originMainSha: origin },
    { path: '/b', branch: 'topic', head: 'bbb', originMainSha: origin },
  ];
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  class EventSource {
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener() {}
    close() { this.closed = true; }
  }
  const app = await startApp({
    document, window, EventSource, now: () => 1000,
    setInterval: () => 17, clearInterval() {},
    mountDiffEditor: () => { mounts++; return { dispose() { disposals++; } }; },
    fetch: async (url) => {
      urls.push(url);
      const parsed = new URL(url, 'http://localhost');
      const responses = {
        '/api/worktrees': worktrees(),
        '/api/files': [{ type: 'file', name: 'f.js', path: 'f.js', status: 'modified' }],
        '/api/file-content': { head: 'locked base', working: 'unchanged working' },
        '/api/commits': [
          { sha: 'bbb', message: 'local', isOriginMain: origin === 'bbb', touchesFile: false },
          { sha: 'aaa', message: 'pushed', isOriginMain: origin === 'aaa', touchesFile: parsed.searchParams.has('file') },
        ],
      };
      return { ok: true, json: async () => responses[parsed.pathname] };
    },
  });
  t.after(() => app.dispose());
  await flush();
  elements.rail.querySelector('.rail__file').click();
  await flush();
  const picker = elements.toolbar.querySelector('.commit-picker');
  const menu = picker.querySelector('.commit-picker__menu');
  menu.querySelectorAll('.commit-picker__item').at(-1).click();
  await flush();
  assert.equal(picker.querySelector('.commit-picker__trigger-title').textContent, 'pushed');
  picker.querySelector('.commit-picker__trigger').click();
  const tab = elements.tabs.children[0];
  const rail = elements.rail.children[0];
  const editor = elements.main.children[0];
  const counts = { mounts, disposals };
  const stream = sources.find((source) => source.url === '/api/watch-worktrees');
  for (const sha of ['bbb', null, 'outside-history', 'aaa']) {
    origin = sha;
    const before = urls.length;
    stream.onmessage({ data: JSON.stringify(worktrees()) });
    await flush();
    assert.deepEqual(urls.slice(before), ['/api/commits?worktree=%2Fa&file=f.js']);
    assert.equal(elements.toolbar.querySelector('.commit-picker'), picker);
    assert.equal(picker.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.classList.contains('is-open'), true);
    assert.equal(picker.querySelector('.commit-picker__trigger-title').textContent, 'pushed');
    assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');
    assert.equal(elements.tabs.children[0], tab);
    assert.equal(tab['aria-selected'], 'true');
    assert.equal(elements.rail.children[0], rail);
    assert.equal(elements.rail.querySelector('.rail__file').classList.contains('is-active'), true);
    assert.equal(elements.main.children[0], editor);
    assert.deepEqual({ mounts, disposals }, counts, 'commit refresh does not remount or dispose the editor');
    const rows = menu.children.slice(1).map((row) => row.classList.contains('commit-picker__divider')
      ? 'divider' : row.querySelector('.commit-picker__item-sha').textContent);
    assert.deepEqual(rows, sha === 'bbb' ? ['divider', 'bbb', 'aaa']
      : sha === 'aaa' ? ['bbb', 'divider', 'aaa'] : ['bbb', 'aaa']);
    assert.equal(menu.querySelectorAll('.commit-picker__item').at(-1).classList.contains('commit-picker__item--touches-file'), true);
  }
  assert.equal(sources.filter((source) => source.url.startsWith('/api/watch?')).length, 1, 'no worktree stream reconnect');
});

test('an invalid locked base after a history SSE event shows errors and retains the lock until Auto', async (t) => {
  const { document, window, elements } = browserStub();
  const sources = [];
  const urls = [];
  const sha = 'abcdef1234567890';
  let invalid = false;
  let mounts = 0;
  class EventSource {
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener() {}
    close() {}
  }
  const app = await startApp({
    document, window, EventSource, now: () => 1000,
    setInterval: () => 1, clearInterval() {},
    mountDiffEditor: () => { mounts++; return { dispose() {} }; },
    fetch: async (url) => {
      urls.push(url);
      const { pathname, searchParams } = new URL(url, 'http://localhost');
      if (invalid && searchParams.has('ref')) return { ok: false, status: 500 };
      const responses = {
        '/api/worktrees': [{ path: '/a', head: 'old' }],
        '/api/files': [{ type: 'file', name: 'f.js', path: 'f.js', status: 'modified' }],
        '/api/commits': invalid ? [{ sha: 'new', message: 'Rewritten history' }] : [{ sha, message: 'Base' }],
        '/api/file-content': { head: searchParams.has('ref') ? 'locked base' : 'HEAD base', working: 'working' },
      };
      return { ok: true, json: async () => responses[pathname] };
    },
  });
  t.after(() => app.dispose());
  await settle();
  elements.rail.querySelector('.rail__file').click();
  await settle();
  const picker = elements.toolbar.querySelector('.commit-picker');
  const menu = picker.querySelector('.commit-picker__menu');
  menu.querySelector('.commit-picker__item-sha').parentElement.click();
  await settle();
  picker.querySelector('.commit-picker__trigger').click();
  const before = urls.length;
  invalid = true;
  sources.find((source) => source.url === '/api/watch-worktrees').onmessage({
    data: JSON.stringify([{ path: '/a', head: 'new' }]),
  });
  const mountedWhileLoading = mounts;
  await settle();

  assert.deepEqual(urls.slice(before), [
    `/api/files?worktree=%2Fa&ref=${sha}`,
    '/api/commits?worktree=%2Fa&file=f.js',
    `/api/file-content?worktree=%2Fa&file=f.js&ref=${sha}`,
  ], 'failed locked requests never retry with Auto');
  assert.equal(elements.rail.querySelector('.rail__message').textContent, 'Failed to load files: request failed with status 500');
  assert.equal(elements.main.children[0].textContent, 'Failed to load file: request failed with status 500');
  assert.equal(mounts, mountedWhileLoading, 'failed responses do not mount a comparison');
  assert.equal(elements.main.classList.contains('main--viewer'), false);
  assert.equal(elements.toolbar.querySelector('.commit-picker'), picker);
  assert.equal(picker.querySelector('.commit-picker__trigger-title').textContent, 'abcdef1');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(menu.children[0].classList.contains('is-selected'), false);
  assert.equal(menu.classList.contains('is-open'), true);
  assert.equal(elements.toolbar.querySelector('.viewer__filename').textContent, 'f.js');

  const beforeAuto = urls.length;
  menu.children[0].click();
  await settle();
  assert.deepEqual(urls.slice(beforeAuto), [
    '/api/files?worktree=%2Fa', '/api/file-content?worktree=%2Fa&file=f.js',
  ]);
  assert.equal(picker.querySelector('.commit-picker__trigger-title').textContent, 'HEAD');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  assert.equal(menu.children[0].classList.contains('is-selected'), true);
  assert.equal(elements.rail.querySelector('.rail__message'), null);
  assert.equal(mounts, mountedWhileLoading + 1);
});

const flushApp = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function viewerApp(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const browser = browserStub();
  const sources = [];
  const urls = [];
  const controllers = [];
  const api = {
    worktrees: [{ path: '/a', branch: 'main', head: 'aaa' }, { path: '/b', branch: 'topic', head: 'bbb' }],
    files: ['f.js', 'g.js'].map((path) => ({ type: 'file', name: path, path, status: 'modified' })),
    commits: [{ sha: 'aaa', message: 'first' }, { sha: 'older', message: 'older' }],
    content: { head: 'old', working: 'new' },
  };
  class EventSource {
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener() {}
    close() { this.closed = true; }
  }
  const mount = (_container, options) => {
    const controller = {
      options, disposed: false,
      state: { scrollTop: 0, cursor: 1, selection: [1, 1], change: 0 },
      dispose() { this.disposed = true; },
      nextChange() { this.state.change++; },
      prevChange() { this.state.change--; },
    };
    controllers.push(controller);
    return controller;
  };
  const app = await startApp({
    ...browser, EventSource, mountDiffEditor: mount, mountEditor: mount,
    languageForPath: () => 'javascript', now: () => 1000,
    setInterval: () => 17, clearInterval() {},
    fetch: async (url) => {
      urls.push(url);
      const key = new URL(url, 'http://localhost').pathname.slice('/api/'.length);
      return { ok: true, json: async () => api[key === 'file-content' ? 'content' : key] };
    },
  });
  t.after(() => app.dispose());
  await flushApp();
  browser.elements.rail.querySelector('.rail__file').click();
  await flushApp();
  const updateWorktrees = async (worktrees) => {
    api.worktrees = worktrees;
    sources.find((source) => source.url === '/api/watch-worktrees')
      .onmessage({ data: JSON.stringify(worktrees) });
    await flushApp();
  };
  return { ...browser, api, sources, urls, controllers, updateWorktrees };
}

test('unrelated worktree additions and removals and branch labels preserve the active viewer and navigation', async (t) => {
  const { elements, api, sources, urls, controllers, updateWorktrees, pressKey } = await viewerApp(t);
  const controller = controllers[0];
  Object.assign(controller.state, { scrollTop: 420, cursor: 12, selection: [8, 12] });
  pressKey('l');
  const editor = elements.main.children[0];
  const rail = elements.rail.children[0];
  const menu = elements.toolbar.querySelector('.commit-picker__menu');
  elements.toolbar.querySelector('.commit-picker__trigger').click();
  const before = urls.length;
  const active = api.worktrees[0];
  const inactive = api.worktrees[1];
  for (const [worktrees, labels] of [
    [[active, inactive, { path: '/c', branch: 'new', head: 'ccc' }], ['main', 'topic', 'new']],
    [[active, { path: '/c', branch: 'new', head: 'ccc' }], ['main', 'new']],
    [[{ ...active, branch: 'renamed' }, { path: '/c', branch: 'new', head: 'ccc' }], ['renamed', 'new']],
  ]) {
    await updateWorktrees(worktrees);
    assert.deepEqual(elements.tabs.querySelectorAll('.tabs__branch').map((label) => label.textContent), labels);
    assert.equal(elements.tabs.children[0]['aria-selected'], 'true');
    assert.equal(controllers.length, 1, 'metadata must not mount another editor');
    assert.equal(controller.disposed, false);
    assert.equal(elements.main.children[0], editor);
    assert.equal(elements.rail.children[0], rail);
    assert.equal(elements.toolbar.querySelector('.commit-picker__menu'), menu);
    assert.equal(menu.classList.contains('is-open'), true);
    assert.deepEqual(controller.state, { scrollTop: 420, cursor: 12, selection: [8, 12], change: 1 });
  }
  assert.deepEqual(urls.slice(before), [], 'metadata does not reload workspace resources');
  assert.equal(sources.filter((source) => source.url.startsWith('/api/watch?')).length, 1);
  pressKey('l');
  elements.toolbar.querySelectorAll('.change-nav__step')[0].click();
  assert.equal(controller.state.change, 1, 'shortcuts and toolbar still navigate the original controller');
});

test('repeated identical worktree snapshots preserve both Diff and File controllers', async (t) => {
  const { elements, api, controllers, updateWorktrees, urls } = await viewerApp(t);
  for (const mode of ['diff', 'file']) {
    if (mode === 'file') {
      elements.toolbar.querySelector('.view-toggle--mode').querySelectorAll('.view-toggle__btn')[1].click();
      await flushApp();
    }
    const controller = controllers.at(-1);
    Object.assign(controller.state, { scrollTop: 99, cursor: 7, selection: [3, 7], change: 2 });
    const editor = elements.main.children[0];
    const tab = elements.tabs.children[0];
    const counts = { mounts: controllers.length, disposals: controllers.filter((view) => view.disposed).length };
    const before = urls.length;
    for (let i = 0; i < 3; i++) await updateWorktrees(api.worktrees);
    assert.equal(elements.main.children[0], editor);
    assert.equal(elements.tabs.children[0], tab);
    assert.deepEqual({ mounts: controllers.length, disposals: controllers.filter((view) => view.disposed).length }, counts);
    assert.deepEqual(controller.state, { scrollTop: 99, cursor: 7, selection: [3, 7], change: 2 });
    assert.deepEqual(urls.slice(before), []);
    if (mode === 'file') {
      await updateWorktrees([{ ...api.worktrees[0], branch: 'file-mode-label' }, api.worktrees[1]]);
      assert.equal(elements.tabs.querySelector('.tabs__branch').textContent, 'file-mode-label');
      assert.equal(controllers.at(-1), controller);
      assert.equal(controller.disposed, false);
      assert.equal(elements.main.children[0], editor);
    }
  }
});

test('active HEAD changes refresh tree, commits and displayed content only when the new content arrives', async (t) => {
  const { elements, api, controllers, updateWorktrees, urls } = await viewerApp(t);
  const controller = controllers[0];
  const editor = elements.main.children[0];
  let resolveContent;
  api.content = new Promise((resolve) => { resolveContent = resolve; });
  api.files = [{ type: 'file', name: 'f.js', path: 'f.js', status: 'clean' }];
  api.commits = [{ sha: 'new-head', message: 'new commit' }];
  const before = urls.length;
  await updateWorktrees([{ ...api.worktrees[0], head: 'new-head' }, api.worktrees[1]]);
  assert.deepEqual(urls.slice(before), [
    '/api/files?worktree=%2Fa', '/api/commits?worktree=%2Fa&file=f.js',
    '/api/file-content?worktree=%2Fa&file=f.js',
  ]);
  assert.equal(elements.rail.querySelector('.rail__file').classList.contains('status-clean'), true);
  assert.equal(elements.rail.querySelector('.rail__file').classList.contains('is-active'), true);
  assert.equal(elements.toolbar.querySelector('.commit-picker__item-sha').textContent, 'new-hea');
  assert.equal(elements.main.children[0], editor, 'metadata does not briefly remount the previous content');
  assert.equal(controller.disposed, false);
  assert.equal(controllers.length, 1);
  resolveContent({ head: 'new base', working: 'new working content' });
  await flushApp();
  assert.equal(controller.disposed, true);
  assert.equal(controllers.length, 2);
  assert.equal(controllers[1].options.original, 'new base');
  assert.equal(controllers[1].options.modified, 'new working content');
});

test('comparison lock, locked HEAD refresh and working-file edits still update the displayed diff', async (t) => {
  const { elements, api, sources, controllers, updateWorktrees, urls } = await viewerApp(t);
  api.content = { head: 'older base', working: 'new' };
  const beforeLock = urls.length;
  elements.toolbar.querySelector('.commit-picker__menu').querySelectorAll('.commit-picker__item').at(-1).click();
  await flushApp();
  assert.deepEqual(urls.slice(beforeLock), [
    '/api/files?worktree=%2Fa&ref=older', '/api/file-content?worktree=%2Fa&file=f.js&ref=older',
  ]);
  assert.equal(controllers[0].disposed, true);
  assert.equal(controllers.at(-1).options.original, 'older base');
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'older');
  const beforeHead = urls.length;
  api.content = { head: 'older base', working: 'post-commit disk' };
  await updateWorktrees([{ ...api.worktrees[0], head: 'new-head' }, api.worktrees[1]]);
  assert.deepEqual(urls.slice(beforeHead), [
    '/api/files?worktree=%2Fa&ref=older', '/api/commits?worktree=%2Fa&file=f.js',
    '/api/file-content?worktree=%2Fa&file=f.js&ref=older',
  ]);
  assert.equal(controllers.at(-1).options.original, 'older base');
  assert.equal(controllers.at(-1).options.modified, 'post-commit disk');
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'older');
  const beforeEdit = urls.length;
  api.content = { head: 'older base', working: 'edited disk' };
  sources.find((source) => source.url === '/api/watch?worktree=%2Fa&ignoreGitignore=true')
    .onmessage({ data: JSON.stringify({ paths: ['f.js'] }) });
  await flushApp();
  assert.deepEqual(urls.slice(beforeEdit), [
    '/api/files?worktree=%2Fa&ref=older', '/api/comments?worktree=%2Fa', '/api/file-content?worktree=%2Fa&file=f.js&ref=older',
  ]);
  assert.equal(controllers.at(-1).options.modified, 'edited disk');
  assert.equal(controllers.length, 4);
  assert.equal(controllers.filter((view) => view.disposed).length, 3);
  api.content = { head: 'current HEAD base', working: 'edited disk' };
  elements.toolbar.querySelector('.commit-picker__menu').querySelectorAll('.commit-picker__item')[0].click();
  await flushApp();
  assert.equal(controllers.at(-1).options.original, 'current HEAD base');
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'HEAD');
});

test('r locks HEAD from Auto, then steps to older commits without wrapping or filtering by file touches', async (t) => {
  const { elements, api, urls, controllers, pressKey, updateWorktrees } = await viewerApp(t);
  api.commits = [{ sha: 'aaa', message: 'HEAD', touchesFile: true },
    { sha: 'older', message: 'older', touchesFile: false }];
  await updateWorktrees([{ ...api.worktrees[0], originMainSha: 'older' }, api.worktrees[1]]);
  api.content = { head: 'HEAD base', working: 'new' };
  let before = urls.length;
  pressKey('r');
  await flushApp();
  assert.deepEqual(urls.slice(before), [
    '/api/files?worktree=%2Fa&ref=aaa', '/api/file-content?worktree=%2Fa&file=f.js&ref=aaa',
  ]);
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'HEAD');
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(controllers.at(-1).options.original, 'HEAD base');
  api.content = { head: 'older base', working: 'new' };
  before = urls.length;
  pressKey('r');
  await flushApp();
  assert.deepEqual(urls.slice(before), [
    '/api/files?worktree=%2Fa&ref=older', '/api/file-content?worktree=%2Fa&file=f.js&ref=older',
  ]);
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'older');
  assert.equal(controllers.at(-1).options.original, 'older base');
  before = urls.length;
  pressKey('r');
  await flushApp();
  assert.deepEqual(urls.slice(before), [], 'oldest commit is a stop, not a wrap to Auto');
});

test('w steps from a picked older commit to locked HEAD, then Auto, and stops there', async (t) => {
  const { elements, api, urls, controllers, pressKey } = await viewerApp(t);
  elements.toolbar.querySelector('.commit-picker__menu').querySelectorAll('.commit-picker__item').at(-1).click();
  await flushApp();
  api.content = { head: 'HEAD base', working: 'new' };
  let before = urls.length;
  pressKey('w');
  await flushApp();
  assert.deepEqual(urls.slice(before), [
    '/api/files?worktree=%2Fa&ref=aaa', '/api/file-content?worktree=%2Fa&file=f.js&ref=aaa',
  ]);
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'first');
  assert.equal(controllers.at(-1).options.original, 'HEAD base');
  api.content = { head: 'Auto base', working: 'new' };
  before = urls.length;
  pressKey('w');
  await flushApp();
  assert.deepEqual(urls.slice(before), [
    '/api/files?worktree=%2Fa', '/api/file-content?worktree=%2Fa&file=f.js',
  ]);
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'HEAD');
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  assert.equal(controllers.at(-1).options.original, 'Auto base');
  before = urls.length;
  pressKey('w');
  await flushApp();
  assert.deepEqual(urls.slice(before), [], 'Auto is the newest stop');
});

test('comparison shortcuts work without an open file and keep each worktree lock independent', async (t) => {
  const { elements, pressKey, urls } = await viewerApp(t);
  pressKey('r');
  pressKey('r');
  await flushApp();
  pressKey('2');
  await flushApp();
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  const before = urls.length;
  pressKey('r');
  await flushApp();
  assert.deepEqual(urls.slice(before), ['/api/files?worktree=%2Fb&ref=aaa']);
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'first');
  assert.equal(elements.main.children[0].textContent, 'Select a file to view its diff.');
  pressKey('1');
  await flushApp();
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'older');
  pressKey('w');
  await flushApp();
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'first');
  pressKey('w');
  await flushApp();
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  pressKey('2');
  await flushApp();
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'locked');
});

test('comparison shortcuts preserve typing and modifier guards and accept the read-only editor input', async (t) => {
  const { elements, pressKey, urls } = await viewerApp(t);
  let prevented = 0;
  const before = urls.length;
  for (const key of ['w', 'r']) {
    for (const extra of [
      { ctrlKey: true }, { metaKey: true }, { altKey: true },
      { target: { tagName: 'INPUT', readOnly: false } },
      { target: { tagName: 'TEXTAREA', readOnly: false } },
      { target: { tagName: 'SELECT' } },
      { target: { tagName: 'DIV', isContentEditable: true } },
    ]) pressKey(key, { preventDefault: () => prevented++, ...extra });
  }
  await flushApp();
  assert.deepEqual(urls.slice(before), []);
  assert.equal(prevented, 0);
  elements.toolbar.querySelector('.commit-picker__trigger').click();
  const readOnlyEvent = { target: { tagName: 'TEXTAREA', readOnly: true }, preventDefault: () => prevented++ };
  pressKey('r', readOnlyEvent);
  await flushApp();
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'first');
  assert.equal(elements.toolbar.querySelector('.commit-picker__menu').classList.contains('is-open'), false);
  pressKey('w', readOnlyEvent);
  await flushApp();
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  assert.equal(prevented, 2);
});

test('comparison shortcuts retain an unknown locked SHA rather than guessing a new base', async (t) => {
  const { elements, api, urls, pressKey, updateWorktrees } = await viewerApp(t);
  pressKey('r');
  await flushApp();
  api.commits = [{ sha: 'other', message: 'rewritten history' }];
  await updateWorktrees([{ ...api.worktrees[0], originMainSha: 'other' }, api.worktrees[1]]);
  const before = urls.length;
  pressKey('w');
  pressKey('r');
  await flushApp();
  assert.deepEqual(urls.slice(before), []);
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'aaa');
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'locked');
});

test('comparison shortcuts safely do nothing while commits load, are empty or fail', async (t) => {
  const browser = browserStub();
  const urls = [];
  let resolveCommits;
  const pendingCommits = new Promise((resolve) => { resolveCommits = resolve; });
  const app = await startApp({
    ...browser, EventSource: EventSourceStub,
    setInterval: () => 17, clearInterval() {},
    fetch: async (url) => {
      urls.push(url);
      if (url === '/api/worktrees') return { ok: true, json: async () => [{ path: '/a' }, { path: '/b' }] };
      if (url === '/api/commits?worktree=%2Fa') return { ok: true, json: async () => pendingCommits };
      if (url.startsWith('/api/commits')) return { ok: false, status: 503 };
      return { ok: true, json: async () => [] };
    },
  });
  t.after(() => app.dispose());
  const assertNoReload = async () => {
    const before = urls.length;
    browser.pressKey('r');
    browser.pressKey('w');
    await flushApp();
    assert.deepEqual(urls.slice(before), []);
    assert.equal(browser.elements.toolbar.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  };
  await assertNoReload();
  resolveCommits([]);
  await flushApp();
  await assertNoReload();
  browser.pressKey('2');
  await flushApp();
  assert.ok(browser.elements.toolbar.querySelector('.commit-picker__item--error'));
  await assertNoReload();
});

test('file and worktree selection refresh viewers and active removal falls back before clearing the workspace', async (t) => {
  const { elements, api, sources, controllers, updateWorktrees, urls } = await viewerApp(t);
  api.content = { head: 'g base', working: 'g disk' };
  elements.rail.querySelectorAll('.rail__file').find((row) => row.title === 'g.js').click();
  await flushApp();
  assert.equal(controllers[0].disposed, true);
  assert.equal(elements.toolbar.querySelector('.viewer__filename').textContent, 'g.js');
  assert.equal(controllers.at(-1).options.modified, 'g disk');
  elements.toolbar.querySelector('.commit-picker__menu').querySelectorAll('.commit-picker__item').at(-1).click();
  await flushApp();
  const aSource = sources.find((source) => source.url === '/api/watch?worktree=%2Fa&ignoreGitignore=true');
  const beforeSwitch = urls.length;
  elements.tabs.children[1].click();
  await flushApp();
  assert.equal(controllers.at(-1).disposed, true);
  assert.equal(elements.main.children[0].textContent, 'Select a file to view its diff.');
  assert.equal(aSource.closed, true);
  assert.deepEqual(urls.slice(beforeSwitch), ['/api/files?worktree=%2Fb', '/api/commits?worktree=%2Fb', '/api/comments?worktree=%2Fb']);
  api.content = { head: 'b base', working: 'b disk' };
  elements.rail.querySelector('.rail__file').click();
  await flushApp();
  assert.equal(controllers.at(-1).options.original, 'b base');
  assert.equal(controllers.at(-1).options.modified, 'b disk');
  const bSource = sources.find((source) => source.url === '/api/watch?worktree=%2Fb&ignoreGitignore=true');
  const beforeRemoval = urls.length;
  await updateWorktrees([api.worktrees[0]]);
  assert.equal(bSource.closed, true);
  assert.deepEqual(urls.slice(beforeRemoval), ['/api/files?worktree=%2Fa&ref=older', '/api/commits?worktree=%2Fa', '/api/comments?worktree=%2Fa']);
  assert.equal(elements.tabs.children[0]['aria-selected'], 'true');
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'older', 'surviving worktree retains its lock');
  assert.equal(elements.main.children[0].textContent, 'Select a file to view its diff.');
  await updateWorktrees([]);
  assert.equal(elements.main.children[0].textContent, 'No worktrees found.');
  assert.equal(elements.toolbar.hidden, false);
  assert.deepEqual(elements.tabs.children, []);
  const beforeReadd = urls.length;
  await updateWorktrees([{ path: '/a', branch: 're-added', head: 'aaa' }]);
  assert.deepEqual(urls.slice(beforeReadd), ['/api/files?worktree=%2Fa', '/api/commits?worktree=%2Fa', '/api/comments?worktree=%2Fa']);
  assert.equal(elements.toolbar.querySelector('.commit-picker__trigger-title').textContent, 'HEAD', 'removed worktree locks are pruned');
  const beforeStaleEvent = urls.length;
  aSource.onmessage({ data: JSON.stringify({ paths: ['f.js'] }) });
  bSource.onmessage({ data: JSON.stringify({ paths: ['f.js'] }) });
  await flushApp();
  assert.equal(urls.length, beforeStaleEvent, 'closed streams cannot reload the fallback worktree');
});

test('initial request failure shows the original error without opening a stream', async () => {
  const { document, window, elements } = browserStub();
  let streams = 0;
  await startApp({
    document, window,
    EventSource: class { constructor() { streams++; } },
    fetch: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(elements.main.children[0].textContent, 'Failed to load worktrees: request failed with status 503');
  assert.deepEqual(elements.tabs.children, []);
  assert.deepEqual(elements.rail.children, []);
  assert.equal(elements.toolbar.hidden, true);
  assert.equal(streams, 0);
});

test('? toggles the shortcut help, Escape closes it, and typing in a field is ignored', async () => {
  const { document, window, elements, pressKey } = browserStub();
  await startApp({
    document, window,
    EventSource: class { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => [] }),
  });
  pressKey('?');
  assert.equal(elements['shortcut-help'].hidden, false);
  pressKey('Escape');
  assert.equal(elements['shortcut-help'].hidden, true);
  pressKey('?', { target: { tagName: 'INPUT', readOnly: false } });
  assert.equal(elements['shortcut-help'].hidden, true);
});

test('worktree, change and comparison shortcuts do nothing without worktrees, and dispose removes the key listener', async () => {
  const { document, window, keydownListeners, pressKey } = browserStub();
  const app = await startApp({
    document, window,
    EventSource: class { addEventListener() {} close() {} },
    fetch: async () => ({ ok: true, json: async () => [] }),
  });
  pressKey('1');
  pressKey('j');
  pressKey('l');
  pressKey('w');
  pressKey('r');
  assert.equal(keydownListeners.size, 1);
  app.dispose();
  assert.equal(keydownListeners.size, 0);
});

test('j and l step the mounted diff to the previous and next change', async () => {
  const { document, window, elements, pressKey } = browserStub();
  const navigated = [];
  await startApp({
    document, window, EventSource: EventSourceStub, fetch: fakeFetch(),
    mountDiffEditor: async () => ({
      dispose() {},
      nextChange: () => navigated.push('next'),
      prevChange: () => navigated.push('prev'),
    }),
  });
  await settle();
  elements.rail.querySelector('.rail__file').click();
  await settle();
  pressKey('j');
  pressKey('l');
  assert.deepEqual(navigated, ['prev', 'next']);
  pressKey('j', { ctrlKey: true });
  pressKey('l', { target: { tagName: 'INPUT', readOnly: false } });
  assert.deepEqual(navigated, ['prev', 'next'], 'modifiers and typing leave the keys alone');
});

test('c asks the active editor view to add a comment, with the usual guards', async (t) => {
  const { document, window, elements, pressKey } = browserStub();
  const added = [];
  const controller = (mode) => ({ dispose() {}, addComment: () => added.push(mode) });
  const app = await startApp({
    document, window, EventSource: EventSourceStub, fetch: fakeFetch(),
    mountDiffEditor: async (_container, options) => controller(options.mode),
    mountEditor: async () => controller('file'),
  });
  t.after(() => app.dispose());
  await settle();
  elements.rail.querySelector('.rail__file').click();
  await settle();
  const [inline, sideBySide] = elements.toolbar.querySelector('.view-toggle--diff').querySelectorAll('.view-toggle__btn');
  const [, file] = elements.toolbar.querySelector('.view-toggle--mode').querySelectorAll('.view-toggle__btn');
  const guardedEvents = [
    { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { target: { tagName: 'INPUT', readOnly: false } },
    { target: { tagName: 'TEXTAREA', readOnly: false } },
    { target: { tagName: 'SELECT' } },
    { target: { tagName: 'DIV', isContentEditable: true } },
  ];
  for (const [mode, button] of [['inline', inline], ['side-by-side', sideBySide], ['file', file]]) {
    button.click();
    await settle();
    for (const extra of guardedEvents) pressKey('c', extra);
    assert.deepEqual(added, [], `guarded c in ${mode} does nothing`);
    pressKey('c');
    assert.deepEqual(added, [mode]);
    added.length = 0;
  }
});

test('e and d scroll File and all diff views once per keydown, preserving guards', async (t) => {
  const { document, window, elements, pressKey } = browserStub();
  const scrolled = [];
  const controller = (mode) => ({
    dispose() {},
    scrollUp: () => scrolled.push(`${mode}:up`),
    scrollDown: () => scrolled.push(`${mode}:down`),
  });
  const app = await startApp({
    document, window, EventSource: EventSourceStub, fetch: fakeFetch(),
    mountDiffEditor: async (_container, options) => controller(options.mode),
    mountEditor: async () => controller('file'),
  });
  t.after(() => app.dispose());
  pressKey('e');
  pressKey('d');
  await settle();
  elements.rail.querySelector('.rail__file').click();
  await settle();
  let prevented = 0;
  const readOnlyEvent = { target: { tagName: 'TEXTAREA', readOnly: true }, preventDefault: () => prevented++ };
  const guardedEvents = [
    { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { target: { tagName: 'INPUT', readOnly: false } },
    { target: { tagName: 'TEXTAREA', readOnly: false } },
    { target: { tagName: 'SELECT' } },
    { target: { tagName: 'DIV', isContentEditable: true } },
  ];
  for (const button of elements.toolbar.querySelector('.view-toggle--diff').querySelectorAll('.view-toggle__btn')) {
    button.click();
    await settle();
    pressKey('e', readOnlyEvent);
    pressKey('d', readOnlyEvent);
    pressKey('d', { ...readOnlyEvent, repeat: true });
    for (const key of ['e', 'd']) {
      for (const extra of guardedEvents) pressKey(key, { preventDefault: () => prevented++, ...extra });
    }
  }
  const diffScrolls = [
    'inline:up', 'inline:down', 'inline:down',
    'side-by-side:up', 'side-by-side:down', 'side-by-side:down',
  ];
  assert.deepEqual(scrolled, diffScrolls);
  assert.equal(prevented, 6, 'guarded diff keys retain their native behavior');

  elements.toolbar.querySelector('.view-toggle--mode').querySelectorAll('.view-toggle__btn')[1].click();
  await settle();
  pressKey('e', readOnlyEvent);
  pressKey('d', readOnlyEvent);
  pressKey('d', { ...readOnlyEvent, repeat: true });
  assert.deepEqual(scrolled, [...diffScrolls, 'file:up', 'file:down', 'file:down']);
  assert.equal(prevented, 9);

  for (const key of ['e', 'd']) {
    for (const extra of guardedEvents) pressKey(key, { preventDefault: () => prevented++, ...extra });
  }
  assert.deepEqual(scrolled, [...diffScrolls, 'file:up', 'file:down', 'file:down']);
  assert.equal(prevented, 9, 'guarded keys retain their native behavior');

  elements.toolbar.querySelector('.view-toggle--mode').querySelectorAll('.view-toggle__btn')[0].click();
  await settle();
  pressKey('d');
  assert.deepEqual(scrolled, [...diffScrolls, 'file:up', 'file:down', 'file:down', 'side-by-side:down']);
});

test('rail divider keyboard and viewport resizing leave the editor mounted and dispose disables resizing', async () => {
  const { document, window, elements } = browserStub();
  let mounts = 0;
  let disposals = 0;
  const app = await startApp({ document, window, EventSource: EventSourceStub, fetch: fakeFetch(),
    mountDiffEditor: async () => {
      mounts++;
      return { dispose() { disposals++; } };
    },
  });
  await settle();
  elements.rail.querySelector('.rail__file').click();
  await settle();
  assert.equal(mounts, 1);
  assert.equal(elements.rail.style.width, '220px');
  const divider = elements['rail-divider'];
  divider.listeners.get('keydown')({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(elements.rail.style.width, '230px');
  elements.body.clientWidth = 306;
  window.emit('resize');
  assert.equal(elements.rail.style.width, '150px');
  assert.equal(mounts, 1);
  assert.equal(disposals, 0);
  app.dispose();
  assert.equal(divider.listeners.size, 0);
  elements.body.clientWidth = 1006;
  window.emit('resize');
  assert.equal(elements.rail.style.width, '150px');
});

test('f opens changed files in path order and wraps to the first', async () => {
  const { document, window, elements, pressKey } = browserStub();
  const tree = [
    { type: 'file', name: 'z.txt', path: 'z.txt', status: 'modified' },
    { type: 'file', name: 'clean.txt', path: 'clean.txt', status: 'clean' },
    { type: 'dir', name: 'src', path: 'src', children: [
      { type: 'file', name: 'a.js', path: 'src/a.js', status: 'added' },
    ] },
  ];
  const fetch = async (url) => ({
    ok: true,
    json: async () => url.startsWith('/api/files') ? tree
      : url === '/api/worktrees' ? [{ path: '/a', branch: 'a' }]
        : url.startsWith('/api/commits') ? [] : { head: 'old', working: 'new' },
  });
  await startApp({ document, window, EventSource: EventSourceStub, fetch,
    mountDiffEditor: async () => ({ dispose() {} }),
  });
  await settle();
  const selected = () => elements.rail.querySelectorAll('.changed-files__file')
    .find((row) => row.classList.contains('is-active'))?.textContent;
  pressKey('f');
  assert.equal(selected(), 'src/a.js');
  pressKey('f');
  assert.equal(selected(), 'z.txt');
  pressKey('f');
  assert.equal(selected(), 'src/a.js');
});

test('s opens the last changed file from no selection and skips clean files', async () => {
  const { document, window, elements, pressKey } = browserStub();
  const fetch = async (url) => ({ ok: true, json: async () => {
    if (url === '/api/worktrees') return [{ path: '/a', branch: 'a' }];
    if (url.startsWith('/api/files')) return [
      { type: 'file', name: 'z.txt', path: 'z.txt', status: 'modified' },
      { type: 'file', name: 'clean.txt', path: 'clean.txt', status: 'clean' },
      { type: 'file', name: 'a.txt', path: 'a.txt', status: 'added' },
    ];
    if (url.startsWith('/api/commits')) return [];
    return { head: 'old', working: 'new' };
  } });
  await startApp({ document, window, EventSource: EventSourceStub, fetch,
    mountDiffEditor: async () => ({ dispose() {} }),
  });
  await settle();
  const selected = () => elements.rail.querySelectorAll('.changed-files__file')
    .find((row) => row.classList.contains('is-active'))?.textContent;
  pressKey('s');
  assert.equal(selected(), 'z.txt');
  pressKey('s');
  assert.equal(selected(), 'a.txt');
  pressKey('s');
  assert.equal(selected(), 'z.txt');
  pressKey('f', { ctrlKey: true });
  pressKey('s', { target: { tagName: 'INPUT', readOnly: false } });
  assert.equal(selected(), 'z.txt');
});

test('Wrap button updates the open diff and file viewer setting', async () => {
  const { document, window, elements } = browserStub();
  const wraps = [];
  await startApp({
    document, window, EventSource: EventSourceStub, fetch: fakeFetch(),
    mountDiffEditor: async (_container, options) => {
      wraps.push(['diff', options.wrap]);
      return { dispose() {} };
    },
    mountEditor: async (_container, options) => {
      wraps.push(['file', options.wrap]);
      return { dispose() {} };
    },
  });
  await settle();
  elements.rail.querySelector('.rail__file').click();
  await settle();
  const wrap = elements.toolbar.querySelector('.viewer__wrap');
  wrap.click();
  await settle();
  elements.toolbar.querySelector('.view-toggle--mode').querySelectorAll('.view-toggle__btn')[1].click();
  await settle();
  wrap.click();
  await settle();
  assert.deepEqual(wraps, [['diff', true], ['diff', false], ['file', false], ['file', true]]);
});

test('digit keys switch to the worktree tab at that position and ignore missing ones', async () => {
  const { document, window, elements, pressKey } = browserStub();
  const urls = [];
  await startApp({ document, window, EventSource: EventSourceStub, fetch: fakeFetch(urls) });
  await settle();
  const activeTabs = () => elements.tabs.children.map((tab) => tab.classList.contains('is-active'));
  assert.deepEqual(activeTabs(), [true, false]);
  pressKey('2');
  await settle();
  assert.deepEqual(activeTabs(), [false, true]);
  assert.ok(urls.includes('/api/files?worktree=%2Fb'));
  pressKey('3');
  await settle();
  assert.deepEqual(activeTabs(), [false, true]);
  pressKey('1');
  await settle();
  assert.deepEqual(activeTabs(), [true, false]);
});
