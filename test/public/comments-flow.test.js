import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentLoader } from '../../server/comment-loader.js';
import { createCommentStore } from '../../server/comment-store.js';
import { parseComments } from '../../server/comments.js';
import { createRequestHandler } from '../../server/handle-request.js';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { createViewModeStore } from '../../public/view-mode.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { createViewer } from '../../public/viewer.js';
import { mountDiffEditor } from '../../public/monaco-view.js';
import { renderCommentIndex } from '../../public/comments-view.js';

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
  - id: unrelated-general
    created_at: "2026-10-01T13:00:00Z"
    resolved: false
    messages:
      - id: general-question
        author: user
        text: "Is this resolved?"
        created_at: "2026-10-01T13:00:00Z"
`;

test('manual YAML flows through registered route, isolated workspace state and the real modified-side zone adapter', async () => {
  const reads = [];
  let source = yaml;
  const temps = new Map();
  const io = { realpath: async (path) => path,
    lstat: async (path) => ({ isSymbolicLink: () => false,
      isFile: () => /\.(yaml|js)$/.test(path), isDirectory: () => !/\.(yaml|js)$/.test(path) }),
    readFile: async (path) => { reads.push(path); return source; },
    mkdir: async () => {}, writeExclusive: async (path, text) => { temps.set(path, text); },
    rename: async (from) => { source = temps.get(from); temps.delete(from); }, rm: async (path) => { temps.delete(path); },
  };
  const getComments = createCommentLoader(io);
  const store = createCommentStore({ io, newId: () => 'fixture-temp', now: () => { throw new Error('Resolution must not create timestamps'); } });
  const handle = createRequestHandler({ getWorktrees: async () => [{ path: '/registered' }], getComments, createComment: store.create,
    getTree: async () => [{ type: 'file', path: 'public/app.js', status: 'modified' }],
    getContent: async () => ({ head: 'before', working: 'one\ntwo\nthree' }), getCommits: async () => [],
  });
  const element = (tag) => ({ tag, children: [], events: {}, classList: { add() {}, toggle() {} },
    setAttribute(name, value) { this[name] = value; }, replaceChildren(...children) { this.children = children; },
    addEventListener(name, fn) { this.events[name] = fn; },
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
    async fetch(url, options) {
      const parsed = new URL(url, 'http://canopy');
      const response = await handle({ method: options?.method ?? 'GET', pathname: parsed.pathname, searchParams: parsed.searchParams,
        headers: { host: 'canopy', ...Object.fromEntries(Object.entries(options?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])) }, body: options?.body });
      return { ok: response.status < 400, status: response.status, json: async () => JSON.parse(response.body) };
    },
    onChange(part) {
      if (['render', 'main'].includes(part)) viewer.render();
      if (part === 'comments') viewer.refreshComments();
      if (part === 'comments-refresh') viewer.refreshComments({ reveal: false });
    },
  });
  viewer = createViewer({ mainEl: element(), document, getState: workspace.getState,
    getViewMode: () => 'diff', getDiffRenderMode: () => 'inline', getWrap: () => true,
    getAutoScroll: () => false, languageForPath: () => 'javascript', mountDiffEditor,
    setThreadResolved: (input) => workspace.setThreadResolved(input), addReply: async () => {},
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
    const article = zones[0].domNode.children[0].children[0];
    const find = (node, tag) => [...(node.tag === tag ? [node] : []), ...node.children.flatMap((child) => find(child, tag))];
    const toggle = find(article, 'button').find((button) => button.textContent === 'Resolve');
    assert.ok(toggle, 'the mounted shared conversation exposes Resolve');
    const before = parseComments(source).threads;
    find(article, 'button')[0].events.click();
    const textarea = find(article, 'textarea')[0];
    textarea.value = 'Keep this reply draft';
    await toggle.events.click();
    await workspace.loadComments();
    assert.deepEqual(parseComments(source).threads, [{ ...before[0], resolved: true }, before[1]]);
    assert.equal(workspace.getState().comments.threads[0].resolved, true);
    assert.match(article.className, /--resolved/);
    assert.equal(toggle.textContent, 'Reopen');
    const index = renderCommentIndex(document, workspace.getState().comments, {});
    assert.match(index.children[1].className, /--resolved/);
    await toggle.events.click();
    await workspace.loadComments();
    assert.deepEqual(parseComments(source).threads, before);
    assert.equal(workspace.getState().comments.threads[0].resolved, false);
    // An external agent appends a response and explicitly resolves in one edit.
    source = JSON.stringify({ version: 1, threads: [{ ...before[0], resolved: true, messages: [...before[0].messages,
      { id: 'incoming', author: 'agent', text: 'Fixed <b>literally</b>', created_at: '2026-10-02T09:00:00Z' }] }, before[1]] });
    // Save before observing that edit: conflict must refresh before enabling retry.
    await toggle.events.click();
    assert.match(find(article, 'p').at(-1).textContent, /Comments changed/);
    assert.equal(toggle.textContent, 'Retry resolve');
    assert.equal(find(article, 'textarea')[0], textarea);
    assert.equal(textarea.value, 'Keep this reply draft');
    assert.deepEqual(workspace.getState().comments.threads[0].messages.map((message) => message.id), ['user-question', 'agent-reply', 'incoming']);
    await toggle.events.click();
    await workspace.loadComments();
    assert.equal(toggle.textContent, 'Reopen');
    assert.equal(workspace.getState().comments.threads[1].resolved, false, 'prose never implicitly resolves');
    source = JSON.stringify({ version: 1, threads: parseComments(source).threads.map((thread) => ({ ...thread, resolved: false })) });
    workspace.remoteChange(['.canopy/comments.yaml']);
    await workspace.loadComments();
    assert.equal(toggle.textContent, 'Resolve', 'watch refresh respects the explicit agent flag');
  } finally {
    viewer.dispose();
    globalThis.window = previousWindow;
    globalThis.monaco = previousMonaco;
  }
});
