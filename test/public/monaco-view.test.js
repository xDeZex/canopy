import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mountDiffEditor, mountEditor } from '../../public/monaco-view.js';

const originalWindow = globalThis.window;
const originalMonaco = globalThis.monaco;

after(() => {
  globalThis.window = originalWindow;
  globalThis.monaco = originalMonaco;
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
          getModifiedEditor: () => ({
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
        return { setModel() {}, dispose() {} };
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

test('auto-scroll reveals the first change once the diff is computed, and only once', async () => {
  const revealed = [];
  let diffUpdated;
  let subscriptionDisposed = false;
  globalThis.window = { monaco: true };
  globalThis.monaco = {
    editor: {
      createDiffEditor() {
        return {
          setModel() {},
          getLineChanges: () => [{ modifiedStartLineNumber: 7 }, { modifiedStartLineNumber: 12 }],
          onDidUpdateDiff(listener) {
            diffUpdated = listener;
            return { dispose: () => { subscriptionDisposed = true; } };
          },
          getModifiedEditor: () => ({
            getModel: () => ({ getLineCount: () => 20 }),
            revealLineInCenter: (line) => revealed.push(line),
          }),
          dispose() {},
        };
      },
      createModel() { return { dispose() {} }; },
    },
  };

  await mountDiffEditor({}, { original: 'old', modified: 'new' });
  assert.equal(diffUpdated, undefined, 'no subscription unless auto-scroll is on');

  await mountDiffEditor({}, { original: 'old', modified: 'new', autoScroll: true });
  assert.deepEqual(revealed, []);
  diffUpdated();
  assert.deepEqual(revealed, [7]);
  assert.equal(subscriptionDisposed, true);
});
