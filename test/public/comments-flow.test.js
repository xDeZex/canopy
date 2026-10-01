import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentLoader } from '../../server/comment-loader.js';
import { createRequestHandler } from '../../server/handle-request.js';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { createViewModeStore } from '../../public/view-mode.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { createViewer } from '../../public/viewer.js';
import { mountDiffEditor } from '../../public/monaco-view.js';

// Manual version-1 fixture delivered through fake IO, not filesystem/network.
const yaml = `version: 1
threads:
  - id: demo-review
    file: public/app.js
    side: modified
    line_range: { start: 1, end: 2 }
    created_at: "2026-10-01T12:00:00Z"
    resolved: false
    messages:
      - id: agent-reply
        author: agent
        text: "<b>Literal text</b>"
        created_at: "2026-10-01T12:01:00Z"
      - id: user-question
        author: user
        text: "Please explain."
        created_at: "2026-10-01T12:00:00Z"
`;

test('manual YAML flows through registered route, isolated workspace state and the real modified-side zone adapter', async () => {
  const reads = [];
  const getComments = createCommentLoader({ realpath: async (path) => path,
    lstat: async (path) => ({ isSymbolicLink: () => false,
      isFile: () => /\.(yaml|js)$/.test(path), isDirectory: () => !/\.(yaml|js)$/.test(path) }),
    readFile: async (path) => { reads.push(path); return yaml; },
  });
  const handle = createRequestHandler({ getWorktrees: async () => [{ path: '/registered' }], getComments,
    getTree: async () => [{ type: 'file', path: 'public/app.js', status: 'modified' }],
    getContent: async () => ({ head: 'before', working: 'one\ntwo\nthree' }), getCommits: async () => [],
  });
  const element = () => ({ children: [], classList: { add() {}, toggle() {} },
    setAttribute() {}, replaceChildren(...children) { this.children = children; }, addEventListener() {},
  });
  const document = { createElement: element };
  const zones = [];
  const previousWindow = globalThis.window;
  const previousMonaco = globalThis.monaco;
  globalThis.window = { monaco: true };
  globalThis.monaco = { editor: {
    createDiffEditor: () => ({ setModel() {}, dispose() {}, onDidUpdateDiff: () => ({ dispose() {} }), getModifiedEditor: () => ({
      getModel: () => ({ getLineCount: () => 3 }),
      updateOptions() {},
      changeViewZones(fn) { fn({ addZone(zone) { zones.push(zone); return zones.length; }, removeZone() {} }); },
    }) }), createModel: () => ({ dispose() {} }),
  } };
  let viewer;
  const workspace = createWorkspaceStore({ viewModeStore: createViewModeStore({ getItem: () => 'diff' }),
    commitLock: createCommitLockStore(), onActivePathChanged() {},
    async fetch(url) {
      const parsed = new URL(url, 'http://canopy');
      const response = await handle({ method: 'GET', pathname: parsed.pathname, searchParams: parsed.searchParams });
      return { ok: response.status === 200, status: response.status, json: async () => JSON.parse(response.body) };
    },
    onChange(part) {
      if (['render', 'main'].includes(part)) viewer.render();
      if (part === 'comments') viewer.refreshComments();
    },
  });
  viewer = createViewer({ mainEl: element(), document, getState: workspace.getState,
    getViewMode: () => 'diff', getDiffRenderMode: () => 'inline', getWrap: () => true,
    getAutoScroll: () => false, languageForPath: () => 'javascript', mountDiffEditor,
  });
  try {
    workspace.updateWorktrees([{ path: '/registered' }]);
    await workspace.selectFile('public/app.js');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads, ['/registered/.canopy/comments.yaml']);
    assert.equal(workspace.getState().comments.threads[0].id, 'demo-review');
    assert.equal(zones.length, 1);
    assert.equal(zones[0].afterLineNumber, 2);
    const messages = zones[0].domNode.children[0].children[0].children[1].children;
    assert.equal(messages[0].children[1].textContent, 'Please explain.');
    assert.equal(messages[1].children[1].textContent, '<b>Literal text</b>');
  } finally {
    viewer.dispose();
    globalThis.window = previousWindow;
    globalThis.monaco = previousMonaco;
  }
});
