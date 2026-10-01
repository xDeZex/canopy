import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createViewer } from '../../public/viewer.js';

function element(tagName) {
  const classes = new Set();
  return {
    tagName,
    children: [],
    className: '',
    textContent: '',
    classList: {
      add(name) { classes.add(name); },
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const document = { createElement: element };
  const mainEl = element('main');
  const calls = [];
  let state = { activeFile: null, worktrees: [], activePath: null, fileContent: null, fileContentError: null };
  let mode = 'diff';
  let diffMode = 'inline';
  let autoScroll = false;
  const viewer = createViewer({
    mainEl,
    document,
    getState: () => state,
    getViewMode: () => mode,
    getDiffRenderMode: () => diffMode,
    getAutoScroll: () => autoScroll,
    getWrap: () => false,
    languageForPath: (path) => path.endsWith('.js') ? 'javascript' : 'plaintext',
    mountEditor: (container, options) => {
      const pending = deferred();
      calls.push({ kind: 'file', container, options, ...pending });
      return pending.promise;
    },
    mountDiffEditor: (container, options) => {
      const pending = deferred();
      calls.push({ kind: 'diff', container, options, ...pending });
      return pending.promise;
    },
  });
  return {
    mainEl, calls, viewer, document,
    setState(patch) { state = { ...state, ...patch }; },
    setMode(value) { mode = value; },
    setDiffMode(value) { diffMode = value; },
    setAutoScroll(value) { autoScroll = value; },
  };
}

function assertMessage(mainEl, text, isViewer = false) {
  assert.equal(mainEl.classList.contains('main--viewer'), isViewer);
  assert.equal(mainEl.children.length, 1);
  assert.equal(mainEl.children[0].className, 'empty');
  assert.equal(mainEl.children[0].textContent, text);
}

const reviewThread = (patch = {}) => ({ id: 't', file: 'a.js', side: 'modified',
  line_range: { start: 1, end: 2 }, created_at: '2026-10-01T12:00:00Z', resolved: true,
  messages: [{ id: 'm', author: 'agent', created_at: '2026-10-01T12:00:00Z', text: '<script>evil()</script>\nFull conversation' }],
  unavailable: null, ...patch });
const texts = (node) => [node.textContent, ...node.children.flatMap(texts)].join(' ');

test('general main view displays only genuinely general conversations, including an empty explanation', () => {
  const f = fixture();
  const { file, side, line_range, unavailable, ...general } = reviewThread({ id: 'general' });
  f.setState({ mainView: 'general', activePath: '/repo', worktrees: [{ path: '/repo' }], comments: {
    warning: 'Cannot load comments: invalid YAML', threads: [reviewThread({ unavailable: 'Anchor file is missing', messages: [] }), general],
  } });
  f.viewer.render();
  assert.equal(f.mainEl.children[0].tabindex, '0', 'the main conversation region is keyboard-scrollable');
  assert.match(texts(f.mainEl), /invalid YAML/);
  assert.doesNotMatch(texts(f.mainEl), /Anchor file is missing|a\.js|undefined/);
  assert.match(texts(f.mainEl), /Resolved/);
  assert.match(texts(f.mainEl), /<script>evil\(\)<\/script>\nFull conversation/);
  assert.equal(f.calls.length, 0);
  f.setState({ comments: { threads: [], warning: null } });
  f.viewer.refreshComments();
  assert.match(texts(f.mainEl), /No comments without a file/);
});

test('only valid selected modified-side ranges go inline; other anchors retain full text and explicit reasons', () => {
  for (const [patch, mode, reason] of [
    [{ line_range: { start: 1, end: 4 } }, 'diff', /outside.*1–2/],
    [{ unavailable: 'Anchor file is missing' }, 'diff', /missing/],
    [{ file: 'missing.js' }, 'diff', /not available in the file tree/],
  ]) {
    const f = fixture();
    f.setMode(mode);
    f.setState({ activeFile: 'a.js', selectedThreadId: 't', fileTree: [{ type: 'file', path: 'a.js' }],
      fileContent: { head: 'old', working: 'one\ntwo' }, comments: { threads: [reviewThread(patch)], warning: null } });
    f.viewer.render();
    assert.match(texts(f.mainEl), reason);
    assert.match(texts(f.mainEl), /Full conversation/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.setState({ activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { head: 'old', working: 'one\ntwo' }, comments: { threads: [reviewThread()], warning: null } });
  f.viewer.render();
  assert.deepEqual(f.calls[0].options.threads, [reviewThread()]);
  const deleted = fixture();
  deleted.setState({ activeFile: 'a.js', selectedThreadId: 't', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { head: 'old', working: null }, comments: { threads: [reviewThread()], warning: null } });
  deleted.viewer.render();
  assert.match(texts(deleted.mainEl), /no modified-side anchor/);
  assert.equal(deleted.calls.length, 0);
});

test('comment refreshes preserve mounted editors and pending mounts receive the latest conversation', async () => {
  const f = fixture();
  const base = { activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { head: 'old', working: 'one\ntwo' }, comments: { threads: [reviewThread()], warning: null } };
  f.setState(base);
  f.viewer.render();
  const updates = [];
  let disposed = 0;
  const newer = reviewThread({ resolved: false });
  f.setState({ comments: { threads: [newer], warning: null } });
  f.viewer.refreshComments();
  assert.equal(f.calls.length, 1, 'does not start another asynchronous mount');
  f.calls[0].resolve({ updateThreads: (threads) => updates.push(threads), dispose: () => disposed++ });
  await f.calls[0].promise;
  assert.deepEqual(updates, [[newer]]);
  f.setState({ comments: { threads: [], warning: 'broken sidecar' } });
  f.viewer.refreshComments();
  assert.deepEqual(updates, [[newer], []]);
  assert.doesNotMatch(texts(f.mainEl), /Full conversation|broken sidecar/);
  assert.equal(f.calls.length, 1);
  f.viewer.dispose();
  assert.equal(disposed, 1);
});

test('same-file thread reveals survive pending mounts and diff layout changes', async () => {
  const f = fixture();
  f.setState({ activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { head: 'old', working: 'one\ntwo' }, comments: { threads: [reviewThread()], warning: null } });
  f.viewer.render();
  const reveals = [];
  let disposed = 0;
  f.setState({ selectedThreadId: 't' });
  f.viewer.refreshComments();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ dispose() { disposed++; }, updateThreads() {}, revealThread: (id) => reveals.push(id) });
  await f.calls[0].promise;
  assert.deepEqual(reveals, ['t']);
  f.viewer.refreshComments();
  assert.deepEqual(reveals, ['t', 't']);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(texts(f.mainEl), /Full conversation/);
  f.setDiffMode('side-by-side');
  f.viewer.render();
  assert.equal(disposed, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.mode, 'side-by-side');
  assert.deepEqual(f.calls[1].options.threads, [reviewThread()]);
  f.setState({ selectedThreadId: null });
  f.viewer.refreshComments();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].options.threads, [reviewThread()]);
  f.viewer.dispose();
  f.calls[1].resolve({ dispose() { disposed++; } });
  await f.calls[1].promise;
  assert.equal(disposed, 2);
});

test('disposed viewers ignore late workspace refreshes and release pending controllers', async () => {
  const f = fixture();
  f.setState({ activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
    selectedThreadId: 't', fileContent: { head: '', working: 'one\ntwo' }, comments: { threads: [reviewThread()] } });
  f.viewer.render();
  f.viewer.dispose();
  let disposed = 0;
  f.setState({ mainView: 'general' });
  f.viewer.refreshComments();
  f.viewer.render();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ dispose() { disposed++; }, revealThread() { assert.fail('stale reveal'); } });
  await f.calls[0].promise;
  assert.equal(disposed, 1);
  f.setState({ mainView: 'file' });
  f.viewer.render();
  assert.equal(f.calls.length, 1);
});

test('editor load failure visibly explains unavailable inline anchors without losing conversations', async () => {
  const f = fixture();
  f.setState({ activeFile: 'a.js', selectedThreadId: 't', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { head: '', working: 'one\ntwo' }, comments: { threads: [reviewThread()], warning: null } });
  const previousError = console.error;
  console.error = () => {};
  try {
    f.viewer.render();
    f.calls[0].reject(new Error('CDN unavailable'));
    await assert.rejects(f.calls[0].promise);
    assert.match(texts(f.mainEl), /Inline editor unavailable: CDN unavailable/);
    assert.match(texts(f.mainEl), /Full conversation/);
  } finally { console.error = previousError; }
});

test('a successful same-file retry clears temporary mount errors and restores inline threads without remount loops', async () => {
  const previousError = console.error;
  console.error = () => {};
  try {
    for (const mode of ['file', 'diff']) {
      const f = fixture();
      f.setMode(mode);
      f.setState({ activeFile: 'a.js', selectedThreadId: 't', fileTree: [{ type: 'file', path: 'a.js' }],
        fileContent: { head: '', working: 'one\ntwo' }, comments: { threads: [reviewThread()], warning: null } });
      f.viewer.render();
      f.calls[0].reject(new Error('temporary CDN failure'));
      await assert.rejects(f.calls[0].promise);
      assert.match(texts(f.mainEl), /temporary CDN failure/);
      f.setState({ selectedThreadId: null }); // Picking the same file clears the selected thread.
      f.viewer.refreshComments();
      assert.equal(f.calls.length, 2, 'the file can retry its mount');
      const updates = [];
      const reveals = [];
      f.calls[1].resolve({ dispose() {}, updateThreads: (threads) => updates.push(threads), revealThread: (id) => reveals.push(id) });
      await f.calls[1].promise;
      assert.deepEqual(updates, [[reviewThread()]], 'successful retry restores the current zones');
      f.setState({ selectedThreadId: 't' });
      f.viewer.refreshComments();
      assert.deepEqual(reveals, ['t']);
      assert.doesNotMatch(texts(f.mainEl), /temporary CDN failure/);
      assert.equal(f.calls.length, 2, 'thread navigation keeps the successful controller mounted');
      f.viewer.dispose();
    }
  } finally { console.error = previousError; }
});

test('a stale successful mount cannot clear the latest mount error or start a retry loop', async () => {
  const f = fixture();
  f.setState({ activeFile: 'a.js', selectedThreadId: 't', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { head: '', working: 'one\ntwo' }, comments: { threads: [reviewThread()], warning: null } });
  const previousError = console.error;
  console.error = () => {};
  try {
    f.viewer.render();
    f.viewer.render();
    f.calls[1].reject(new Error('latest CDN failure'));
    await assert.rejects(f.calls[1].promise);
    let disposed = 0;
    f.calls[0].resolve({ dispose() { disposed++; }, updateThreads() { assert.fail('stale zones'); } });
    await f.calls[0].promise;
    assert.equal(disposed, 1);
    f.viewer.refreshComments();
    assert.match(texts(f.mainEl), /latest CDN failure/);
    assert.equal(f.calls.length, 2, 'unavailable conversation refresh does not automatically retry');
  } finally { f.viewer.dispose(); console.error = previousError; }
});

test('empty, loading, error, and deleted states render the original messages and classes', () => {
  const f = fixture();
  f.viewer.render();
  assertMessage(f.mainEl, 'No worktrees found.');

  f.setState({ worktrees: [{ path: '/repo' }], activePath: '/repo' });
  f.viewer.render();
  assertMessage(f.mainEl, 'Select a file to view its diff.');

  f.setState({ activeFile: 'gone.js' });
  f.viewer.render();
  assertMessage(f.mainEl, 'Loading file…');

  f.setState({ fileContentError: new Error('offline') });
  f.viewer.render();
  assertMessage(f.mainEl, 'Failed to load file: offline');

  f.setMode('file');
  f.setState({ fileContentError: null, fileContent: { head: 'old', working: null } });
  f.viewer.render();
  assert.equal(f.mainEl.classList.contains('main--viewer'), true);
  assert.equal(f.mainEl.children[0].className, 'viewer__editor');
  assertMessage(f.mainEl.children[0], 'This file was deleted from the working tree.');
  assert.equal(f.calls.length, 0);
});

test('out-of-order mounts dispose stale controllers without replacing the latest one', async () => {
  const f = fixture();
  const disposed = [];
  const controller = (name) => ({ dispose: () => disposed.push(name) });
  f.setState({ activeFile: 'first.js', fileContent: { head: 'before', working: 'after' } });
  f.viewer.render();
  assert.equal(f.calls[0].kind, 'diff');
  assert.deepEqual(f.calls[0].options, { original: 'before', modified: 'after', language: 'javascript', mode: 'inline', autoScroll: false, wrap: false, document: f.document,
  });

  f.setMode('file');
  f.setState({ activeFile: 'second.txt', fileContent: { head: null, working: 'second' } });
  f.viewer.render();
  assert.notEqual(f.calls[0].container, f.calls[1].container);
  assert.deepEqual(f.calls[1].options, { content: 'second', language: 'plaintext', wrap: false, document: f.document });
  f.calls[1].resolve(controller('second'));
  await f.calls[1].promise;
  f.calls[0].resolve(controller('first'));
  await f.calls[0].promise;
  assert.deepEqual(disposed, ['first']);
  assert.equal(f.mainEl.children[0], f.calls[1].container);

  f.setMode('diff');
  f.setDiffMode('side-by-side');
  f.viewer.render();
  assert.deepEqual(disposed, ['first', 'second']);
  assert.deepEqual(f.calls[2].options, { original: '', modified: 'second', language: 'plaintext', mode: 'side-by-side', autoScroll: false, wrap: false, document: f.document,
  });
  f.calls[2].resolve(controller('third'));
  await f.calls[2].promise;
  f.setState({ activeFile: null });
  f.viewer.render();
  assert.deepEqual(disposed, ['first', 'second', 'third']);
  assertMessage(f.mainEl, 'No worktrees found.');
});

test('pending mounts are invalidated by message renders; only current failures are logged', async () => {
  const f = fixture();
  const disposed = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    f.setState({ activeFile: 'a.js', fileContent: { head: '', working: 'a' } });
    f.viewer.render();
    f.setState({ fileContent: null });
    f.viewer.render();
    f.calls[0].resolve({ dispose: () => disposed.push('stale') });
    await f.calls[0].promise;
    assert.deepEqual(disposed, ['stale']);
    assertMessage(f.mainEl, 'Loading file…');

    f.setState({ fileContent: { head: '', working: 'b' } });
    f.viewer.render();
    f.viewer.render();
    f.calls[1].reject(new Error('stale failure'));
    await assert.rejects(f.calls[1].promise);
    const failure = new Error('loader failed');
    f.calls[2].reject(failure);
    await assert.rejects(f.calls[2].promise);
    assert.deepEqual(errors, [['Failed to mount file viewer', failure]]);
    assert.equal(f.mainEl.classList.contains('main--viewer'), true);
  } finally {
    console.error = originalError;
  }
});

test('passes the auto-scroll preference to diff mounts and forwards change navigation to the current view', async () => {
  const f = fixture();
  f.setState({
    activeFile: 'a.js', worktrees: [{ path: '/repo' }], activePath: '/repo',
    fileContent: { head: 'old', working: 'new' },
  });
  f.setAutoScroll(true);
  f.viewer.render();
  assert.equal(f.calls[0].options.autoScroll, true);

  const navigated = [];
  f.calls[0].resolve({ dispose() {}, nextChange: () => navigated.push('next'), prevChange: () => navigated.push('prev') });
  await f.calls[0].promise;
  f.viewer.nextChange();
  f.viewer.prevChange();
  assert.deepEqual(navigated, ['next', 'prev']);
});

test('change navigation is a no-op with no view or a File mode view', async () => {
  const f = fixture();
  f.viewer.nextChange();
  f.setState({
    activeFile: 'a.js', worktrees: [{ path: '/repo' }], activePath: '/repo',
    fileContent: { head: 'old', working: 'new' },
  });
  f.setMode('file');
  f.viewer.render();
  f.calls[0].resolve({ dispose() {} });
  await f.calls[0].promise;
  f.viewer.prevChange();
});

test('scrolling forwards to the current Diff or File view and is a no-op while unmounted', async () => {
  const f = fixture();
  const scrolled = [];
  const controller = (name) => ({
    dispose() {},
    scrollUp: () => scrolled.push(`${name}:up`),
    scrollDown: () => scrolled.push(`${name}:down`),
  });
  f.viewer.scrollUp();
  f.viewer.scrollDown();
  f.setState({ activeFile: 'a.js', fileContent: { head: 'old', working: 'new' } });
  f.viewer.render();
  f.calls[0].resolve(controller('diff'));
  await f.calls[0].promise;
  f.viewer.scrollUp();
  f.viewer.scrollDown();
  assert.deepEqual(scrolled, ['diff:up', 'diff:down']);

  f.setMode('file');
  f.viewer.render();
  f.viewer.scrollDown();
  f.calls[1].resolve(controller('file'));
  await f.calls[1].promise;
  f.viewer.scrollUp();
  f.viewer.scrollDown();
  assert.deepEqual(scrolled, ['diff:up', 'diff:down', 'file:up', 'file:down']);

  f.setMode('diff');
  f.viewer.render();
  f.viewer.render();
  f.calls[2].resolve(controller('stale'));
  await f.calls[2].promise;
  f.viewer.scrollDown();
  f.calls[3].resolve(controller('latest'));
  await f.calls[3].promise;
  f.viewer.scrollDown();
  f.setState({ fileContent: null });
  f.viewer.render();
  f.viewer.scrollUp();
  assert.deepEqual(scrolled, ['diff:up', 'diff:down', 'file:up', 'file:down', 'latest:down']);

  f.setState({ fileContent: { head: 'old', working: 'new' } });
  f.viewer.render();
  f.calls[4].resolve({ dispose() {} });
  await f.calls[4].promise;
  f.viewer.scrollUp();
  f.viewer.scrollDown();
  assert.deepEqual(scrolled, ['diff:up', 'diff:down', 'file:up', 'file:down', 'latest:down']);
});
