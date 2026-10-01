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
    staged: { tracked: 'tracked.txt\0staged.txt\0gone.txt\0', status: 'A  staged.txt\nAD gone.txt\n' },
    cachedRemoval: { tracked: 'staged.txt\0gone.txt\0', status: 'D  tracked.txt\n?? tracked.txt\nA  staged.txt\nAD gone.txt\n' },
    resetGone: { tracked: 'staged.txt\0', status: 'D  tracked.txt\n?? tracked.txt\nA  staged.txt\n' },
    resetPresent: { tracked: '', status: 'D  tracked.txt\n?? tracked.txt\n?? staged.txt\n' },
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
    assert.deepEqual(sources.map((source) => source.url), ['/api/watch-worktrees', '/api/watch-activity']);
    assert.equal(elements.main.children[0].textContent, 'No worktrees found.');
    assert.equal(elements.toolbar.hidden, true);
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
  sources.find((source) => source.url === '/api/watch-activity').onmessage({ data: JSON.stringify({ '/a': null, '/b': 940_000 }) });
  assert.equal(tab.querySelector('.tabs__edit-time').textContent, '1m ago');
  tick();
  assert.equal(elements.tabs.children[1], tab);
  app.dispose();
  assert.equal(cleared, 17);
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
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'aaa');
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
    assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'aaa');
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
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'abcdef1');
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
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
  assert.equal(menu.children[0].classList.contains('is-selected'), true);
  assert.equal(elements.rail.querySelector('.rail__message'), null);
  assert.equal(mounts, mountedWhileLoading + 1);
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

test('worktree and change shortcuts do nothing without worktrees, and dispose removes the key listener', async () => {
  const { document, window, keydownListeners, pressKey } = browserStub();
  const app = await startApp({
    document, window,
    EventSource: class { addEventListener() {} close() {} },
    fetch: async () => ({ ok: true, json: async () => [] }),
  });
  pressKey('1');
  pressKey('j');
  pressKey('l');
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
