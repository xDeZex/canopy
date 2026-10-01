import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DIFF_RENDER_MODES, mountDiffEditor, mountEditor } from '../../public/monaco-view.js';

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
  const document = { createElement: (tag) => ({ tagName: tag, children: [], textContent: '',
    setAttribute(name, value) { this[name] = value; }, replaceChildren(...children) { this.children = children; },
    addEventListener(name, fn) { (this.events ??= {})[name] = fn; },
  }) };
  const thread = { id: 't', file: 'a', line_range: { start: 1, end: 2 }, side: 'modified',
    created_at: '2026-10-01T12:00:00Z', resolved: true,
    messages: [{ id: 'm', author: 'agent', created_at: '2026-10-01T12:00:00Z', text: '<b>literal</b>\nSecond line' }] };
  assert.deepEqual(DIFF_RENDER_MODES, ['inline', 'side-by-side']);
  for (const mode of [...DIFF_RENDER_MODES, undefined, 'collapsed', 'unknown', 'toString']) {
    const zones = [];
    const removed = [];
    let options;
    globalThis.window = { monaco: true };
    globalThis.monaco = { editor: {
      createDiffEditor(_container, settings) {
        options = settings;
        return { setModel() {}, dispose() {}, onDidUpdateDiff: () => ({ dispose() {} }), getModifiedEditor: () => ({
          getModel: () => ({ getLineCount: () => 3 }),
          updateOptions(settings) { assert.equal(settings.folding, false); },
          changeViewZones(fn) { fn({ addZone(zone) { zones.push(zone); return zones.length; }, removeZone: (id) => removed.push(id) }); },
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
    assert.equal(options.renderSideBySide, mode === 'side-by-side');
    assert.equal(options.hideUnchangedRegions.enabled, false);
    view.dispose();
    assert.deepEqual(removed, [1]);
  }
});

test('review updates group anchors, resize long conversations, reject invalid ranges and dispose observers', async () => {
  const zones = new Map();
  const relayout = [];
  const observers = [];
  let nextId = 0;
  const document = { createElement: () => ({ children: [], setAttribute() {}, addEventListener() {},
    replaceChildren(...children) { this.children = children; }, getBoundingClientRect: () => ({ height: 450 }),
  }) };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
  }
  const modifiedEditor = {
    getModel: () => ({ getLineCount: () => 3 }),
    updateOptions() {},
    changeViewZones(fn) { fn({ addZone(zone) { zones.set(++nextId, zone); return nextId; },
      removeZone: (id) => zones.delete(id), layoutZone: (id) => relayout.push(id) }); },
  };
  globalThis.window = { monaco: true };
  globalThis.monaco = { editor: {
    createDiffEditor: () => ({ setModel() {}, getModifiedEditor: () => modifiedEditor,
      onDidUpdateDiff: () => ({ dispose() {} }), dispose() {} }),
    createModel: () => ({ dispose() {} }),
  } };
  const t = { id: 't', file: 'a', side: 'modified', line_range: { start: 1, end: 2 },
    messages: [{ author: 'user', text: 'Long conversation', created_at: 'now' }] };
  const view = await mountDiffEditor({}, { modified: 'a\nb\nc', threads: [t], document, ResizeObserver });
  view.updateThreads([t, { ...t, id: 'second' }, { ...t, id: 'out', line_range: { start: 2, end: 4 } },
    { ...t, id: 'old-side', side: 'original' }, { ...t, id: 'zero', line_range: { start: 0, end: 1 } }]);
  assert.equal(zones.size, 1, 'same last anchor line shares one rail; no clamping');
  assert.equal([...zones.values()][0].domNode.children[0].children.length, 2);
  observers.at(-1).callback();
  assert.equal([...zones.values()][0].heightInPx, 466);
  assert.equal(relayout.length, 1);
  view.dispose();
  assert.equal(zones.size, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
  observers.at(-1).callback();
  assert.equal(relayout.length, 1, 'queued resize cannot resurrect disposed zones');
});

test('File conversations reveal their zone without clamping or cursor manipulation and clean up on refresh', async () => {
  const zones = new Map();
  const reveals = [];
  const folding = [];
  const document = { createElement: () => ({ setAttribute() {}, addEventListener() {}, replaceChildren() {},
    getBoundingClientRect: () => ({ top: 0, height: 40 }),
  }) };
  globalThis.window = { monaco: true };
  globalThis.monaco = { editor: { EditorOption: { lineHeight: 1 }, create: () => ({
    getModel: () => ({ getLineCount: () => 3, getLineMaxColumn: () => 2 }),
    updateOptions: (options) => folding.push(options.folding),
    getTopForPosition: () => 20,
    getOption: () => 20,
    getLayoutInfo: () => ({ height: 200, horizontalScrollbarHeight: 0 }),
    setScrollTop: (top) => reveals.push(top), render() {},
    setPosition() { assert.fail('must not change cursor'); },
    changeViewZones(fn) { fn({ addZone(zone) { zones.set(1, zone); return 1; }, removeZone: (id) => zones.delete(id), layoutZone() {} }); },
    dispose() {},
  }) } };
  const thread = { id: 't', file: 'a', side: 'modified', line_range: { start: 1, end: 2 }, messages: [] };
  const view = await mountEditor({}, { content: 'a\nb\nc', threads: [thread], document });
  assert.equal(zones.get(1).afterLineNumber, 2);
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
    const zones = new Map();
    const positions = [];
    const observers = [];
    let nextId = 0;
    let scrollTop = 0;
    let anchorTop = 3980;
    let firstHeight = 300;
    let lineCount = 200;
    const document = { createElement: () => ({ children: [], setAttribute() {}, addEventListener() {},
      replaceChildren(...children) { this.children = children; },
    }) };
    class ResizeObserver {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
    const model = { getLineCount: () => lineCount, getLineMaxColumn(line) { assert.equal(line, 200); return 501; }, dispose() {} };
    const editor = {
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
        zones.set(++nextId, zone);
        zone.domNode.getBoundingClientRect = () => ({ top: anchorTop + 20 - scrollTop });
        const rail = zone.domNode.children[0];
        rail.getBoundingClientRect = () => ({ height: firstHeight + 700 });
        rail.children.forEach((article, index) => {
          article.getBoundingClientRect = () => ({ top: anchorTop + 28 - scrollTop + (index ? firstHeight : 0), height: index ? 700 : firstHeight });
        });
        return nextId;
      }, removeZone: (id) => zones.delete(id), layoutZone() {} }); },
    };
    globalThis.window = { monaco: true };
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
    observers.at(-1).callback();
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
    observers.at(-1).callback();
    assert.equal(view.revealThread('first'), false);
    assert.equal(positions.length, count);
    assert.ok(observers.every((observer) => observer.disconnected));
  }
});

test('same-anchor native deletion/alignment zones taller than the viewport cannot hide or shrink the chosen comment rail', async () => {
  for (const mode of ['file', 'inline', 'side-by-side']) {
    for (const nativeSide of ['original', 'modified']) {
      let scrollTop = 0;
      let ownZone;
      let visible = false;
      let ownTop = 0;
      let nativeOriginal = nativeSide === 'original' ? [{ heightInPx: 1200 }] : [];
      let nativeModified = nativeSide === 'modified' ? [{ heightInPx: 1000 }] : [];
      const observers = [];
      const rect = (offset, height) => visible ? { top: ownTop - scrollTop + offset, height } : { top: 0, height: 0 };
      const document = { createElement: () => ({ children: [], setAttribute() {}, addEventListener() {},
        replaceChildren(...children) { this.children = children; },
      }) };
      class ResizeObserver {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
      }
      // Monaco 0.45's lineAlignment omits ordinal/afterColumn. Sorting uses
      // ordinal ?? afterColumn ?? 10000, not creation order, on both panes.
      const ordinal = (zone) => zone.ordinal ?? zone.afterColumn ?? 10000;
      const model = { getLineCount: () => 200, getLineMaxColumn(line) { assert.equal(line, 200); return 501; }, dispose() {} };
      const editor = {
        getModel: () => model, updateOptions() {}, dispose() {},
        getTopForPosition(line, column) { assert.deepEqual([line, column], [200, 501]); return 3980; },
        getOption: () => 20,
        getLayoutInfo: () => ({ height: 400, horizontalScrollbarHeight: 0 }),
        getScrollTop: () => scrollTop,
        setScrollTop(top) { scrollTop = top; },
        revealRangeInCenter() { assert.fail('must not clamp or center the code range'); },
        render() {
          const ordered = [...nativeModified, ownZone].sort((a, b) => ordinal(a) - ordinal(b));
          ownTop = 4000 + ordered.slice(0, ordered.indexOf(ownZone)).reduce((sum, zone) => sum + zone.heightInPx, 0);
          visible = ownTop < scrollTop + 400 && ownTop + ownZone.heightInPx > scrollTop;
          ownZone.onDomNodeTop(visible ? ownTop - scrollTop : -1000000 - scrollTop);
        },
        changeViewZones(fn) { fn({ addZone(zone) {
          ownZone = zone;
          zone.domNode.getBoundingClientRect = () => rect(0, zone.heightInPx);
          const rail = zone.domNode.children[0];
          rail.getBoundingClientRect = () => rect(8, 800);
          rail.children[0].getBoundingClientRect = () => rect(8, 180);
          rail.children[1].getBoundingClientRect = () => rect(188, 620);
          return 'comments';
        }, removeZone() {}, layoutZone() {} }); },
      };
      globalThis.window = { monaco: true };
      globalThis.monaco = { editor: { EditorOption: { lineHeight: 1 }, create: () => editor, createModel: () => model,
        createDiffEditor: () => ({ setModel() {}, dispose() {}, getModifiedEditor: () => editor,
          onDidUpdateDiff: () => ({ dispose() {} }),
        }),
      } };
      const thread = { id: 'first', file: 'a', side: 'modified', line_range: { start: 1, end: 200 }, messages: [] };
      const options = { threads: [thread, { ...thread, id: 'second' }], document, ResizeObserver, wrap: true };
      const view = mode === 'file' ? await mountEditor({}, { ...options, content: 'wrapped EOF anchor' })
        : await mountDiffEditor({}, { ...options, mode, modified: 'wrapped EOF anchor' });
      editor.render();
      observers[0].callback(); // Native display:none produces zero DOM measurements.
      assert.equal(ownZone.heightInPx, 120, 'hidden rails retain their previous height');
      assert.equal(view.revealThread('second'), true);
      editor.render();
      assert.equal(scrollTop, 4180, 'selected shared-end conversation is before tall native whitespace');
      assert.equal(visible, true);
      assert.equal(ownZone.domNode.children[0].children[1].getBoundingClientRect().top, 8);
      assert.equal(ownZone.heightInPx, 816);
      assert.equal(ownZone.ordinal, -1, 'the public ordinal precedes native default 10000');
      // An asynchronous native diff recomputation replaces both pane's zones
      // after the comment mount. Their heights/content must remain intact.
      nativeOriginal = [{ heightInPx: 1500 }];
      nativeModified = [{ heightInPx: 2000 }];
      scrollTop = 0;
      editor.render();
      observers[0].callback();
      assert.equal(ownZone.heightInPx, 816);
      view.revealThread('first');
      editor.render();
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
    const positions = [];
    panes.modified.updateOptions = () => {};
    panes.modified.changeViewZones = (fn) => fn({ addZone: () => 1, removeZone() {}, layoutZone() {} });
    panes.modified.getModel = () => ({ getLineCount: () => 20, getLineMaxColumn: () => 5 });
    panes.modified.getTopForPosition = () => 160;
    panes.modified.getLayoutInfo = () => ({ height: 400, horizontalScrollbarHeight: 0 });
    panes.modified.render = () => {};
    panes.modified.getScrollTop = () => 100;
    panes.modified.getOption = () => 20;
    panes.modified.setScrollTop = (position) => positions.push(position);
    globalThis.monaco.editor.EditorOption = { lineHeight: 1 };
    const document = { createElement: () => ({ setAttribute() {}, addEventListener() {}, replaceChildren() {},
      getBoundingClientRect: () => ({ top: 0, height: 40 }),
    }) };
    const thread = { id: 't', side: 'modified', line_range: { start: 7, end: 9 }, messages: [] };
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
  for (const mode of DIFF_RENDER_MODES) {
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

test('disposing a pending auto-scroll mount releases its listener and ignores queued updates', async () => {
  let updated;
  let unsubscribed = 0;
  globalThis.window = { monaco: true };
  globalThis.monaco = { editor: {
    createDiffEditor: () => ({ setModel() {}, dispose() {},
      onDidUpdateDiff(listener) { updated = listener; return { dispose: () => unsubscribed++ }; },
      getLineChanges() { assert.fail('disposed editor must not navigate'); },
    }), createModel: () => ({ dispose() {} }),
  } };
  const view = await mountDiffEditor({}, { original: '', modified: 'new', autoScroll: true });
  view.dispose();
  assert.equal(unsubscribed, 1);
  updated();
  assert.equal(unsubscribed, 1);
});

test('the add-comment shortcut reads KeyMod and KeyCode from the top-level monaco namespace', async () => {
  const actions = [];
  const noop = () => ({ dispose() {} });
  globalThis.window = { monaco: true };
  globalThis.monaco = {
    KeyMod: { CtrlCmd: 1, Alt: 2 },
    KeyCode: { KeyM: 4 },
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 'glyph', GUTTER_LINE_NUMBERS: 'numbers' },
      create: () => ({
        updateOptions() {},
        onMouseMove: noop,
        onMouseLeave: noop,
        onMouseDown: noop,
        addAction: (action) => { actions.push(action); return { dispose() {} }; },
        changeViewZones() {},
        dispose() {},
      }),
    },
  };
  const composer = { draft: null, onChange() {}, save: async () => {} };
  const view = await mountEditor({}, { content: 'plain', composer });
  assert.deepEqual(actions.map((action) => [action.id, action.keybindings]), [['canopy.addComment', [7]]]);
  view.dispose();
});
