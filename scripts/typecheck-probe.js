// The gate must reject invalid calls, not merely exit successfully on valid code.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
assert.deepEqual(parsed.errors, []);
const directory = await mkdtemp(path.join(root, '.typecheck-probe-'));
try {
  const filename = path.join(directory, 'probe.ts');
  await writeFile(filename, `import { isInsideWorktree, formatChangeEvent, formatWorktreeListEvent, formatPollErrorEvent } from '../server/route-logic.js';
import { renderComposer, renderConversation, captureCommentFocus } from '../public/comments-view.js';
import { createRailResizer } from '../public/rail-resize.js';
import { FakeDocument } from '../test/public/fake-dom.js';
declare const document: Document;
declare const window: Window;
// Positive controls: native capabilities must satisfy the same narrow ports.
renderComposer(document, { line: 1, onSave: async () => {} });
captureCommentFocus(document, document.body);
createRailResizer({ bodyEl: document.body, railEl: document.body, dividerEl: document.body, window });
isInsideWorktree('/repo', 42);
formatChangeEvent([42]);
formatWorktreeListEvent([{ path: 42 }]);
formatPollErrorEvent({ message: 42 });
import { createRequestHandler, type ResponseDescription } from '../server/handle-request.js';
import { createApp } from '../server/app.js';
createRequestHandler({ publicDir: 42 });
createApp({ repoRoot: 42 });
createApp({ getFileContent: async () => ({ head: 42, working: null }) });
createApp({ createComment: async (_path, input) => input.text.trim() });
createApp({ watchWorktree: (_path, onChange) => { onChange([42]); return { close() {} }; } });
const conflictingResponse: ResponseDescription = { status: 200, headers: {}, body: 'json', stream: { subscribe: () => () => {} } };
declare const handleRequest: ReturnType<typeof createRequestHandler>;
handleRequest({ method: 'GET', pathname: 42, searchParams: new URLSearchParams() });
import { parseWorktreeList, selectedFirst } from '../server/porcelain.js';
import { createListWorktrees } from '../server/default-deps.js';
import { listCommits } from '../server/commits.js';
import { createWorktreeDeletion } from '../server/worktree-delete.js';
parseWorktreeList(42);
selectedFirst([{ path: 42 }], '/repo');
createListWorktrees('/repo', async () => 42);
listCommits('/repo', 42);
createWorktreeDeletion('/repo').remove('/linked', 42);
// A simulated document must not advertise unsupported native capabilities.
const fakeDocument: Document = new FakeDocument();
new FakeDocument().querySelector('body');
renderConversation(document, { id: 'thread', file: 'a.js', messages: [] });
import { parseComments, appendThread, appendReply } from '../server/comments.js';
import { createCommentStore } from '../server/comment-store.js';
import { createCommentLoader } from '../server/comment-loader.js';
import { checkPath, defaultReadIo } from '../server/sidecar-path.js';
// Positive controls: native and minimal path capabilities; malformed values
// still enter the runtime validation boundary without pretending to be valid.
createCommentLoader(defaultReadIo);
checkPath({ lstat: defaultReadIo.lstat }, '/repo', '.canopy/comments.yaml');
createCommentStore().create('/repo', { file: null, line: 'bad', text: 42, revision: false });
parseComments(42);
appendThread(null, { file: 42, line: 1, text: 'x' }, { threadId: 't', messageId: 'm', createdAt: 'now' });
appendReply(null, { threadId: 't', text: 'x' }, { messageId: 'm' });
createCommentLoader({ ...defaultReadIo, readFile: async () => 42 });
createCommentStore({ newId: () => 42 });
checkPath({ lstat: async () => ({ isFile: () => true }) }, '/repo', 'a.js');
declare const rawYaml: unknown;
const trustedThread = rawYaml.threads[0];
`);
  const program = ts.createProgram([...parsed.fileNames, filename], { ...parsed.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const rejected = diagnostics.filter((diagnostic) => diagnostic.file?.fileName === filename);
  assert.deepEqual(rejected.map((diagnostic) => diagnostic.code), [2345, 2322, 2322, 2322, 2322, 2322, 2322, 18046, 2322, 2322, 2322, 2345, 2322, 2345, 2345, 2345, 2740, 2339, 2345, 2345, 2322, 2345, 2322, 2322, 2322, 18046],
    `Static gate must accept native browser/comment IO and minimal path ports and reject all invalid calls, response shapes, fake capabilities and unchecked YAML access.\n${ts.formatDiagnostics(rejected, {
      getCurrentDirectory: () => root, getCanonicalFileName: (filename) => filename, getNewLine: () => '\n',
    })}`);
  console.log('Static probes: native browser/comment IO and minimal path ports accepted; all twenty-six invalid calls, response shapes, fake capabilities and unchecked YAML accesses rejected');
} finally {
  await rm(directory, { recursive: true, force: true });
}
