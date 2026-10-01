import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mountDiffEditor, mountEditor } from '../../public/monaco-view.js';

const originalWindow = globalThis.window;
const originalMonaco = globalThis.monaco;

after(() => {
  globalThis.window = originalWindow;
  globalThis.monaco = originalMonaco;
});

function stubDiffEditor(initialChanges) {
  let changes = initialChanges;
  const listeners = new Set();
  const revealed = [];
  const panes = {};
  for (const side of ['original', 'modified']) {
    const decorations = new Map();
    let nextId = 0;
    panes[side] = {
      decorations,
      getModel: () => ({ getLineCount: () => 20 }),
      revealLineInCenter: (line) => revealed.push(line),
      deltaDecorations(oldIds, newDecorations) {
        for (const id of oldIds) decorations.delete(id);
        return newDecorations.map((decoration) => {
          const id = String(++nextId);
          decorations.set(id, decoration);
          return id;
        });
      },
    };
  }
  globalThis.window = { monaco: true };
  globalThis.monaco = {
    editor: {
      createDiffEditor: () => ({
        setModel() {},
        getLineChanges: () => changes,
        getOriginalEditor: () => panes.original,
        getModifiedEditor: () => panes.modified,
        onDidUpdateDiff(listener) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
        dispose() {},
      }),
      createModel: () => ({ dispose() {} }),
    },
  };
  return {
    panes,
    revealed,
    listeners,
    setChanges(value) { changes = value; },
    updateDiff(value) {
      changes = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

function markedLines(pane) {
  return [...pane.decorations.values()].map(({ range, options }) => {
    assert.equal(options.linesDecorationsClassName, 'current-hunk-marker');
    assert.equal(options.isWholeLine, true);
    return [range.startLineNumber, range.endLineNumber];
  });
}

test('jumped-to hunk has a gutter marker spanning its lines, moving and wrapping in every diff mode', async () => {
  for (const mode of ['inline', 'side-by-side', 'collapsed']) {
    const { panes, revealed } = stubDiffEditor([
      { originalStartLineNumber: 1, originalEndLineNumber: 0, modifiedStartLineNumber: 2, modifiedEndLineNumber: 4 },
      { originalStartLineNumber: 8, originalEndLineNumber: 9, modifiedStartLineNumber: 10, modifiedEndLineNumber: 12 },
    ]);
    const view = await mountDiffEditor({}, { original: 'old', modified: 'new', mode });
    assert.deepEqual(markedLines(panes.modified), []);
    view.nextChange();
    assert.deepEqual(markedLines(panes.modified), [[2, 4]]);
    assert.deepEqual(markedLines(panes.original), []);
    view.nextChange();
    assert.deepEqual(markedLines(panes.modified), [[10, 12]]);
    assert.deepEqual(markedLines(panes.original), [[8, 9]]);
    view.nextChange();
    assert.deepEqual(markedLines(panes.modified), [[2, 4]]);
    assert.deepEqual(markedLines(panes.original), []);
    view.prevChange();
    assert.deepEqual(markedLines(panes.modified), [[10, 12]]);
    assert.deepEqual(revealed, [2, 10, 2, 10]);
    view.dispose();
  }
});

test('deletion-only hunks mark deleted original lines and a visible modified anchor at file boundaries', async () => {
  for (const mode of ['inline', 'side-by-side', 'collapsed']) {
    const { panes, revealed } = stubDiffEditor([
      { originalStartLineNumber: 1, originalEndLineNumber: 3, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 },
      { originalStartLineNumber: 9, originalEndLineNumber: 11, modifiedStartLineNumber: 5, modifiedEndLineNumber: 0 },
      { originalStartLineNumber: 24, originalEndLineNumber: 27, modifiedStartLineNumber: 20, modifiedEndLineNumber: 0 },
    ]);
    const view = await mountDiffEditor({}, { original: 'old', modified: 'new', mode });
    view.nextChange();
    assert.deepEqual(markedLines(panes.original), [[1, 3]]);
    assert.deepEqual(markedLines(panes.modified), [[1, 1]]);
    view.nextChange();
    assert.deepEqual(markedLines(panes.original), [[9, 11]]);
    assert.deepEqual(markedLines(panes.modified), [[5, 5]]);
    view.nextChange();
    assert.deepEqual(markedLines(panes.original), [[24, 27]]);
    assert.deepEqual(markedLines(panes.modified), [[20, 20]]);
    assert.deepEqual(revealed, [1, 5, 20]);
    view.dispose();
  }
  const { panes } = stubDiffEditor([
    { originalStartLineNumber: 1, originalEndLineNumber: 20, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 },
  ]);
  panes.modified.getModel = () => ({ getLineCount: () => 1 }); // Empty Monaco models still have one line.
  const view = await mountDiffEditor({}, { original: 'deleted file', modified: '' });
  view.prevChange();
  assert.deepEqual(markedLines(panes.original), [[1, 20]]);
  assert.deepEqual(markedLines(panes.modified), [[1, 1]]);
  view.dispose();
});

test('navigating with no computed hunks clears both markers and resets the next jump', async () => {
  const { panes, setChanges, revealed } = stubDiffEditor([
    { originalStartLineNumber: 8, originalEndLineNumber: 9, modifiedStartLineNumber: 10, modifiedEndLineNumber: 12 },
  ]);
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new' });
  for (const empty of [[], null]) {
    view.nextChange();
    assert.deepEqual(markedLines(panes.original), [[8, 9]]);
    setChanges(empty);
    view.prevChange();
    assert.deepEqual(markedLines(panes.original), []);
    assert.deepEqual(markedLines(panes.modified), []);
    setChanges([
      { originalStartLineNumber: 8, originalEndLineNumber: 9, modifiedStartLineNumber: 10, modifiedEndLineNumber: 12 },
      { originalStartLineNumber: 16, originalEndLineNumber: 17, modifiedStartLineNumber: 18, modifiedEndLineNumber: 19 },
    ]);
  }
  view.nextChange();
  assert.deepEqual(revealed, [10, 10, 10]);
  view.dispose();
});

test('diff recomputation clears stale markers without waiting for another jump', async () => {
  const { panes, updateDiff, revealed } = stubDiffEditor([
    { originalStartLineNumber: 8, originalEndLineNumber: 9, modifiedStartLineNumber: 10, modifiedEndLineNumber: 12 },
  ]);
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new' });
  view.nextChange();
  updateDiff([
    { originalStartLineNumber: 14, originalEndLineNumber: 16, modifiedStartLineNumber: 15, modifiedEndLineNumber: 18 },
  ]);
  assert.deepEqual(markedLines(panes.original), []);
  assert.deepEqual(markedLines(panes.modified), []);
  assert.deepEqual(revealed, [10], 'recomputation does not jump automatically');
  view.nextChange();
  assert.deepEqual(markedLines(panes.modified), [[15, 18]]);
  updateDiff([]);
  assert.deepEqual(markedLines(panes.original), []);
  assert.deepEqual(markedLines(panes.modified), []);
  view.dispose();
});

test('disposing a diff controller unsubscribes even before its pending auto-scroll jump', async () => {
  for (const autoScroll of [false, true]) {
    for (const computed of [false, true]) {
      const { listeners, revealed, updateDiff } = stubDiffEditor(null);
      const view = await mountDiffEditor({}, { original: 'old', modified: 'new', autoScroll });
      const changes = [{ originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 2, modifiedEndLineNumber: 4 }];
      if (computed) updateDiff(changes);
      assert.equal(listeners.size, 1);
      view.dispose();
      assert.equal(listeners.size, 0);
      updateDiff(changes);
      assert.deepEqual(revealed, autoScroll && computed ? [2] : []);
    }
  }
});

test('hunks sharing a modified-side anchor remain distinct navigation targets', async () => {
  const changes = [
    { originalStartLineNumber: 1, originalEndLineNumber: 2, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 },
    { originalStartLineNumber: 3, originalEndLineNumber: 4, modifiedStartLineNumber: 1, modifiedEndLineNumber: 2 },
  ];
  const { panes, revealed, setChanges } = stubDiffEditor(changes);
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new' });
  view.nextChange();
  assert.deepEqual(markedLines(panes.original), [[1, 2]]);
  setChanges(changes.map((change) => ({ ...change }))); // Monaco can return fresh change objects.
  view.nextChange();
  assert.deepEqual(markedLines(panes.original), [[3, 4]]);
  assert.deepEqual(markedLines(panes.modified), [[1, 2]]);
  view.nextChange();
  assert.deepEqual(markedLines(panes.original), [[1, 2]]);
  view.prevChange();
  assert.deepEqual(markedLines(panes.original), [[3, 4]]);
  view.prevChange();
  assert.deepEqual(markedLines(panes.original), [[1, 2]]);
  assert.deepEqual(revealed, [1, 1, 1, 1, 1]);
  view.dispose();
});

test('diff controller navigates fresh hunks in both directions, wrapping at the ends', async () => {
  const revealed = [];
  const disposed = [];
  let changes = null; // Monaco can be computing the diff when the view first mounts.
  globalThis.window = { monaco: true };
  globalThis.monaco = {
    editor: {
      createDiffEditor() {
        return {
          setModel() {},
          getLineChanges: () => changes,
          onDidUpdateDiff: () => ({ dispose() {} }),
          getOriginalEditor: () => ({ deltaDecorations: () => [] }),
          getModifiedEditor: () => ({
            deltaDecorations: () => [],
            getModel: () => ({ getLineCount: () => 20 }),
            revealLineInCenter: (line) => revealed.push(line),
          }),
          dispose: () => disposed.push('editor'),
        };
      },
      createModel() { return { dispose: () => disposed.push('model') }; },
    },
  };

  const view = await mountDiffEditor({}, { original: 'old', modified: 'new' });
  view.nextChange();
  assert.deepEqual(revealed, []);
  changes = [2, 8, 15].map((modifiedStartLineNumber) => ({ modifiedStartLineNumber }));
  view.nextChange();
  view.nextChange();
  view.nextChange();
  view.nextChange();
  view.prevChange();
  view.prevChange();
  assert.deepEqual(revealed, [2, 8, 15, 2, 15, 8]);

  changes = [{ modifiedStartLineNumber: 4 }, { modifiedStartLineNumber: 20 }];
  view.nextChange();
  view.prevChange();
  assert.deepEqual(revealed.slice(-2), [20, 4]);
  changes = [{ modifiedStartLineNumber: 0 }]; // deletion at start of file
  view.nextChange();
  assert.equal(revealed.at(-1), 1);
  changes = [];
  view.prevChange();
  assert.equal(revealed.length, 9);
  changes = [{ modifiedStartLineNumber: 25 }]; // deletion past the last modified line
  view.prevChange();
  assert.equal(revealed.at(-1), 20);
  changes = [{ modifiedStartLineNumber: 2 }, { modifiedStartLineNumber: 8 }];
  view.nextChange(); // no hunks reset navigation to the first change
  assert.equal(revealed.at(-1), 2);
  view.dispose();
  assert.deepEqual(disposed, ['editor', 'model', 'model']);
});

test('File mode controller does not expose change navigation', async () => {
  globalThis.window = { monaco: true };
  globalThis.monaco = { editor: { create: () => ({ dispose() {} }) } };
  const view = await mountEditor({}, { content: 'plain' });
  assert.equal(view.nextChange, undefined);
  assert.equal(view.prevChange, undefined);
  view.dispose();
});

test('File mode scrolls ten configured line heights from the current viewport in either direction', async () => {
  let scrollTop = 500;
  let lineHeight = 23;
  const positions = [];
  globalThis.window = { monaco: true };
  globalThis.monaco = {
    editor: {
      EditorOption: { lineHeight: 67 },
      create: () => ({
        getScrollTop: () => scrollTop,
        getOption(option) {
          assert.equal(option, 67);
          return lineHeight;
        },
        setScrollTop(position) { positions.push(position); scrollTop = position; },
        dispose() {},
      }),
    },
  };
  const view = await mountEditor({}, { content: 'plain', wrap: true });
  view.scrollUp();
  view.scrollDown();
  view.scrollDown();
  scrollTop = 1000; // Mouse scrolling can move the viewport between shortcuts.
  lineHeight = 19; // Read Monaco's current configuration, not a cached pixel step.
  view.scrollUp();
  assert.deepEqual(positions, [270, 500, 730, 810]);
  view.dispose();
});

test('all diff layouts scroll ten current line heights through the modified editor', async () => {
  for (const mode of ['inline', 'side-by-side', 'collapsed']) {
    let scrollTop = 500;
    let lineHeight = 23;
    const positions = [];
    globalThis.window = { monaco: true };
    globalThis.monaco = {
      editor: {
        EditorOption: { lineHeight: 67 },
        createDiffEditor() {
          return {
            setModel() {},
            onDidUpdateDiff: () => ({ dispose() {} }),
            getModifiedEditor: () => ({
              getScrollTop: () => scrollTop,
              getOption(option) {
                assert.equal(option, 67);
                return lineHeight;
              },
              setScrollTop(position) { positions.push(position); scrollTop = position; },
            }),
            dispose() {},
          };
        },
        createModel() { return { dispose() {} }; },
      },
    };
    const view = await mountDiffEditor({}, { original: 'old', modified: 'new', mode, wrap: true });
    view.scrollUp();
    view.scrollDown();
    view.scrollDown();
    scrollTop = 1000;
    lineHeight = 19;
    view.scrollUp();
    assert.deepEqual(positions, [270, 500, 730, 810], mode);
    view.dispose();
  }
});

test('diff viewer uses Monaco diff word wrap when requested', async () => {
  let options;
  globalThis.window = { monaco: true };
  globalThis.monaco = {
    editor: {
      createDiffEditor(_container, settings) {
        options = settings;
        return { setModel() {}, onDidUpdateDiff: () => ({ dispose() {} }), dispose() {} };
      },
      createModel() { return { dispose() {} }; },
    },
  };
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new', wrap: true });
  assert.equal(options.diffWordWrap, 'on');
  view.dispose();
});

test('file viewer uses Monaco word wrap when requested', async () => {
  let options;
  globalThis.window = { monaco: true };
  globalThis.monaco = {
    editor: {
      create(_container, settings) {
        options = settings;
        return { dispose() {} };
      },
    },
  };
  const view = await mountEditor({}, { content: 'long line', wrap: true });
  assert.equal(options.wordWrap, 'on');
  view.dispose();
});

test('auto-scroll reveals and marks the first change once the diff is computed, and only once', async () => {
  const changes = [
    { originalStartLineNumber: 6, originalEndLineNumber: 8, modifiedStartLineNumber: 7, modifiedEndLineNumber: 10 },
    { originalStartLineNumber: 10, originalEndLineNumber: 11, modifiedStartLineNumber: 12, modifiedEndLineNumber: 13 },
  ];
  const { panes, revealed, updateDiff } = stubDiffEditor(null);
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new', autoScroll: true });
  assert.deepEqual(revealed, []);
  updateDiff(changes);
  assert.deepEqual(markedLines(panes.original), [[6, 8]]);
  assert.deepEqual(markedLines(panes.modified), [[7, 10]]);
  updateDiff(changes);
  assert.deepEqual(revealed, [7]);
  assert.deepEqual(markedLines(panes.modified), []);
  view.dispose();
});
