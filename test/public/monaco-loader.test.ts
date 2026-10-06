import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AmdLoader, MonacoPort, MountSettings, TextModel } from '../../public/monaco-port.js';
import { FakeDocument } from './fake-dom.js';
import { fakeModel, present, setLoaderWindow } from './monaco-fake.js';

const originalWindow = globalThis.window;
const originalMonaco = globalThis.monaco;
after(() => { setLoaderWindow(originalWindow); globalThis.monaco = originalMonaco; });

let scenario = 0;
async function mounting() {
  // The known local module has process-lifetime loader caching. Native ESM query
  // identity isolates each scenario without adding a production reset/test API.
  const url = new URL('../../public/monaco-view.js', import.meta.url);
  url.searchParams.set('loader-scenario', String(++scenario));
  const module: typeof import('../../public/monaco-view.js') = await import(url.href);
  const document = new FakeDocument();
  const container = document.createElement('div');
  return {
    file: (content: string | null = 'text') => module.mountEditor(container, { content, document }),
    diff: () => module.mountDiffEditor(container, { original: null, modified: 'new', document }),
  };
}

test('concurrent file/diff mounts configure the pinned AMD module once, wait for success and reuse the settled cache', async () => {
  const calls: string[] = [];
  let loaded: (() => void) | undefined;
  let failed: ((error: unknown) => void) | undefined;
  const loader: AmdLoader = Object.assign((modules: string[], success: () => void, failure: (error: unknown) => void) => {
    assert.deepEqual(modules, ['vs/editor/editor.main']);
    calls.push('require'); loaded = success; failed = failure;
  }, { config(options: { paths: { vs: string } }) {
    assert.deepEqual(options, { paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
    calls.push('config');
  } });
  setLoaderWindow({ require: loader });
  const models: TextModel[] = [];
  const settings: MountSettings[] = [];
  const monaco: MonacoPort = { editor: {
    create(_container, options) { calls.push('file'); settings.push(options); return { dispose: () => calls.push('file dispose') }; },
    createModel(content, language) {
      assert.equal(language, undefined);
      calls.push(`model ${content}`);
      const model = fakeModel({ dispose: () => calls.push(`model dispose ${content}`) });
      models.push(model); return model;
    },
    createDiffEditor(_container, options) {
      calls.push('diff'); settings.push(options);
      return {
        setModel(pair) { assert.equal(pair.original, models[0]); assert.equal(pair.modified, models[1]); calls.push('setModel'); },
        onDidUpdateDiff: () => ({ dispose: () => calls.push('unsubscribe') }),
        dispose: () => calls.push('diff dispose'),
      };
    },
  } };
  const mount = await mounting();
  const file = mount.file();
  const diff = mount.diff();
  assert.deepEqual(calls, ['config', 'require'], 'no widget or model before AMD success');
  globalThis.monaco = monaco;
  present(loaded)();
  const controllers = await Promise.all([file, diff]);
  assert.deepEqual(calls, ['config', 'require', 'file', 'diff', 'model ', 'model new', 'setModel']);
  assert.deepEqual(settings, [
    { value: 'text', language: undefined, automaticLayout: true, readOnly: true, domReadOnly: true, theme: 'vs-dark', wordWrap: 'off' },
    { automaticLayout: true, readOnly: true, domReadOnly: true, originalEditable: false, theme: 'vs-dark', diffWordWrap: 'off',
      experimental: { showMoves: true }, renderSideBySide: false, hideUnchangedRegions: { enabled: false } },
  ]);
  // Subsequent mounts do not need window.require, and a late error cannot turn
  // an already-successful loader promise into a rejection.
  setLoaderWindow({});
  present(failed)(new Error('late error'));
  const cached = await mount.file(null);
  assert.equal(calls.filter((call) => call === 'config').length, 1);
  controllers.forEach((controller) => controller.dispose());
  cached.dispose();
  assert.deepEqual(calls.slice(-6), ['file dispose', 'unsubscribe', 'diff dispose', 'model dispose ', 'model dispose new', 'file dispose']);
});

test('an already-present Monaco skips AMD loading and still mounts the real controller', async () => {
  let disposed = 0;
  setLoaderWindow({ monaco: true, require: Object.assign(() => { assert.fail('AMD must be skipped'); }, {
    config() { assert.fail('AMD config must be skipped'); },
  }) });
  globalThis.monaco = { editor: { create: () => ({ dispose: () => disposed++ }) } };
  const view = await (await mounting()).file();
  view.dispose();
  assert.equal(disposed, 1);
});

test('missing AMD loader rejection remains cached even if window capabilities later recover', async () => {
  setLoaderWindow({});
  const mount = await mounting();
  await assert.rejects(mount.file(), /Monaco AMD loader \(loader.js\) not found on window.require/);
  setLoaderWindow({ monaco: true });
  globalThis.monaco = { editor: { create: () => { assert.fail('rejected loader cache must not mount'); } } };
  await assert.rejects(mount.diff(), /Monaco AMD loader \(loader.js\) not found on window.require/);
});

test('AMD config/invocation throws and module error callbacks reject concurrent and later mounts without retrying', async () => {
  for (const phase of ['config', 'require', 'callback']) {
    const error = { message: `failed ${phase}` }; // rejection values stay unknown
    let configured = 0;
    let requested = 0;
    let failed: ((error: unknown) => void) | undefined;
    const loader: AmdLoader = Object.assign((_modules: string[], _loaded: () => void, failure: (error: unknown) => void) => {
      requested++; failed = failure;
      if (phase === 'require') throw error;
    }, { config() { configured++; if (phase === 'config') throw error; } });
    setLoaderWindow({ require: loader });
    globalThis.monaco = { editor: { create() { assert.fail('failed loader must not create'); }, createDiffEditor() { assert.fail('failed loader must not create'); } } };
    const mount = await mounting();
    const outcomes = Promise.all([assert.rejects(mount.file(), (caught) => caught === error), assert.rejects(mount.diff(), (caught) => caught === error)]);
    if (phase === 'callback') present(failed)(error);
    await outcomes;
    await assert.rejects(mount.file(), (caught) => caught === error);
    assert.equal(configured, 1);
    assert.equal(requested, phase === 'config' ? 0 : 1);
  }
});
