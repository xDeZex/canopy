// Client glue over Monaco's editor widgets — loaded from a CDN AMD build
// (see the classic <script> tag in index.html) per the README's
// no-build-step approach, same version validated in prototype/ui-layout's
// throwaway UI (variant D). Thin third-party wiring; deliberately not unit
// tested — see server/file-content.test.js and server/app.test.js for the
// seam that is tested (fetching a file's HEAD/working content). Monaco
// itself is left to manual/visual verification.

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

// Mounts a full-file inline diff: HEAD content vs on-disk content,
// highlighted inline over the whole file (README: "not a hunk-only diff"),
// via `renderSideBySide: false`. Returns a controller with `dispose()`.
export async function mountDiffEditor(container, { original, modified, language }) {
  await ensureLoader();

  const editor = monaco.editor.createDiffEditor(container, {
    automaticLayout: true,
    readOnly: true,
    renderSideBySide: false,
    originalEditable: false,
    theme: 'vs-dark',
  });

  const originalModel = monaco.editor.createModel(original ?? '', language);
  const modifiedModel = monaco.editor.createModel(modified ?? '', language);
  editor.setModel({ original: originalModel, modified: modifiedModel });

  return {
    dispose() {
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    },
  };
}

// Mounts a plain read-only full-file view (File mode). Returns a
// controller with `dispose()`.
export async function mountEditor(container, { content, language }) {
  await ensureLoader();

  const editor = monaco.editor.create(container, {
    value: content ?? '',
    language,
    automaticLayout: true,
    readOnly: true,
    theme: 'vs-dark',
  });

  return {
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
