// Client glue over Monaco's editor widgets — loaded from a CDN AMD build
// (see the classic <script> tag in index.html) per the README's
// no-build-step approach, same version validated in prototype/ui-layout's
// throwaway UI (variant D). The mounted controller is tested with a Monaco
// stub; Monaco's rendering itself is left to manual/visual verification.

let loaderReady = null;

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
// - collapsed: inline, but unchanged regions are folded (expandable),
//   which is a hunk-*focused* view rather than a hunk-*only* one — full
//   context is still one click away, unlike the hunk-only view the README
//   rules out.
export const DIFF_RENDER_MODES = ['inline', 'side-by-side', 'collapsed'];

const DIFF_MODE_OPTIONS = {
  inline: { renderSideBySide: false, hideUnchangedRegions: { enabled: false } },
  'side-by-side': { renderSideBySide: true, hideUnchangedRegions: { enabled: false } },
  collapsed: { renderSideBySide: false, hideUnchangedRegions: { enabled: true } },
};

// Mounts a full-file diff: HEAD content vs on-disk content. `mode` selects
// the rendering (see DIFF_RENDER_MODES above); defaults to 'inline'. With
// `autoScroll`, the viewport moves to the first change once Monaco has
// computed the diff (#24).
// Returns a controller with disposal, hunk navigation, and viewport scrolling.
export async function mountDiffEditor(container, { original, modified, language, mode = 'inline', autoScroll = false, wrap = false }) {
  await ensureLoader();

  const editor = monaco.editor.createDiffEditor(container, {
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
    // fourth toggle position (#6).
    experimental: { showMoves: true },
    ...DIFF_MODE_OPTIONS[mode],
  });

  const originalModel = monaco.editor.createModel(original ?? '', language);
  const modifiedModel = monaco.editor.createModel(modified ?? '', language);
  editor.setModel({ original: originalModel, modified: modifiedModel });

  // Monaco may still be computing the diff immediately after setModel().
  // Start at the first/last hunk and keep navigation local to this mount;
  // each call reads fresh hunks so a recomputed diff cannot leave a stale index.
  let currentLine = null;
  function navigate(direction) {
    const changes = editor.getLineChanges();
    if (!changes?.length) {
      currentLine = null;
      return;
    }

    const modifiedEditor = editor.getModifiedEditor();
    const lastLine = modifiedEditor.getModel().getLineCount();
    const lines = changes.map((change) => Math.min(lastLine, Math.max(1, change.modifiedStartLineNumber)));
    let candidate = -1;
    if (currentLine !== null) {
      candidate = direction === 1
        ? lines.findIndex((line) => line > currentLine)
        : lines.findLastIndex((line) => line < currentLine);
    }
    const target = lines[candidate === -1 ? (direction === 1 ? 0 : lines.length - 1) : candidate];
    currentLine = target;
    modifiedEditor.revealLineInCenter(target);
  }

  if (autoScroll) {
    const diffUpdated = editor.onDidUpdateDiff(() => {
      diffUpdated.dispose();
      navigate(1);
    });
  }

  return {
    nextChange() { navigate(1); },
    prevChange() { navigate(-1); },
    scrollUp() { scroll(editor.getModifiedEditor(), -1); },
    scrollDown() { scroll(editor.getModifiedEditor(), 1); },
    dispose() {
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    },
  };
}

function scroll(editor, direction) {
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  editor.setScrollTop(editor.getScrollTop() + direction * 10 * lineHeight);
}

// Mounts a plain read-only full-file view (File mode). Returns a
// controller with `dispose()`, `scrollUp()` and `scrollDown()`; no hunks to navigate.
export async function mountEditor(container, { content, language, wrap = false }) {
  await ensureLoader();

  const editor = monaco.editor.create(container, {
    value: content ?? '',
    language,
    automaticLayout: true,
    readOnly: true,
    domReadOnly: true,
    theme: 'vs-dark',
    wordWrap: wrap ? 'on' : 'off',
  });

  return {
    scrollUp() { scroll(editor, -1); },
    scrollDown() { scroll(editor, 1); },
    dispose() {
      editor.dispose();
    },
  };
}

const LANGUAGE_BY_EXTENSION = {
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

export function languageForPath(filePath) {
  const ext = filePath.split('.').pop();
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext';
}
