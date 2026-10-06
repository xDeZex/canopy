import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewer } from '../../public/viewer.js';
import { mountEditor, mountDiffEditor } from '../../public/monaco-view.js';
import { createWorkspaceStore } from '../../public/workspace-state.js';
import { isRecord } from '../../public/workspace-contracts.js';
import { createViewModeStore } from '../../public/view-mode.js';
import { createCommitLockStore } from '../../public/commit-lock.js';
import { captureCommentFocus } from '../../public/comments-view.js';
import type { ViewerState, ViewerOptions, ReplyInput, ResolutionInput } from '../../public/viewer.js';
import type { CodeEditor } from '../../public/monaco-port.js';
import { Element, FakeDocument } from './fake-dom.js';
import { setLoaderWindow, fakeZone, present } from './monaco-fake.js';
import type { FakeZone } from './monaco-fake.js';
import type { CommentThread } from '../../public/comment-dom.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const find = (node: Element, tag: string): Element[] => [...(node.tag === tag ? [node] : []), ...node.children.flatMap((child) => find(child, tag))];
const thread = (patch: Partial<CommentThread> = {}): CommentThread => ({ id: 't', file: 'a.js', side: 'modified', line_range: { start: 1, end: 2 },
  resolved: true, created_at: '2026-10-01T12:00:00Z', messages: [
    { id: 'm', author: 'agent', created_at: '2026-10-01T12:01:00Z', text: 'Resolved <b>literally</b>' },
  ], ...patch });

// Only the DOM ownership/focus operations used by these adapters. Moving a
// connected subtree blurs its focused descendant; detached nodes cannot focus.
function createDocument() {
  const document = new FakeDocument({ top: 0, height: 50 }, true);
  document.activeElement = document.body;
  return document;
}

function fixture(mode: string, { addReply, addComment, setThreadResolved }: Pick<ViewerOptions<Element>, 'addReply' | 'addComment' | 'setThreadResolved'> = {}) {
  const document = createDocument();
  const zones = new Map<string | number, FakeZone>();
  let nextId = 0;
  let adds = 0;
  const createEditor = (container: unknown): Partial<CodeEditor> => {
    assert.ok(container instanceof Element);
    return { getModel: () => ({ getLineCount: () => 3 }), updateOptions() {}, dispose() {},
    getSelection: () => ({ startLineNumber: 2, endLineNumber: 2 }), deltaDecorations: () => [],
    onMouseMove: () => ({ dispose() {} }), onMouseLeave: () => ({ dispose() {} }), onMouseDown: () => ({ dispose() {} }),
    changeViewZones(fn) { fn({ addZone(zone) { fakeZone(zone); container.appendChild(zone.domNode); zones.set(++nextId, zone); adds++; return nextId; },
      removeZone(id) {
        zones.get(id)?.domNode.remove();
        zones.delete(id);
      }, layoutZone() {} }); },
  }; };
  setLoaderWindow({ monaco: true });
  globalThis.monaco = { editor: { MouseTargetType: {}, create: createEditor, createModel: () => ({ dispose() {} }),
    createDiffEditor: (container) => {
      const editor = createEditor(container);
      return { setModel() {}, dispose() {}, getModifiedEditor: () => editor, onDidUpdateDiff: () => ({ dispose() {} }) };
    },
  } };
  let state: ViewerState = { worktrees: [], activePath: '/repo', activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { head: 'before', working: 'one\ntwo\nthree' }, comments: { threads: [thread()], warning: null, revision: 'r1' } };
  const saves: ReplyInput[] = [];
  const mainEl = document.createElement('main');
  document.body.appendChild(mainEl);
  const viewer = createViewer({ mainEl, document, getState: () => state,
    getViewMode: () => mode === 'file' ? 'file' : 'diff', getDiffRenderMode: () => mode,
    mountEditor, mountDiffEditor, languageForPath: () => 'javascript', getAutoScroll: () => false, getWrap: () => false,
    addReply: async (input) => { saves.push(input); await addReply?.(input); },
    addComment,
    setThreadResolved,
  });
  return { viewer, mainEl, zones, document, saves, get adds() { return adds; },
    setState(patch: Partial<ViewerState>) { state = { ...state, ...patch }; },
    article: () => find(mainEl, 'article')[0],
  };
}

test('resolution stays available in every diff mode and general/unavailable views while retaining focused reply drafts', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  try {
    for (const mode of ['file', 'inline', 'side-by-side']) {
      const saves: ResolutionInput[] = [];
      const f = fixture(mode, { setThreadResolved: async (input) => { saves.push(input); } });
      try {
        f.viewer.render();
        await tick();
        const article = f.article();
        find(article, 'button')[0].events.click();
        const textarea = find(article, 'textarea')[0];
        textarea.value = 'Is this resolved?';
        textarea.setSelectionRange(1, 4, 'backward');
        const toggle = find(article, 'button').find((button) => button.textContent === 'Reopen');
        await present(toggle).events.click();
        assert.deepEqual(saves, [{ threadId: 't', resolved: false, worktree: '/repo' }]);
        f.setState({ comments: { threads: [thread({ resolved: false })], revision: 'r2' } });
        f.viewer.refreshComments({ reveal: false });
        f.viewer.render();
        await tick();
        assert.equal(f.article(), article);
        assert.equal(present(toggle).textContent, 'Resolve');
        assert.equal(f.document.activeElement, textarea);
        assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [1, 4, 'backward']);
        const { file, side, line_range, ...general } = thread({ resolved: false });
        f.setState({ mainView: 'general', comments: { threads: [general], revision: 'r3' } });
        f.viewer.refreshComments({ reveal: false });
        await present(toggle).events.click();
        assert.equal(f.article(), article);
        f.setState({ mainView: 'file', selectedThreadId: 't', comments: { threads: [thread({ resolved: false, unavailable: 'missing' })], revision: 'r4' } });
        f.viewer.refreshComments({ reveal: false });
        await present(toggle).events.click();
        assert.equal(f.article(), article);
        assert.equal(textarea.value, 'Is this resolved?');
        assert.deepEqual(saves.slice(1), [
          { threadId: 't', resolved: true, worktree: '/repo' }, { threadId: 't', resolved: true, worktree: '/repo' },
        ]);
        f.setState({ activePath: '/other', comments: { threads: [], revision: 'absent' } });
        f.viewer.render();
        await present(toggle).events.click();
        assert.equal(saves.length, 3, 'detached controls cannot cross-save into another worktree');
        assert.match(present(find(article, 'p').at(-1)).textContent, /worktree changed/);
      } finally { f.viewer.dispose(); }
    }
  } finally { setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});

test('viewer blocks retained reply and resolution forms until comments have a valid revision and no warning', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  const resolutions: ResolutionInput[] = [];
  const f = fixture('file', { setThreadResolved: async (input) => { resolutions.push(input); } });
  try {
    f.viewer.render();
    await tick();
    const article = f.article();
    find(article, 'button')[0].events.click();
    const textarea = find(article, 'textarea')[0];
    textarea.value = 'retained while blocked';
    const form = find(article, 'form')[0];
    const save = find(form, 'button')[0];
    const toggle = present(find(article, 'button').find((button) => button.textContent === 'Reopen'));
    for (const comments of [
      { threads: [thread()] },
      { threads: [thread()], revision: 'r2', warning: 'invalid YAML' },
    ]) {
      f.setState({ comments });
      f.viewer.refreshComments({ reveal: false });
      assert.equal(find(article, 'textarea')[0], textarea);
      assert.equal(save.disabled, true);
      assert.equal(toggle.disabled, true);
      assert.match(find(form, 'p')[0].textContent, /loading|invalid YAML/);
      await form.events.submit({ preventDefault() {} });
      await toggle.events.click();
      assert.deepEqual(f.saves, []);
      assert.deepEqual(resolutions, []);
    }
    f.setState({ comments: { threads: [thread()], revision: 'r3', warning: null } });
    f.viewer.refreshComments({ reveal: false });
    assert.equal(save.disabled, false);
    assert.equal(toggle.disabled, false);
    assert.equal(textarea.value, 'retained while blocked');
    await form.events.submit({ preventDefault() {} });
    await toggle.events.click();
    assert.deepEqual(f.saves, [{ threadId: 't', text: 'retained while blocked', worktree: '/repo' }]);
    assert.deepEqual(resolutions, [{ threadId: 't', resolved: false, worktree: '/repo' }]);
  } finally { f.viewer.dispose(); setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});

test('real viewer/Monaco seam preserves reply typing, selection and focus through live history and remounts in every mode', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  try {
    for (const mode of ['file', 'inline', 'side-by-side']) {
      const f = fixture(mode);
      f.viewer.render();
      await tick();
      const article = f.article();
      find(article, 'button')[0].events.click();
      const textarea = find(article, 'textarea')[0];
      textarea.value = 'my draft';
      textarea.events.input();
      textarea.setSelectionRange(2, 5, 'backward');
      const adds = f.adds;
      f.setState({ comments: { threads: [thread({ messages: [...thread().messages,
        { id: 'incoming', author: 'agent', text: '<img>incoming', created_at: '2026-10-02T09:00:00Z' }] })], revision: 'r2' } });
      f.viewer.refreshComments({ reveal: false });
      assert.equal(f.article(), article);
      assert.equal(f.adds, adds, 'history refresh does not rebuild native zones');
      assert.equal(f.document.activeElement, textarea);
      f.viewer.render();
      f.viewer.render(); // Another live update supersedes the pending mount.
      await tick();
      assert.equal(f.article(), article);
      assert.equal(find(article, 'textarea')[0], textarea);
      assert.equal(textarea.value, 'my draft');
      assert.equal(f.document.activeElement, textarea);
      assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [2, 5, 'backward']);
      const elsewhere = f.document.createElement('button');
      f.document.body.appendChild(elsewhere);
      elsewhere.focus();
      f.viewer.render();
      await tick();
      assert.equal(f.document.activeElement, elsewhere, 'an unfocused draft never steals focus');
      await find(article, 'form')[0].events.submit({ preventDefault() {} });
      assert.deepEqual(f.saves, [{ threadId: 't', text: 'my draft', worktree: '/repo' }]);
      assert.equal(find(article, 'textarea').length, 0);
      f.viewer.dispose();
    }
  } finally { setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});

test('focus capture skips detached inputs and DOM reparenting has one owner and blurs focused descendants', () => {
  const document = createDocument();
  const first = document.createElement('section');
  const second = document.createElement('section');
  document.body.replaceChildren(first, second);
  const textarea = document.createElement('textarea');
  first.appendChild(textarea);
  textarea.focus();
  const restore = captureCommentFocus(document, first);
  assert.ok(restore);
  first.remove();
  assert.equal(textarea.isConnected, false);
  assert.equal(document.activeElement, document.body);
  restore();
  assert.equal(textarea.focusCalls, 1, 'the disconnected guard avoids even attempting focus');
  document.body.appendChild(first);
  restore();
  assert.equal(document.activeElement, textarea);
  second.appendChild(textarea);
  assert.equal(textarea.parentNode, second);
  assert.deepEqual(first.children, []);
  assert.equal(textarea.isConnected, true);
  assert.equal(document.activeElement, document.body, 'moving a connected focused subtree blurs it');
});

test('topology refresh reparents retained reply DOM and restores selection, but never focuses removed conversations', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  try {
    for (const mode of ['file', 'inline', 'side-by-side']) {
      const f = fixture(mode);
      try {
        f.viewer.render();
        await tick();
        const article = f.article();
        const oldRail = article.parentNode;
        find(article, 'button')[0].events.click();
        const textarea = find(article, 'textarea')[0];
        textarea.value = 'retained draft';
        textarea.setSelectionRange(1, 4, 'backward');
        const focuses = textarea.focusCalls;
        f.setState({ comments: { threads: [thread(), thread({ id: 'neighbor', line_range: { start: 1, end: 1 } })], revision: 'r2' } });
        f.viewer.refreshComments({ reveal: false });
        assert.equal(f.article(), article);
        assert.notEqual(article.parentNode, oldRail);
        assert.equal(present(oldRail).contains(article), false, 'reparented article no longer belongs to its old rail');
        assert.equal(textarea.isConnected, true);
        assert.equal(f.document.activeElement, textarea);
        assert.equal(textarea.focusCalls, focuses + 1, 'zone detach/reparent really required focus restoration');
        assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [1, 4, 'backward']);
        f.setState({ comments: { threads: [], revision: 'r3' } });
        f.viewer.refreshComments({ reveal: false });
        assert.equal(textarea.isConnected, false);
        assert.equal(f.document.activeElement, f.document.body);
        assert.equal(textarea.focusCalls, focuses + 1, 'removed inputs are not focused');
        f.setState({ comments: { threads: [thread()], revision: 'r4' } });
        f.viewer.refreshComments({ reveal: false });
        assert.equal(find(f.article(), 'textarea')[0], textarea);
        assert.equal(textarea.value, 'retained draft');
        assert.equal(f.document.activeElement, f.document.body, 'returning an unfocused draft does not steal focus');
      } finally { f.viewer.dispose(); }
    }
  } finally { setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});

test('a retained new-comment composer cannot steal reply focus after an editor remount', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  const oldTimeout = globalThis.setTimeout;
  const timers: (() => void)[] = [];
  // This IO fake queues only the callback used by composer focus; it does not
  // advertise a Node timer handle or any of its unsupported methods.
  Object.defineProperty(globalThis, 'setTimeout', { value: (callback: () => void) => { timers.push(callback); }, writable: true, configurable: true });
  const f = fixture('file', { addComment: async () => {} });
  try {
    f.viewer.render();
    await tick();
    f.viewer.addComment();
    timers.splice(0).forEach((callback) => callback());
    const newComment = present([...f.zones.values()].find((zone) => zone.ordinal === 0)).domNode;
    const newText = find(newComment, 'textarea')[0];
    newText.value = 'also a new comment';
    newText.events.input();
    find(f.article(), 'button')[0].events.click();
    const replyText = find(f.article(), 'textarea')[0];
    replyText.value = 'reply draft';
    f.viewer.render();
    await tick();
    timers.splice(0).forEach((callback) => callback());
    assert.equal(f.document.activeElement, replyText);
    assert.equal(replyText.value, 'reply draft');
  } finally { f.viewer.dispose(); globalThis.setTimeout = oldTimeout; setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});

test('workspace refresh, real viewer and native reply form show incoming conflict history before retry, then reload the reopened reply', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  let workspace: ReturnType<typeof createWorkspaceStore>;
  const f = fixture('inline', { addReply: (input) => workspace.addReply(input) });
  let comments = { threads: [thread()], warning: null, revision: 'r1' };
  let releaseRefresh: (() => void) | undefined;
  let holdRefresh = false;
  const posts: Record<string, unknown>[] = [];
  const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
  workspace = createWorkspaceStore({ viewModeStore: createViewModeStore({ getItem: () => 'diff' }),
    commitLock: createCommitLockStore(), onActivePathChanged() {},
    async fetch(url, options) {
      if (options?.method === 'POST') {
        const parsed: unknown = JSON.parse(present(options.body));
        assert.ok(isRecord(parsed));
        const input = parsed;
        assert.ok(typeof input.text === 'string');
        posts.push(input);
        if (input.revision !== comments.revision) return response({ error: 'Comments changed; review and retry', conflict: true }, 409);
        comments = { threads: [{ ...comments.threads[0], resolved: false, messages: [...comments.threads[0].messages,
          { id: 'saved', author: 'user', text: input.text, created_at: '2026-10-02T10:00:00Z' }] }], revision: 'r3', warning: null };
        return response({}, 201);
      }
      if (url.startsWith('/api/comments')) {
        if (holdRefresh) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
        return response(comments);
      }
      if (url.startsWith('/api/files')) return response([{ type: 'file', path: 'a.js', name: 'a.js', status: 'modified' }]);
      if (url.startsWith('/api/file-content')) return response({ head: 'before', working: 'one\ntwo\nthree' });
      return response([]);
    },
    onChange(part) {
      f.setState(workspace.getState());
      if (['render', 'main'].includes(part)) f.viewer.render();
      if (['comments', 'comments-refresh'].includes(part)) f.viewer.refreshComments({ reveal: false });
    },
  });
  try {
    workspace.updateWorktrees([{ path: '/repo' }]);
    await workspace.selectFile('a.js');
    await tick();
    const article = f.article();
    find(article, 'button')[0].events.click();
    const textarea = find(article, 'textarea')[0];
    textarea.value = 'Is this resolved? <b>keep literal</b>';
    comments = { ...comments, revision: 'r2', threads: [thread({ messages: [...thread().messages,
      { id: 'unseen', author: 'agent', text: 'Incoming <script>literal</script>', created_at: '2026-10-02T09:00:00Z' }] })] };
    holdRefresh = true;
    const form = find(article, 'form')[0];
    const save = find(form, 'button')[0];
    const saving = form.events.submit({ preventDefault() {} });
    await tick();
    assert.equal(save.disabled, true);
    assert.equal(textarea.value, 'Is this resolved? <b>keep literal</b>');
    present(releaseRefresh)();
    holdRefresh = false;
    await saving;
    assert.equal(f.article(), article);
    assert.equal(save.disabled, false);
    assert.equal(save.textContent, 'Retry reply');
    assert.match(find(form, 'p')[0].textContent, /Comments changed/);
    assert.deepEqual(find(article.children[1], 'p').map((node) => node.textContent).filter((_, i) => i % 2),
      ['Resolved <b>literally</b>', 'Incoming <script>literal</script>']);
    assert.equal(f.document.activeElement, textarea);
    await form.events.submit({ preventDefault() {} });
    assert.deepEqual(posts.map((post) => post.revision), ['r1', 'r2']);
    await workspace.loadComments();
    assert.equal(workspace.getState().comments.threads[0].resolved, false);
    assert.deepEqual(workspace.getState().comments.threads[0].messages.map((message) => message.id), ['m', 'unseen', 'saved']);
    assert.equal(find(article, 'textarea').length, 0);
  } finally { f.viewer.dispose(); setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});

test('general and unavailable conversations retain drafts on refresh, navigation and worktree round trips without cross-saving', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  const f = fixture('file');
  try {
    const { file, side, line_range, ...general } = thread();
    f.setState({ mainView: 'general', comments: { threads: [general], revision: 'r1' } });
    f.viewer.render();
    const article = f.article();
    find(article, 'button')[0].events.click();
    const textarea = find(article, 'textarea')[0];
    textarea.value = 'kept general draft';
    textarea.setSelectionRange(1, 3, 'forward');
    f.viewer.refreshComments({ reveal: false });
    assert.equal(f.article(), article);
    assert.equal(f.document.activeElement, textarea);
    f.setState({ activePath: '/other', comments: { threads: [] } });
    f.viewer.render();
    await find(article, 'form')[0].events.submit({ preventDefault() {} });
    assert.equal(f.saves.length, 0);
    f.setState({ activePath: '/repo', comments: { threads: [general], revision: 'r2' } });
    f.viewer.render();
    assert.equal(find(f.article(), 'textarea')[0].value, 'kept general draft');
    f.setState({ mainView: 'file', selectedThreadId: 't', comments: { threads: [thread({ unavailable: 'missing' })], revision: 'r2' } });
    f.viewer.refreshComments({ reveal: false });
    assert.equal(find(f.article(), 'textarea')[0], textarea, 'anchor changes keep the thread draft');
  } finally { f.viewer.dispose(); setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});

test('navigation during post-save refresh closes confirmed saved drafts but retains failed drafts without another POST', async () => {
  const oldWindow = globalThis.window;
  const oldMonaco = globalThis.monaco;
  try {
    for (const status of [409, 201]) {
      let workspace: ReturnType<typeof createWorkspaceStore>;
      const f = fixture('file', { addReply: (input) => workspace.addReply(input) });
      const posts: Record<string, unknown>[] = [];
      let releaseRefresh: (() => void) | undefined;
      let holdNextRefresh = false;
      const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
      workspace = createWorkspaceStore({ viewModeStore: createViewModeStore({ getItem: () => 'file' }),
        commitLock: createCommitLockStore(), onActivePathChanged() {},
        async fetch(url, options) {
          if (options?.method === 'POST') {
            const parsed: unknown = JSON.parse(present(options.body));
            assert.ok(isRecord(parsed));
            posts.push(parsed);
            holdNextRefresh = true;
            return response(status === 201 ? {} : { error: 'Comments changed', conflict: true }, status);
          }
          if (url.startsWith('/api/comments')) {
            if (holdNextRefresh) {
              holdNextRefresh = false;
              await new Promise<void>((resolve) => { releaseRefresh = resolve; });
            }
            return response({ threads: [thread()], warning: null, revision: 'r2' });
          }
          if (url.startsWith('/api/files')) return response([{ type: 'file', path: 'a.js', name: 'a.js', status: 'modified' }]);
          if (url.startsWith('/api/file-content')) return response({ head: 'before', working: 'one\ntwo\nthree' });
          return response([]);
        },
        onChange(part) {
          f.setState(workspace.getState());
          if (['render', 'main'].includes(part)) f.viewer.render();
          if (['comments', 'comments-refresh'].includes(part)) f.viewer.refreshComments({ reveal: false });
        },
      });
      try {
        workspace.updateWorktrees([{ path: '/repo' }, { path: '/other' }]);
        await workspace.selectFile('a.js');
        await tick();
        const article = f.article();
        find(article, 'button')[0].events.click();
        const textarea = find(article, 'textarea')[0];
        textarea.value = 'my reply';
        const saving = find(article, 'form')[0].events.submit({ preventDefault() {} });
        await tick();
        assert.equal(typeof releaseRefresh, 'function', 'the post-response refresh is held');
        workspace.selectWorktree('/other');
        workspace.selectWorktree('/repo');
        await workspace.selectFile('a.js');
        await tick();
        present(releaseRefresh)();
        await saving;
        assert.equal(f.article(), article);
        assert.equal(posts.length, 1);
        if (status === 201) {
          assert.equal(find(article, 'textarea').length, 0, 'confirmed success closes the saved draft');
          assert.doesNotMatch(find(article, 'button')[0].textContent, /Retry/);
        } else {
          assert.equal(find(article, 'textarea')[0], textarea);
          assert.equal(textarea.value, 'my reply');
          assert.match(find(article, 'form')[0].children[2].textContent, /worktree changed/);
        }
      } finally { f.viewer.dispose(); }
    }
  } finally { setLoaderWindow(oldWindow); globalThis.monaco = oldMonaco; }
});
