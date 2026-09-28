import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mountDiffEditor, mountEditor } from './monaco-view.js';

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
