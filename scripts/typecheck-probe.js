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
`);
  const program = ts.createProgram([...parsed.fileNames, filename], { ...parsed.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const rejected = diagnostics.filter((diagnostic) => diagnostic.file?.fileName === filename);
  assert.deepEqual(rejected.map((diagnostic) => diagnostic.code), [2345, 2322, 2322, 2322, 2322, 2322, 2322, 18046, 2322, 2322, 2322],
    'Static gate must reject every deliberate invalid routing/HTTP call and response shape');
  console.log('Static negative probes: all eleven invalid routing/HTTP calls and response shapes rejected');
} finally {
  await rm(directory, { recursive: true, force: true });
}
