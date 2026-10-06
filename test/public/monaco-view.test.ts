import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { clampLine, DIFF_RENDER_MODES, mountDiffEditor as realMountDiffEditor, mountEditor as realMountEditor } from '../../public/monaco-view.js';
import type { DiffOptions, EditorOptions, Draft } from '../../public/editor-port.js';
import type { LineChange, CodeEditor, Decoration, Position, MouseEvent, MountSettings } from '../../public/monaco-port.js';
import { Element, FakeDocument } from './fake-dom.js';
import { setLoaderWindow, fakeZone, present } from './monaco-fake.js';
import type { FakeZone } from './monaco-fake.js';

// These fixtures simulate only mounting/DOM IO, never the controller owner.
function mountEditor(_container: object, options: Omit<EditorOptions<Element>, 'document'> & { document?: FakeDocument }) {
  const document = options.document ?? new FakeDocument();
  return realMountEditor(document.createElement('div'), { ...options, document });
}
function mountDiffEditor(_container: object, options: Omit<DiffOptions<Element>, 'document'> & { document?: FakeDocument }) {
  const document = options.document ?? new FakeDocument();
  return realMountDiffEditor(document.createElement('div'), { ...options, document });
}

const originalWindow = globalThis.window;
const originalMonaco = globalThis.monaco;

after(() => {
  setLoaderWindow(originalWindow);
  globalThis.monaco = originalMonaco;
});

function stubDiffEditor(initialChanges: LineChange[] | null) {
  let changes = initialChanges;
  const listeners = new Set<() => void>();
  const revealed: number[] = [];
  const cursors: Position[] = [];
  const focused: string[] = [];
  const panes: { original?: Partial<CodeEditor> & { decorations: Map<string, Decoration> }; modified?: Partial<CodeEditor> & { decorations: Map<string, Decoration> } } = {};
  for (const side of ['original', 'modified'] as const) {
    const decorations = new Map<string, Decoration>();
    let nextId = 0;
    panes[side] = {
      decorations,
      getModel: () => ({ getLineCount: () => 20 }),
      revealLineInCenter: (line) => revealed.push(line),
      setPosition: (position) => cursors.push(position),
      focus: () => focused.push(side),
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
  setLoaderWindow({ monaco: true });
  globalThis.monaco = {
    editor: {
      createDiffEditor: () => ({
        setModel() {},
        getLineChanges: () => changes,
        getOriginalEditor: () => present(panes.original),
        getModifiedEditor: () => present(panes.modified),
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
    panes: { original: present(panes.original), modified: present(panes.modified) },
    revealed,
    cursors,
    focused,
    listeners,
    setChanges(value: LineChange[] | null) { changes = value; },
    updateDiff(value: LineChange[] | null) {
      changes = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

function markedLines(pane: { decorations: Map<string, Decoration> }) {
  return [...pane.decorations.values()].map(({ range, options }) => {
    assert.equal(options.linesDecorationsClassName, 'current-hunk-marker');
    assert.equal(options.isWholeLine, true);
    return [range.startLineNumber, range.endLineNumber];
  });
}

test('jumped-to hunk has a gutter marker spanning its lines, moving and wrapping in every diff mode', async () => {
  for (const mode of DIFF_RENDER_MODES) {
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
  for (const mode of DIFF_RENDER_MODES) {
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

test('jumping to a change puts the cursor at the start of that change line, in both directions', async () => {
  const { cursors, focused } = stubDiffEditor([
    { originalStartLineNumber: 1, originalEndLineNumber: 0, modifiedStartLineNumber: 2, modifiedEndLineNumber: 4 },
    { originalStartLineNumber: 9, originalEndLineNumber: 9, modifiedStartLineNumber: 12, modifiedEndLineNumber: 12 },
  ]);
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new' });
  view.nextChange();
  view.nextChange();
  view.prevChange();
  assert.deepEqual(cursors, [
    { lineNumber: 2, column: 1 },
    { lineNumber: 12, column: 1 },
    { lineNumber: 2, column: 1 },
  ]);
  assert.deepEqual(focused, ['modified', 'modified', 'modified'], 'Monaco only draws the cursor in a focused editor');
  view.dispose();
});

test('auto-scroll to the first change on opening a diff also puts the cursor at the start of its line', async () => {
  const { cursors, updateDiff } = stubDiffEditor(null);
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new', autoScroll: true });
  assert.deepEqual(cursors, []);
  updateDiff([{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 7, modifiedEndLineNumber: 8 }]);
  assert.deepEqual(cursors, [{ lineNumber: 7, column: 1 }]);
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

test('supported modes and invalid-mode inline fallback retain exact review rails and native selection', async () => {
  const document = new FakeDocument();
  const thread = { id: 't', file: 'a', line_range: { start: 1, end: 2 }, side: 'modified',
    created_at: '2026-10-01T12:00:00Z', resolved: true,
    messages: [{ id: 'm', author: 'agent', created_at: '2026-10-01T12:00:00Z', text: '<b>literal</b>\nSecond line' }] };
  assert.deepEqual(DIFF_RENDER_MODES, ['inline', 'side-by-side']);
  for (const mode of [...DIFF_RENDER_MODES, undefined, 'collapsed', 'unknown', 'toString']) {
    const zones: FakeZone[] = [];
    const removed: (string | number)[] = [];
    let options: MountSettings | undefined;
    setLoaderWindow({ monaco: true });
    globalThis.monaco = { editor: {
      createDiffEditor(_container, settings) {
        options = settings;
        return { setModel() {}, dispose() {}, onDidUpdateDiff: () => ({ dispose() {} }), getModifiedEditor: () => ({
          getModel: () => ({ getLineCount: () => 3 }),
          updateOptions(settings) { assert.equal(settings.folding, false); },
          changeViewZones(fn) { fn({ addZone(zone) { fakeZone(zone); zones.push(zone); return zones.length; }, removeZone: (id) => removed.push(id) }); },
        }) };
      },
      createModel: () => ({ dispose() {} }),
    } };
    const view = await mountDiffEditor({}, { original: 'old', modified: 'a\nb\nc', mode, threads: [thread], document });
    assert.equal(zones.length, 1);
    assert.equal(zones[0].afterLineNumber, 2);
    assert.equal(zones[0].showInHiddenAreas, undefined);
    assert.equal(zones[0].suppressMouseDown, false);
    const article = zones[0].domNode.children[0].children[0];
    assert.equal(article['aria-label'], 'Thread t, Resolved');
    assert.match(article.className, /resolved/);
    assert.equal(article.children[1].children[0].children[1].textContent, '<b>literal</b>\nSecond line');
    let stopped = false;
    zones[0].domNode.events.mousedown({ stopPropagation() { stopped = true; }, preventDefault() { assert.fail('must not block selection'); } });
    assert.equal(stopped, true);
    assert.equal(present(options).renderSideBySide, mode === 'side-by-side');
    assert.equal(present(present(options).hideUnchangedRegions).enabled, false);
    view.dispose();
    assert.deepEqual(removed, [1]);
  }
});

test('review updates group anchors, resize long conversations, reject invalid ranges and dispose observers', async () => {
  const zones = new Map<string | number, FakeZone>();
  const relayout: (string | number)[] = [];
  const observers: ResizeObserver[] = [];
  let nextId = 0;
  const document = new FakeDocument({ top: 0, height: 450 });
  class ResizeObserver {
    disconnected = false;
    node?: Element;
    constructor(public callback: () => void) { observers.push(this); }
    observe(node: Element) { this.node = node; }
    disconnect() { this.disconnected = true; }
  }
  const modifiedEditor: Partial<CodeEditor> = {
    getModel: () => ({ getLineCount: () => 3 }),
    updateOptions() {},
    changeViewZones(fn) { fn({ addZone(zone) { fakeZone(zone); zones.set(++nextId, zone); return nextId; },
      removeZone: (id) => zones.delete(id), layoutZone: (id) => relayout.push(id) }); },
  };
  setLoaderWindow({ monaco: true });
  globalThis.monaco = { editor: {
    createDiffEditor: () => ({ setModel() {}, getModifiedEditor: () => modifiedEditor,
      onDidUpdateDiff: () => ({ dispose() {} }), dispose() {} }),
    createModel: () => ({ dispose() {} }),
  } };
  const t = { id: 't', file: 'a', side: 'modified', line_range: { start: 1, end: 2 },
    messages: [{ id: 'm', author: 'user', text: 'Long conversation', created_at: 'now' }] };
  const view = await mountDiffEditor({}, { modified: 'a\nb\nc', threads: [t], document, ResizeObserver });
  view.updateThreads([t, { ...t, id: 'second' }, { ...t, id: 'out', line_range: { start: 2, end: 4 } },
    { ...t, id: 'old-side', side: 'original' }, { ...t, id: 'zero', line_range: { start: 0, end: 1 } }]);
  assert.equal(zones.size, 1, 'same last anchor line shares one rail; no clamping');
  assert.equal([...zones.values()][0].domNode.children[0].children.length, 2);
  present(observers.at(-1)).callback();
  assert.equal([...zones.values()][0].heightInPx, 466);
  assert.equal(relayout.length, 1);
  view.dispose();
  assert.equal(zones.size, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
  present(observers.at(-1)).callback();
  assert.equal(relayout.length, 1, 'queued resize cannot resurrect disposed zones');
});

test('File conversations reveal their zone without clamping or cursor manipulation and clean up on refresh', async () => {
  const zones = new Map<string | number, FakeZone>();
  const reveals: number[] = [];
  const folding: (boolean | undefined)[] = [];
  const document = new FakeDocument({ top: 0, height: 40 });
  setLoaderWindow({ monaco: true });
  globalThis.monaco = { editor: { EditorOption: { lineHeight: 1 }, create: () => ({
    getModel: () => ({ getLineCount: () => 3, getLineMaxColumn: () => 2 }),
    updateOptions: (options) => folding.push(options.folding),
    getTopForPosition: () => 20,
    getOption: () => 20,
    getLayoutInfo: () => ({ height: 200, horizontalScrollbarHeight: 0 }),
    setScrollTop: (top) => reveals.push(top), render() {},
    setPosition() { assert.fail('must not change cursor'); },
    changeViewZones(fn) { fn({ addZone(zone) { fakeZone(zone); zones.set(1, zone); return 1; }, removeZone: (id) => zones.delete(id), layoutZone() {} }); },
    dispose() {},
  }) } };
  const thread = { id: 't', file: 'a', side: 'modified', line_range: { start: 1, end: 2 }, messages: [] };
  const view = await mountEditor({}, { content: 'a\nb\nc', threads: [thread], document });
  assert.equal(present(zones.get(1)).afterLineNumber, 2);
  assert.equal(view.revealThread('t'), true);
  assert.equal(reveals.at(-1), 12, 'reveal the conversation with its last anchor line as context');
  view.updateThreads([{ ...thread, line_range: { start: 2, end: 4 } }]);
  assert.equal(zones.size, 0);
  assert.equal(view.revealThread('t'), false);
  assert.equal(reveals.length, 2);
  view.updateThreads([]);
  assert.deepEqual(folding, [false, true]);
  view.dispose();
  assert.equal(view.revealThread('t'), false);
});

test('long last-line anchors reveal the chosen shared-end conversation using live wrapped and resized geometry', async () => {
  for (const mode of ['file', 'inline', 'side-by-side']) {
    const zones = new Map<string | number, FakeZone>();
    const positions: number[] = [];
    const observers: ResizeObserver[] = [];
    let nextId = 0;
    let scrollTop = 0;
    let anchorTop = 3980;
    let firstHeight = 300;
    let lineCount = 200;
    const document = new FakeDocument();
    class ResizeObserver {
      disconnected = false;
      constructor(public callback: () => void) { observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
    const model = { getLineCount: () => lineCount, getLineMaxColumn(line: number) { assert.equal(line, 200); return 501; }, dispose() {} };
    const editor: Partial<CodeEditor> & { revealRangeInCenter(): never } = {
      getModel: () => model, updateOptions() {}, dispose() {},
      getTopForPosition(line, column) { assert.deepEqual([line, column], [200, 501]); return anchorTop; },
      getOption: () => 20,
      getLayoutInfo: () => ({ height: 415, horizontalScrollbarHeight: 15 }),
      getScrollTop: () => scrollTop,
      setScrollTop(top) { positions.push(top); scrollTop = top; },
      revealRangeInCenter() { assert.fail('an oversized code range must not be centered'); },
      setPosition() { assert.fail('conversation reveal must not move the cursor'); },
      render() { for (const zone of zones.values()) zone.onDomNodeTop?.(anchorTop + 20 - scrollTop); },
      changeViewZones(fn) { fn({ addZone(zone) {
        fakeZone(zone);
        zones.set(++nextId, zone);
        zone.domNode.getBoundingClientRect = () => ({ top: anchorTop + 20 - scrollTop, height: zone.heightInPx });
        const rail = zone.domNode.children[0];
        rail.getBoundingClientRect = () => ({ top: 0, height: firstHeight + 700 });
        rail.children.forEach((article, index) => {
          article.getBoundingClientRect = () => ({ top: anchorTop + 28 - scrollTop + (index ? firstHeight : 0), height: index ? 700 : firstHeight });
        });
        return nextId;
      }, removeZone: (id) => zones.delete(id), layoutZone() {} }); },
    };
    setLoaderWindow({ monaco: true });
    globalThis.monaco = { editor: { EditorOption: { lineHeight: 1 }, create: () => editor, createModel: () => model,
      createDiffEditor: () => ({ setModel() {}, dispose() {}, getModifiedEditor: () => editor,
        onDidUpdateDiff: () => ({ dispose() {} }),
      }),
    } };
    const thread = { id: 'first', file: 'a', side: 'modified', line_range: { start: 1, end: 200 }, messages: [] };
    const options = { threads: [thread, { ...thread, id: 'second' }], document, ResizeObserver, wrap: true };
    const view = mode === 'file' ? await mountEditor({}, { ...options, content: 'wrapped content' })
      : await mountDiffEditor({}, { ...options, mode, modified: 'wrapped content' });
    assert.equal([...zones.values()][0].afterLineNumber, 200, 'last file line remains exact');
    assert.equal(view.revealThread('first'), true);
    assert.equal(positions.at(-1), 3972, 'the short first conversation fits with last-line context');
    assert.equal(view.revealThread('second'), true);
    assert.equal(positions.at(-1), 4300, 'the tall second conversation opens at its own start, not the first');
    firstHeight = 600;
    present(observers.at(-1)).callback();
    view.revealThread('second');
    assert.equal(positions.at(-1), 4600, 'live offsets reflect resized preceding conversations');
    anchorTop = 5120; // More wrapped code/earlier zones push this anchor down.
    view.revealThread('second');
    assert.equal(positions.at(-1), 5740, 'fresh geometry includes wrapping and preceding zones, never a next-line lookup');
    lineCount = 250;
    anchorTop = 5160; // Native alignment earlier in the file changes public position geometry.
    view.revealThread('second');
    assert.equal(positions.at(-1), 5780, 'fresh public geometry accounts for earlier native alignment, not following lines/zones');
    view.updateThreads([{ ...thread, id: 'replacement' }]);
    assert.equal(view.revealThread('second'), false, 'refresh removes old article targets');
    assert.equal(view.revealThread('replacement'), true);
    assert.equal(positions.at(-1), 5180, 'refresh targets the replacement article');
    view.updateThreads([]);
    const count = positions.length;
    assert.equal(view.revealThread('second'), false);
    view.dispose();
    present(observers.at(-1)).callback();
    assert.equal(view.revealThread('first'), false);
    assert.equal(positions.length, count);
    assert.ok(observers.every((observer) => observer.disconnected));
  }
});

test('same-anchor native deletion/alignment zones taller than the viewport cannot hide or shrink the chosen comment rail', async () => {
  for (const mode of ['file', 'inline', 'side-by-side']) {
    for (const nativeSide of ['original', 'modified']) {
      let scrollTop = 0;
      let ownZone: FakeZone | undefined;
      let visible = false;
      let ownTop = 0;
      let nativeOriginal = nativeSide === 'original' ? [{ heightInPx: 1200 }] : [];
      let nativeModified = nativeSide === 'modified' ? [{ heightInPx: 1000 }] : [];
      const observers: ResizeObserver[] = [];
      const rect = (offset: number, height: number) => visible ? { top: ownTop - scrollTop + offset, height } : { top: 0, height: 0 };
      const document = new FakeDocument();
      class ResizeObserver {
        disconnected = false;
        constructor(public callback: () => void) { observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
      }
      // Monaco 0.45's lineAlignment omits ordinal/afterColumn. Sorting uses
      // ordinal ?? afterColumn ?? 10000, not creation order, on both panes.
      const ordinal = (zone: { heightInPx: number; ordinal?: number; afterColumn?: number }) => zone.ordinal ?? zone.afterColumn ?? 10000;
      const model = { getLineCount: () => 200, getLineMaxColumn(line: number) { assert.equal(line, 200); return 501; }, dispose() {} };
      const editor: Partial<CodeEditor> & { revealRangeInCenter(): never } = {
        getModel: () => model, updateOptions() {}, dispose() {},
        getTopForPosition(line, column) { assert.deepEqual([line, column], [200, 501]); return 3980; },
        getOption: () => 20,
        getLayoutInfo: () => ({ height: 400, horizontalScrollbarHeight: 0 }),
        getScrollTop: () => scrollTop,
        setScrollTop(top) { scrollTop = top; },
        revealRangeInCenter() { assert.fail('must not clamp or center the code range'); },
        render() {
          const zone = present(ownZone);
          const ordered = [...nativeModified, zone].sort((a, b) => ordinal(a) - ordinal(b));
          ownTop = 4000 + ordered.slice(0, ordered.indexOf(zone)).reduce((sum, zone) => sum + zone.heightInPx, 0);
          visible = ownTop < scrollTop + 400 && ownTop + zone.heightInPx > scrollTop;
          present(zone.onDomNodeTop)(visible ? ownTop - scrollTop : -1000000 - scrollTop);
        },
        changeViewZones(fn) { fn({ addZone(zone) {
          fakeZone(zone);
          ownZone = zone;
          zone.domNode.getBoundingClientRect = () => rect(0, zone.heightInPx);
          const rail = zone.domNode.children[0];
          rail.getBoundingClientRect = () => rect(8, 800);
          rail.children[0].getBoundingClientRect = () => rect(8, 180);
          rail.children[1].getBoundingClientRect = () => rect(188, 620);
          return 'comments';
        }, removeZone() {}, layoutZone() {} }); },
      };
      setLoaderWindow({ monaco: true });
      globalThis.monaco = { editor: { EditorOption: { lineHeight: 1 }, create: () => editor, createModel: () => model,
        createDiffEditor: () => ({ setModel() {}, dispose() {}, getModifiedEditor: () => editor,
          onDidUpdateDiff: () => ({ dispose() {} }),
        }),
      } };
      const thread = { id: 'first', file: 'a', side: 'modified', line_range: { start: 1, end: 200 }, messages: [] };
      const options = { threads: [thread, { ...thread, id: 'second' }], document, ResizeObserver, wrap: true };
      const view = mode === 'file' ? await mountEditor({}, { ...options, content: 'wrapped EOF anchor' })
        : await mountDiffEditor({}, { ...options, mode, modified: 'wrapped EOF anchor' });
      present(editor.render)();
      observers[0].callback(); // Native display:none produces zero DOM measurements.
      assert.equal(present(ownZone).heightInPx, 120, 'hidden rails retain their previous height');
      assert.equal(view.revealThread('second'), true);
      present(editor.render)();
      assert.equal(scrollTop, 4180, 'selected shared-end conversation is before tall native whitespace');
      assert.equal(visible, true);
      assert.equal(present(ownZone).domNode.children[0].children[1].getBoundingClientRect().top, 8);
      assert.equal(present(ownZone).heightInPx, 816);
      assert.equal(present(ownZone).ordinal, -1, 'the public ordinal precedes native default 10000');
      // An asynchronous native diff recomputation replaces both pane's zones
      // after the comment mount. Their heights/content must remain intact.
      nativeOriginal = [{ heightInPx: 1500 }];
      nativeModified = [{ heightInPx: 2000 }];
      scrollTop = 0;
      present(editor.render)();
      observers[0].callback();
      assert.equal(present(ownZone).heightInPx, 816);
      view.revealThread('first');
      present(editor.render)();
      assert.equal(scrollTop, 3972, 'last wrapped EOF line and first conversation fit as context');
      assert.equal(visible, true);
      assert.deepEqual(nativeOriginal, [{ heightInPx: 1500 }]);
      assert.deepEqual(nativeModified, [{ heightInPx: 2000 }]);
      view.dispose();
      assert.ok(observers.every((observer) => observer.disconnected));
    }
  }
});

test('selected conversation reveal wins delayed auto-scroll while hunk highlights and scroll shortcuts coexist', async () => {
  for (const mode of ['inline', 'side-by-side']) {
    const { panes, updateDiff, revealed } = stubDiffEditor(null);
    const positions: number[] = [];
    panes.modified.updateOptions = () => {};
    panes.modified.changeViewZones = (fn) => fn({ addZone: () => 1, removeZone() {}, layoutZone() {} });
    panes.modified.getModel = () => ({ getLineCount: () => 20, getLineMaxColumn: () => 5 });
    panes.modified.getTopForPosition = () => 160;
    panes.modified.getLayoutInfo = () => ({ height: 400, horizontalScrollbarHeight: 0 });
    panes.modified.render = () => {};
    panes.modified.getScrollTop = () => 100;
    panes.modified.getPosition = () => ({ lineNumber: 2, column: 1 });
    panes.modified.getTopForLineNumber = (line) => (line - 1) * 20;
    panes.modified.getOption = () => 20;
    panes.modified.setScrollTop = (position) => positions.push(position);
    globalThis.monaco.editor.EditorOption = { lineHeight: 1 };
    const document = new FakeDocument({ top: 0, height: 40 });
    const thread = { id: 't', file: 'a', side: 'modified', line_range: { start: 7, end: 9 }, messages: [] };
    const view = await mountDiffEditor({}, { mode, autoScroll: true, modified: 'content', threads: [thread], document });
    assert.equal(view.revealThread('t'), true);
    updateDiff([{ originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 2, modifiedEndLineNumber: 4 }]);
    assert.deepEqual(revealed, [], 'late auto-scroll must not override the chosen conversation');
    assert.deepEqual(positions, [180, 152], 'the chosen conversation and last-line context are revealed');
    view.nextChange();
    assert.deepEqual(markedLines(panes.modified), [[2, 4]]);
    view.scrollDown();
    assert.deepEqual(positions, [180, 152, 300]);
    view.dispose();
  }
});

test('diff controller navigates fresh hunks in both directions, wrapping at the ends', async () => {
  const revealed: number[] = [];
  const disposed: string[] = [];
  let changes: LineChange[] | null = null; // Monaco can be computing the diff when the view first mounts.
  setLoaderWindow({ monaco: true });
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
            setPosition() {},
            focus() {},
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
  setLoaderWindow({ monaco: true });
  globalThis.monaco = { editor: { create: () => ({ dispose() {} }) } };
  const view = await mountEditor({}, { content: 'plain' });
  assert.equal('nextChange' in view, false);
  assert.equal('prevChange' in view, false);
  view.dispose();
});

// A Monaco editor stub that records cursor moves, focus and scrolling, in
// order. `top` gives a line's vertical pixel offset, so tests can model
// soft-wrapped lines taking several rows.
function stubCursorEditor({ lineCount, cursor, scrollTop = 0, top = (line: number) => (line - 1) * 20 }: { lineCount: number; cursor: Position; scrollTop?: number; top?: (line: number) => number }) {
  const calls: (Position | { scrollTop: number } | string)[] = [];
  return {
    calls,
    editor: {
      getScrollTop: () => scrollTop,
      setScrollTop(position: number) { calls.push({ scrollTop: position }); scrollTop = position; },
      getTopForLineNumber: top,
      getModel: () => ({ getLineCount: () => lineCount }),
      getPosition: () => cursor,
      setPosition(position: Position) { calls.push(position); cursor = position; },
      focus() { calls.push('focus'); },
    },
    moveViewport(position: number) { scrollTop = position; },
  };
}

function withMonacoEditor(editor: Partial<CodeEditor>) {
  setLoaderWindow({ monaco: true });
  globalThis.monaco = {
    editor: {
      create: () => ({ ...editor, dispose() {} }),
      createDiffEditor: () => ({
        setModel() {},
        onDidUpdateDiff: () => ({ dispose() {} }),
        getModifiedEditor: () => editor,
        dispose() {},
      }),
      createModel() { return { dispose() {} }; },
    },
  };
}

test('clampLine keeps a line number within the file', () => {
  assert.equal(clampLine(-9, 85), 1);
  assert.equal(clampLine(0, 85), 1);
  assert.equal(clampLine(40, 85), 40);
  assert.equal(clampLine(95, 85), 85);
});

test('File mode scrolling moves the cursor ten lines and the viewport by the same distance, from the current viewport', async () => {
  const { editor, calls, moveViewport } = stubCursorEditor({ lineCount: 85, cursor: { lineNumber: 70, column: 5 }, scrollTop: 500 });
  withMonacoEditor(editor);
  const view = await mountEditor({}, { content: 'plain' });
  view.scrollDown();
  moveViewport(1000); // Mouse scrolling can move the viewport between shortcuts.
  view.scrollUp();
  assert.deepEqual(calls, [
    { scrollTop: 700 }, { lineNumber: 80, column: 1 }, 'focus',
    { scrollTop: 800 }, { lineNumber: 70, column: 1 }, 'focus',
  ]);
  view.dispose();
});

test('scrolling over soft-wrapped lines moves the viewport by the rows the cursor crossed', async () => {
  // Lines 72-75 each wrap onto three rows, so they are 60px tall instead of 20px.
  const top = (line: number) => (line - 1) * 20 + 40 * Math.max(0, Math.min(line, 76) - 72);
  const { editor, calls } = stubCursorEditor({ lineCount: 200, cursor: { lineNumber: 70, column: 1 }, scrollTop: 100, top });
  withMonacoEditor(editor);
  const view = await mountEditor({}, { content: 'plain', wrap: true });
  view.scrollDown();
  assert.deepEqual(calls, [{ scrollTop: 100 + 200 + 160 }, { lineNumber: 80, column: 1 }, 'focus']);
  view.dispose();
});

test('scrolling at the bottom of the file clamps the cursor and moves the viewport only as far', async () => {
  const { editor, calls } = stubCursorEditor({ lineCount: 85, cursor: { lineNumber: 80, column: 1 }, scrollTop: 300 });
  withMonacoEditor(editor);
  const view = await mountEditor({}, { content: 'plain' });
  view.scrollDown();
  view.scrollDown();
  assert.deepEqual(calls, [
    { scrollTop: 400 }, { lineNumber: 85, column: 1 }, 'focus',
    { scrollTop: 400 }, { lineNumber: 85, column: 1 }, 'focus',
  ]);
  view.dispose();
});

test('diff scrolling moves the modified-side cursor and viewport together', async () => {
  const { editor, calls } = stubCursorEditor({ lineCount: 200, cursor: { lineNumber: 70, column: 3 } });
  withMonacoEditor(editor);
  const view = await mountDiffEditor({}, { original: 'old', modified: 'new' });
  view.scrollDown();
  view.scrollUp();
  view.scrollUp();
  assert.deepEqual(calls, [
    { scrollTop: 200 }, { lineNumber: 80, column: 1 }, 'focus',
    { scrollTop: 0 }, { lineNumber: 70, column: 1 }, 'focus',
    { scrollTop: -200 }, { lineNumber: 60, column: 1 }, 'focus',
  ]);
  view.dispose();
});

test('diff viewer uses Monaco diff word wrap when requested', async () => {
  let options: MountSettings | undefined;
  setLoaderWindow({ monaco: true });
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
  assert.equal(present(options).diffWordWrap, 'on');
  view.dispose();
});

test('file viewer uses Monaco word wrap when requested', async () => {
  let options: MountSettings | undefined;
  setLoaderWindow({ monaco: true });
  globalThis.monaco = {
    editor: {
      create(_container, settings) {
        options = settings;
        return { dispose() {} };
      },
    },
  };
  const view = await mountEditor({}, { content: 'long line', wrap: true });
  assert.equal(present(options).wordWrap, 'on');
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

test('disposing a pending auto-scroll mount releases its listener and ignores queued updates', async () => {
  let updated: (() => void) | undefined;
  let unsubscribed = 0;
  setLoaderWindow({ monaco: true });
  globalThis.monaco = { editor: {
    createDiffEditor: () => ({ setModel() {}, dispose() {},
      onDidUpdateDiff(listener) { updated = listener; return { dispose: () => unsubscribed++ }; },
      getLineChanges() { assert.fail('disposed editor must not navigate'); },
    }), createModel: () => ({ dispose() {} }),
  } };
  const view = await mountDiffEditor({}, { original: '', modified: 'new', autoScroll: true });
  view.dispose();
  assert.equal(unsubscribed, 1);
  present(updated)();
  assert.equal(unsubscribed, 1);
});

// Mounts an editor with a Monaco stub and returns what the composer glue did.
async function mountWithComposer({ selection, lineCount = 10, content = 'plain', withComposer = true }: { selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; lineCount?: number; content?: string | null; withComposer?: boolean }) {
  const mouseDown: ((event: MouseEvent) => void)[] = [];
  const zones: FakeZone[] = [];
  const noop = () => ({ dispose() {} });
  const document = new FakeDocument();
  setLoaderWindow({ monaco: true });
  globalThis.monaco = {
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 'glyph', GUTTER_LINE_NUMBERS: 'numbers' },
      create: () => ({
        updateOptions() {},
        onMouseMove: noop,
        onMouseLeave: noop,
        onMouseDown: (listener) => { mouseDown.push(listener); return { dispose() {} }; },
        getModel: () => ({ getLineCount: () => lineCount }),
        getSelection: () => selection,
        getPosition: () => ({ lineNumber: selection.startLineNumber }),
        changeViewZones: (callback) => callback({ addZone: (zone) => { fakeZone(zone); return zones.push(zone); }, removeZone() {}, layoutZone() {} }),
        dispose() {},
      }),
    },
  };
  const changes: (Draft | null)[] = [];
  const composer = { draft: null, onChange: (draft: Draft | null) => changes.push(draft), save: async () => {} };
  const view = await mountEditor({}, { content, ...(withComposer ? { composer } : {}), document });
  return { view, mouseDown, zones, changes };
}
const sel = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => ({ startLineNumber, startColumn, endLineNumber, endColumn });

test('addComment opens the composer after the last line of the selected range', async () => {
  const { view, zones } = await mountWithComposer({ selection: sel(3, 2, 5, 4) });
  view.addComment();
  assert.equal(zones.length, 1);
  assert.equal(zones[0].afterLineNumber, 5);
  view.dispose();
});

test('a gutter click inside the selected range comments on the whole range, outside it on that line', async () => {
  const selection = sel(3, 2, 5, 4);
  const { view, mouseDown, zones } = await mountWithComposer({ selection });
  const click = (lineNumber: number) => mouseDown[0]({ target: { type: 'glyph', position: { lineNumber } } });
  click(4);
  assert.equal(present(zones.at(-1)).afterLineNumber, 5);
  click(8);
  assert.equal(present(zones.at(-1)).afterLineNumber, 8);
  view.dispose();
});

test('an invalid selection opens no composer', async () => {
  const { view, zones } = await mountWithComposer({ selection: sel(9, 1, 11, 2) });
  view.addComment();
  assert.deepEqual(zones, []);
  view.dispose();
});

test('addComment opens no composer when the view has no composer or no content', async () => {
  for (const options of [{ withComposer: false }, { content: null }]) {
    const { view, zones } = await mountWithComposer({ selection: sel(3, 2, 5, 4), ...options });
    view.addComment();
    assert.deepEqual(zones, []);
    view.dispose();
  }
});
