// Client glue over Monaco's editor widgets — loaded from a CDN AMD build
// (see the classic <script> tag in index.html) per the README's
// no-build-step approach, same version validated in prototype/ui-layout's
// throwaway UI (variant D). The mounted controller is tested with a Monaco
// stub; Monaco's rendering itself is left to manual/visual verification.
import { renderConversation, renderComposer, captureCommentFocus } from './comments-view.js';
import { composerTarget } from './comment-range.js';
import { hasFileAnchor } from './comment-dom.js';
import type { CommentThread } from './comment-dom.js';
import { errorMessage } from './editor-port.js';
import type { ViewerNode, ViewerDocument, EditorOptions, DiffOptions, Observer, ObserverFactory, Composer } from './editor-port.js';
import { codeEditor, required } from './monaco-port.js';
import type { CodeEditor, Disposable, LineChange, Decoration, MouseEvent, ZoneAccessor, ZoneId } from './monaco-port.js';

let loaderReady: Promise<void> | null = null;

function ensureLoader() {
  if (loaderReady) return loaderReady;
  loaderReady = new Promise((resolve, reject) => {
    if (window.monaco) {
      resolve();
      return;
    }
    if (!window.require) {
      reject(new Error('Monaco AMD loader (loader.js) not found on window.require'));
      return;
    }
    window.require.config({
      paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' },
    });
    window.require(['vs/editor/editor.main'], () => resolve(), reject);
  });
  return loaderReady;
}

// Diff render modes, each a native Monaco diff editor option (see #6):
// - inline: the original full-file default — one pane, edits highlighted
//   over the whole file (README: "not a hunk-only diff").
// - side-by-side: classic two-pane diff.
export const DIFF_RENDER_MODES = ['inline', 'side-by-side'] as const;

const DIFF_MODE_OPTIONS = {
  inline: { renderSideBySide: false, hideUnchangedRegions: { enabled: false } },
  'side-by-side': { renderSideBySide: true, hideUnchangedRegions: { enabled: false } },
};

const lineCount = (editor: CodeEditor) => editor.getModel().getLineCount();

// Shared public code-editor seam for File and the modified pane of Diff.
function createThreadZones<E extends ViewerNode<E>>(getEditor: () => CodeEditor, { contentAvailable = true, document, ResizeObserver, composer = null,
  conversation = (thread) => renderConversation(document, thread) }: { contentAvailable?: boolean; document: ViewerDocument<E>; ResizeObserver?: ObserverFactory<E>; composer?: Composer | null; conversation?: EditorOptions<E>['conversation'] }) {
  interface Entry { id: ZoneId; top: number | null; resize(): void; observer?: Observer<E> }
  let zones: Entry[] = [];
  let disposed = false;
  let snapshot: string | null = null;
  const threadsById = new Map<string, { thread: CommentThread & { line_range: { start: number; end: number } }; article: E; node: E; entry: Entry }>();
  const articlesById = new Map<string, E & { updateThread?(thread: CommentThread): void }>();
  let topology: string | null = null;
  let foldingDisabled = false;
  let composerEntry: { id: ZoneId; observer: Observer<E> | null } | null = null;
  let hoverDecorations: string[] = [];
  const subscriptions: Disposable[] = [];
  function closeComposer() {
    if (!composerEntry) return;
    const { id, observer } = composerEntry;
    composerEntry = null;
    observer?.disconnect();
    getEditor().changeViewZones((accessor) => accessor.removeZone(id));
  }
  // The gutter target and keyboard shortcut both open the same composer: a
  // native form in a view zone after the last chosen modified-side line. The
  // draft lives with the caller so remounts can restore it.
  function openComposer(line: number, endLine = line, text = '', error: string | null = null, focus = true) {
    if (disposed || !composer) return;
    const activeComposer = composer;
    const editor = getEditor();
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(endLine) || line < 1 || endLine < line ||
        endLine > lineCount(editor)) return;
    closeComposer();
    const view = renderComposer(document, { line, endLine, text, error,
      onInput: (next) => activeComposer.onChange({ line, endLine, text: next, error: null }),
      onCancel: () => { closeComposer(); activeComposer.onChange(null); },
      onSave: async (next) => {
        try {
          await activeComposer.save({ line, endLine, text: next });
        } catch (err) {
          activeComposer.onChange({ line, endLine, text: next, error: errorMessage(err) });
          throw err;
        }
        closeComposer();
        activeComposer.onChange(null);
      },
    });
    const node = document.createElement('div');
    node.className = 'review-zone';
    node.replaceChildren(view.node);
    node.addEventListener('mousedown', (event) => event.stopPropagation?.());
    node.addEventListener('keydown', (event) => event.stopPropagation?.());
    const entry: { id: ZoneId; observer: Observer<E> | null } = { id: '', observer: null };
    const zone = { afterLineNumber: endLine, ordinal: 0, domNode: node, heightInPx: 150, suppressMouseDown: false };
    editor.changeViewZones((accessor) => { entry.id = accessor.addZone(zone); });
    const resize = () => {
      if (disposed || composerEntry !== entry) return;
      const height = Math.ceil(view.node.getBoundingClientRect().height) + 16;
      if (height <= 16 || height === zone.heightInPx) return;
      zone.heightInPx = height;
      editor.changeViewZones((accessor) => required(accessor.layoutZone).call(accessor, entry.id));
    };
    if (ResizeObserver) {
      entry.observer = new ResizeObserver(resize);
      entry.observer.observe(view.node);
    }
    composerEntry = entry;
    setTimeout(() => {
      if (composerEntry !== entry) return;
      // Restoring a draft is not a new focus request: a retained reply or a
      // toolbar control may have regained focus while this mount completed.
      if (focus || !document.activeElement || document.activeElement === document.body) view.focus();
    }, 0);
  }
  if (composer && contentAvailable) {
    const editor = getEditor();
    const MouseTargetType = required(monaco.editor.MouseTargetType);
    const gutterLine = (event: MouseEvent) => [MouseTargetType.GUTTER_GLYPH_MARGIN, MouseTargetType.GUTTER_LINE_NUMBERS]
      .includes(event.target.type) ? event.target.position?.lineNumber ?? null : null;
    const showHover = (line: number | null) => {
      hoverDecorations = editor.deltaDecorations(hoverDecorations, line === null ? [] : [{
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { glyphMarginClassName: 'review-add-glyph', glyphMarginHoverMessage: { value: 'Add comment' } },
      }]);
    };
    editor.updateOptions({ glyphMargin: true });
    subscriptions.push(
      editor.onMouseMove((event) => showHover(gutterLine(event))),
      editor.onMouseLeave(() => showHover(null)),
      editor.onMouseDown((event) => {
        if (event.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
          // Only a click on a selected line adopts the selection, so another
          // line never silently becomes part of an unrelated range.
          const target = composerTarget(editor.getSelection(), lineCount(editor), event.target.position.lineNumber);
          if (target) openComposer(target.line, target.endLine);
        }
      }),
    );
    if (composer.draft) openComposer(composer.draft.line, composer.draft.endLine, composer.draft.text, composer.draft.error ?? null, false);
  }
  function clearZones(accessor: ZoneAccessor) {
    for (const zone of zones) {
      zone.observer?.disconnect();
      accessor.removeZone(zone.id);
    }
    zones = [];
    threadsById.clear();
  }
  // Opens the composer for the editor's current selection (the `c` shortcut).
  function addComment() {
    if (disposed || !composer || !contentAvailable) return;
    const editor = getEditor();
    const target = composerTarget(editor.getSelection(), lineCount(editor));
    if (target) openComposer(target.line, target.endLine);
  }
  return {
    addComment,
    updateThreads(threads: CommentThread[]) {
      if (disposed) return;
      const nextSnapshot = JSON.stringify(threads);
      if (nextSnapshot === snapshot || (!threads.length && snapshot === null)) return;
      snapshot = nextSnapshot;
      const editor = getEditor();
      // Public folding option prevents native manual folds from relocating a
      // conversation onto a fold boundary. No folding state or cursor access.
      const disableFolding = threads.length > 0;
      if (disableFolding !== foldingDisabled) {
        editor.updateOptions({ folding: !disableFolding });
        foldingDisabled = disableFolding;
      }
      const count = editor.getModel().getLineCount();
      const valid = threads.filter(hasFileAnchor).filter((thread) => {
        const { start, end } = thread.line_range;
        return contentAvailable && !thread.unavailable && thread.side === 'modified' &&
          Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start && end <= count;
      });
      const groups = new Map<number, typeof valid>();
      for (const thread of valid) {
        const end = thread.line_range.end;
        if (!groups.has(end)) groups.set(end, []);
        required(groups.get(end)).push(thread);
      }
      const nextTopology = JSON.stringify([...groups].map(([end, conversations]) => [end, conversations.map((thread) => thread.id)]));
      for (const thread of valid) {
        let article = articlesById.get(thread.id);
        if (!article) {
          article = conversation(thread);
          articlesById.set(thread.id, article);
        } else article.updateThread?.(thread);
        const target = threadsById.get(thread.id);
        if (target) target.thread = thread;
      }
      // History/resolution updates do not remove native view zones or forms.
      if (topology === nextTopology) return;
      topology = nextTopology;
      const restoreFocus = valid.map((thread) => captureCommentFocus(document, articlesById.get(thread.id))).find(Boolean);
      editor.changeViewZones((accessor) => {
        clearZones(accessor);
        for (const [end, conversations] of groups) {
          const node = document.createElement('div');
          node.className = 'review-zone';
          const rail = document.createElement('div');
          rail.className = 'review-zone__rail';
          const articles = conversations.map((thread) => required(articlesById.get(thread.id)));
          rail.replaceChildren(...articles);
          node.replaceChildren(rail);
          node.addEventListener('mousedown', (event) => event.stopPropagation?.());
          node.addEventListener('keydown', (event) => event.stopPropagation?.());
          const entry: Entry = { id: '', top: null, resize() {} };
          // Monaco 0.45's deletion/alignment zones default to ordinal 10000.
          // Sorting by ordinal puts this rail directly after the exact anchor,
          // even when native zones are replaced asynchronously (and at EOF).
          const zone = { afterLineNumber: end, ordinal: -1, domNode: node, heightInPx: 120, suppressMouseDown: false,
            onDomNodeTop(top: number) {
              if (disposed) return;
              const absoluteTop = top + editor.getScrollTop();
              entry.top = absoluteTop >= 0 ? absoluteTop : null;
            },
          };
          entry.id = accessor.addZone(zone);
          entry.resize = () => {
            if (disposed || !zones.includes(entry)) return;
            const measuredHeight = rail.getBoundingClientRect().height;
            // Offscreen native zones are display:none, not empty conversations.
            if (measuredHeight <= 0) return;
            const height = Math.ceil(measuredHeight) + 16;
            if (height === zone.heightInPx) return;
            zone.heightInPx = height;
            editor.changeViewZones((accessor) => required(accessor.layoutZone).call(accessor, entry.id));
          };
          zones.push(entry);
          conversations.forEach((thread, index) => threadsById.set(thread.id, { thread, article: articles[index], node, entry }));
          if (ResizeObserver) {
            entry.observer = new ResizeObserver(entry.resize);
            entry.observer.observe(rail);
          }
        }
      });
      restoreFocus?.();
    },
    revealThread(id: string) {
      const target = threadsById.get(id);
      if (disposed || !target) return false;
      const editor = getEditor();
      const { thread, article, node, entry } = target;
      const end = thread.line_range.end;
      // Monaco 0.45's bottom-for-line query uses column 1, so it stops at the
      // first wrapped segment. The last column plus line height reaches the
      // exact zone boundary, also at EOF, without including following zones.
      const model = editor.getModel();
      const anchorTop = editor.getTopForPosition(end, required(model.getLineMaxColumn).call(model, end));
      const anchorBottom = anchorTop + editor.getOption(required(monaco.editor.EditorOption).lineHeight);
      // Offscreen native zones are display:none. First expose this zone, then
      // force public rendering before measuring the chosen article, not the
      // whole (possibly enormous) code range or the first shared-end thread.
      editor.setScrollTop(anchorBottom);
      editor.render();
      entry.resize();
      editor.render();
      const bounds = article.getBoundingClientRect();
      const articleTop = (entry.top ?? anchorBottom) + bounds.top - node.getBoundingClientRect().top;
      const layout = editor.getLayoutInfo();
      const viewport = layout.height - layout.horizontalScrollbarHeight;
      const contextFits = articleTop + bounds.height - anchorTop <= viewport - 16;
      editor.setScrollTop(Math.max(0, (contextFits ? anchorTop : articleTop) - 8));
      return true;
    },
    dispose() {
      closeComposer();
      disposed = true;
      subscriptions.forEach((subscription) => subscription?.dispose?.());
      threadsById.clear();
      articlesById.clear();
      if (zones.length) getEditor().changeViewZones(clearZones);
    },
  };
}

// Mounts a full-file diff: HEAD content vs on-disk content. `mode` selects
// the rendering (see DIFF_RENDER_MODES above); defaults or falls back to
// 'inline'. With `autoScroll`, the viewport moves to the first change once
// Monaco has computed the diff (#24).
// Returns a controller with disposal, hunk navigation, and viewport scrolling.
type NativeDiffOptions = Omit<DiffOptions<HTMLElement>, 'document'> & { document?: undefined };
export function mountDiffEditor<E extends ViewerNode<E>>(container: E, options: DiffOptions<E>): ReturnType<typeof mountDiffWithDocument>;
export function mountDiffEditor(container: HTMLElement, options: NativeDiffOptions): ReturnType<typeof mountDiffWithDocument>;
export async function mountDiffEditor<E extends ViewerNode<E>>(container: unknown, options: DiffOptions<E> | NativeDiffOptions) {
  return options.document
    ? mountDiffWithDocument(container, options)
    : mountDiffWithDocument(container, { ...options, document: globalThis.document });
}

function nativeObserver<E>(): ObserverFactory<E> | undefined {
  if (!globalThis.ResizeObserver) return undefined;
  return class {
    private observer: ResizeObserver;
    constructor(callback: () => void) { this.observer = new globalThis.ResizeObserver(callback); }
    observe(node: E) { if (!(node instanceof Element)) throw new Error('ResizeObserver requires a native element'); this.observer.observe(node); }
    disconnect() { this.observer.disconnect(); }
  };
}

async function mountDiffWithDocument<E extends ViewerNode<E>>(container: unknown, { original, modified, language, mode = 'inline', autoScroll = false, wrap = false,
  threads = [], composer = null, conversation, document, ResizeObserver = nativeObserver<E>() }: DiffOptions<E>) {
  await ensureLoader();

  const editor = required(monaco.editor.createDiffEditor).call(monaco.editor, container, {
    automaticLayout: true,
    readOnly: true,
    // Sets the DOM readonly attribute on Monaco's input so keyboard shortcuts
    // can tell it is not being typed into.
    domReadOnly: true,
    originalEditable: false,
    theme: 'vs-dark',
    diffWordWrap: wrap ? 'on' : 'off',
    // Detects relocated blocks and draws a connecting arrow between the old
    // and new spot instead of an unrelated delete+add pair. Cheap (a native
    // option) and orthogonal to `mode`, so it's always on rather than a
    // separate toggle position (#6).
    experimental: { showMoves: true },
    ...DIFF_MODE_OPTIONS[mode === 'side-by-side' ? mode : 'inline'],
  });

  const originalModel = required(monaco.editor.createModel).call(monaco.editor, original ?? '', language);
  const modifiedModel = required(monaco.editor.createModel).call(monaco.editor, modified ?? '', language);
  editor.setModel({ original: originalModel, modified: modifiedModel });
  let disposed = false;
  const modifiedEditor = () => codeEditor(required(editor.getModifiedEditor).call(editor));
  const originalEditor = () => codeEditor(required(editor.getOriginalEditor).call(editor));
  const threadZones = createThreadZones(modifiedEditor, {
    contentAvailable: modified !== null, document, ResizeObserver, composer, conversation,
  });
  threadZones.updateThreads(threads);

  // Monaco may still be computing the diff immediately after setModel().
  // Start at the first/last hunk and keep navigation local to this mount;
  // each call reads fresh hunks so a recomputed diff cannot leave a stale index.
  let currentLine: number | null = null;
  let currentChange: LineChange | null = null;
  let originalMarkers: string[] = [];
  let modifiedMarkers: string[] = [];
  function clearMarkers() {
    originalMarkers = originalEditor().deltaDecorations(originalMarkers, []);
    modifiedMarkers = modifiedEditor().deltaDecorations(modifiedMarkers, []);
  }
  function markChange(change: LineChange, target: number) {
    const decoration = (start: number, end: number): Decoration[] => [{
      range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
      options: { isWholeLine: true, linesDecorationsClassName: 'current-hunk-marker' },
    }];
    originalMarkers = originalEditor().deltaDecorations(originalMarkers,
      change.originalEndLineNumber !== undefined && change.originalEndLineNumber > 0
        ? decoration(required(change.originalStartLineNumber), change.originalEndLineNumber) : []);
    modifiedMarkers = modifiedEditor().deltaDecorations(modifiedMarkers,
      decoration(target, change.modifiedEndLineNumber !== undefined && change.modifiedEndLineNumber > 0 ? change.modifiedEndLineNumber : target));
  }
  function navigate(direction: number) {
    const changes = required(editor.getLineChanges).call(editor);
    if (!changes?.length) {
      currentLine = null;
      currentChange = null;
      clearMarkers();
      return;
    }

    const pane = modifiedEditor();
    const lastLine = pane.getModel().getLineCount();
    const lines = changes.map((change) => Math.min(lastLine, Math.max(1, change.modifiedStartLineNumber)));
    const currentIndex = currentChange === null ? -1 : changes.findIndex((change) =>
      change.originalStartLineNumber === currentChange?.originalStartLineNumber
      && change.originalEndLineNumber === currentChange?.originalEndLineNumber
      && change.modifiedStartLineNumber === currentChange?.modifiedStartLineNumber
      && change.modifiedEndLineNumber === currentChange?.modifiedEndLineNumber);
    let candidate = -1;
    if (currentIndex !== -1) {
      candidate = (currentIndex + direction + changes.length) % changes.length;
    } else if (currentLine !== null) {
      const lineBeforeNavigation = currentLine;
      candidate = direction === 1
        ? lines.findIndex((line) => line > lineBeforeNavigation)
        : lines.findLastIndex((line) => line < lineBeforeNavigation);
    }
    const index = candidate === -1 ? (direction === 1 ? 0 : lines.length - 1) : candidate;
    const target = lines[index];
    currentLine = target;
    currentChange = changes[index];
    markChange(changes[index], target);
    pane.revealLineInCenter(target);
    placeCursor(pane, target);
  }

  let pendingAutoScroll = autoScroll;
  const diffUpdated = editor.onDidUpdateDiff(() => {
    if (disposed) return;
    clearMarkers();
    currentLine = null;
    currentChange = null;
    if (pendingAutoScroll) {
      pendingAutoScroll = false;
      navigate(1);
    }
  });

  return {
    updateThreads: threadZones.updateThreads,
    addComment: threadZones.addComment,
    revealThread(id: string) {
      if (!threadZones.revealThread(id)) return false;
      pendingAutoScroll = false;
      return true;
    },
    nextChange() { navigate(1); },
    prevChange() { navigate(-1); },
    scrollUp() { scrollWithCursor(modifiedEditor(), -1); },
    scrollDown() { scrollWithCursor(modifiedEditor(), 1); },
    dispose() {
      disposed = true;
      diffUpdated.dispose();
      threadZones.dispose();
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    },
  };
}

const SCROLL_LINES = 10;

export function clampLine(lineNumber: number, lineCount: number) {
  return Math.min(lineCount, Math.max(1, lineNumber));
}

// Puts the cursor at the start of a line. Monaco only draws the cursor in a
// focused editor, so this focuses it too.
function placeCursor(editor: CodeEditor, lineNumber: number) {
  editor.setPosition({ lineNumber, column: 1 });
  editor.focus();
}

// Moves the cursor by ten lines (clamped to the file) and scrolls the viewport
// by the vertical distance the cursor travelled, so the cursor keeps its place
// on screen. Measuring in pixels rather than lines keeps them in sync over
// soft-wrapped lines and at the ends of the file.
function scrollWithCursor(editor: CodeEditor, direction: number) {
  const from = required(editor.getPosition()).lineNumber;
  const to = clampLine(from + direction * SCROLL_LINES, editor.getModel().getLineCount());
  const distance = editor.getTopForLineNumber(to, true) - editor.getTopForLineNumber(from, true);
  editor.setScrollTop(editor.getScrollTop() + distance);
  placeCursor(editor, to);
}

// Mounts a plain read-only full-file view (File mode). Returns a
// controller with `dispose()`, `scrollUp()` and `scrollDown()`; no hunks to navigate.
type NativeEditorOptions = Omit<EditorOptions<HTMLElement>, 'document'> & { document?: undefined };
export function mountEditor<E extends ViewerNode<E>>(container: E, options: EditorOptions<E>): ReturnType<typeof mountWithDocument>;
export function mountEditor(container: HTMLElement, options: NativeEditorOptions): ReturnType<typeof mountWithDocument>;
export async function mountEditor<E extends ViewerNode<E>>(container: unknown, options: EditorOptions<E> | NativeEditorOptions) {
  return options.document
    ? mountWithDocument(container, options)
    : mountWithDocument(container, { ...options, document: globalThis.document });
}

async function mountWithDocument<E extends ViewerNode<E>>(container: unknown, { content, language, wrap = false, threads = [], composer = null,
  conversation, document, ResizeObserver = nativeObserver<E>() }: EditorOptions<E>) {
  await ensureLoader();

  const editor = codeEditor(required(monaco.editor.create).call(monaco.editor, container, {
    value: content ?? '',
    language,
    automaticLayout: true,
    readOnly: true,
    domReadOnly: true,
    theme: 'vs-dark',
    wordWrap: wrap ? 'on' : 'off',
  }));

  const threadZones = createThreadZones(() => editor, { contentAvailable: content !== null, document, ResizeObserver, composer, conversation });
  threadZones.updateThreads(threads);
  return {
    updateThreads: threadZones.updateThreads,
    addComment: threadZones.addComment,
    revealThread: threadZones.revealThread,
    scrollUp() { scrollWithCursor(editor, -1); },
    scrollDown() { scrollWithCursor(editor, 1); },
    dispose() {
      threadZones.dispose();
      editor.dispose();
    },
  };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
};

export function languageForPath(filePath: string) {
  const ext = filePath.split('.').pop();
  return LANGUAGE_BY_EXTENSION[ext ?? ''] ?? 'plaintext';
}
