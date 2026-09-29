import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../../public/app.js';
import { Element } from './fake-dom.js';

function browserStub() {
  const elements = Object.fromEntries(['tabs-wrapper', 'tabs', 'rail', 'toolbar', 'main', 'shortcut-help'].map((id) => [id, new Element('div')]));
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
  const window = { localStorage: { getItem: () => null }, addEventListener() {} };
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
    assert.deepEqual(sources.map((source) => source.url), ['/api/watch-worktrees']);
    assert.equal(elements.main.children[0].textContent, 'No worktrees found.');
    assert.equal(elements.toolbar.hidden, true);
    sources[0].onmessage({ data: '[]' });
    assert.equal(elements.main.children[0].textContent, 'No worktrees found.');
    app.dispose();
    assert.equal(sources[0].closed, true);
  } finally {
    // No browser globals are stubbed: every module takes its own dependencies.
  }
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
