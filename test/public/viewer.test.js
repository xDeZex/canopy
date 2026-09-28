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
    mainEl, calls, viewer,
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
  assert.deepEqual(f.calls[0].options, { original: 'before', modified: 'after', language: 'javascript', mode: 'inline', autoScroll: false });

  f.setMode('file');
  f.setState({ activeFile: 'second.txt', fileContent: { head: null, working: 'second' } });
  f.viewer.render();
  assert.notEqual(f.calls[0].container, f.calls[1].container);
  assert.deepEqual(f.calls[1].options, { content: 'second', language: 'plaintext' });
  f.calls[1].resolve(controller('second'));
  await f.calls[1].promise;
  f.calls[0].resolve(controller('first'));
  await f.calls[0].promise;
  assert.deepEqual(disposed, ['first']);
  assert.equal(f.mainEl.children[0], f.calls[1].container);

  f.setMode('diff');
  f.setDiffMode('collapsed');
  f.viewer.render();
  assert.deepEqual(disposed, ['first', 'second']);
  assert.deepEqual(f.calls[2].options, { original: '', modified: 'second', language: 'plaintext', mode: 'collapsed', autoScroll: false });
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
