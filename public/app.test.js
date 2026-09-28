import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './app.js';

function browserStub() {
  const elements = Object.fromEntries(['tabs-wrapper', 'tabs', 'rail', 'toolbar', 'main'].map((id) => [id, {
    children: [],
    classList: { toggle() {} },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
  }]));
  const document = {
    getElementById: (id) => elements[id],
    createElement: () => ({ className: '', textContent: '' }),
  };
  const window = { localStorage: { getItem: () => null }, addEventListener() {} };
  return { document, window, elements };
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
