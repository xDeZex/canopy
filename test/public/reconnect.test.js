import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../../public/app.js';
import { Element } from './fake-dom.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const file = (name, status) => ({ type: 'file', name, path: name, status });

async function fixture() {
  const elements = Object.fromEntries(['tabs-wrapper', 'tabs', 'body', 'rail', 'rail-divider',
    'toolbar', 'main', 'shortcut-help'].map((id) => [id, new Element('div')]));
  elements.body.clientWidth = 1006;
  elements['rail-divider'].offsetWidth = 6;
  elements.toolbar.isRoot = true;
  const document = {
    getElementById: (id) => elements[id],
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    addEventListener() {}, removeEventListener() {},
  };
  const window = {
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, removeEventListener() {},
  };
  const sources = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const mounts = [];
  const disposed = [];
  const snapshots = {
    tree: [file('open.txt', 'modified'), file('gone.txt', 'added'), file('deleted.txt', 'clean')],
    content: { head: 'locked base', working: 'before' },
  };
  class EventSource {
    constructor(url) { this.url = url; this.closeCount = 0; sources.push(this); }
    addEventListener() {}
    open() { this.onopen?.(); }
    close() { this.closeCount++; }
  }
  const app = await startApp({
    document, window, EventSource, now: () => 1000,
    setInterval: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearInterval: (id) => timers.delete(id),
    mountEditor: async () => ({ dispose() {} }),
    mountDiffEditor: async (container, options) => {
      const view = { container, options, position: 0 };
      mounts.push(view);
      return { dispose: () => disposed.push(view), nextChange: () => view.position++ };
    },
    fetch: async (url) => {
      requests.push(url);
      const pathname = url.split('?')[0];
      const responses = {
        '/api/worktrees': [{ path: '/a', head: 'unchanged', branch: 'main' }],
        '/api/files': snapshots.tree,
        '/api/file-content': snapshots.content,
        '/api/commits': [{ sha: 'locked', message: 'base', date: '2026-01-01' }],
      };
      if (pathname === '/api/file-content' && snapshots.content.head === null && snapshots.content.working === null) {
        return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
      }
      return { ok: true, json: async () => responses[pathname] };
    },
  });
  await settle();
  const source = sources.find((source) => source.url.startsWith('/api/watch?'));
  source.open();
  const rows = (selector) => elements.rail.querySelector(selector).querySelectorAll('.rail__file');
  const statuses = (selector) => rows(selector).map((row) => [row.title,
    row.className.match(/status-(\w+)/)[1]]);
  return { app, elements, sources, source, requests, timers, snapshots, mounts, disposed, rows, statuses };
}

test('reconnect recovers missed edits, additions and removals while preserving locked selection and menus', async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  f.rows('.rail__tree').find((row) => row.title === 'open.txt').click();
  await settle();
  const picker = f.elements.toolbar.querySelector('.commit-picker');
  picker.querySelector('.commit-picker__menu').querySelectorAll('.commit-picker__item').at(-1).click();
  await settle();
  picker.querySelector('.commit-picker__trigger').click();
  const menu = picker.querySelector('.commit-picker__menu');
  const viewer = f.mounts.at(-1);
  f.elements.toolbar.querySelectorAll('.change-nav__step')[1].click();
  assert.equal(viewer.position, 1);
  const before = f.requests.length;
  f.snapshots.tree = [file('deleted.txt', 'deleted'), file('new.txt', 'added'), file('open.txt', 'modified')];
  f.snapshots.content = { head: 'locked base', working: 'missed edit' };
  // No message, changed paths, or repo snapshot is delivered during the outage.
  f.source.open();
  await settle();
  assert.deepEqual(f.requests.slice(before), [
    '/api/files?worktree=%2Fa&ref=locked',
    '/api/file-content?worktree=%2Fa&file=open.txt&ref=locked',
  ]);
  for (const selector of ['.rail__tree', '.changed-files']) {
    assert.deepEqual(f.statuses(selector), [
      ['deleted.txt', 'deleted'], ['new.txt', 'added'], ['open.txt', 'modified'],
    ]);
    assert.equal(f.rows(selector).find((row) => row.title === 'open.txt').classList.contains('is-active'), true);
  }
  assert.equal(f.mounts.at(-1).options.modified, 'missed edit');
  assert.equal(f.mounts.at(-1).options.original, 'locked base');
  assert.equal(f.elements.toolbar.querySelector('.commit-picker'), picker);
  assert.equal(picker.querySelector('.commit-picker__menu'), menu);
  assert.equal(menu.classList.contains('is-open'), true);
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');

  const unchangedViewer = f.mounts.at(-1);
  const counts = [f.mounts.length, f.disposed.length];
  unchangedViewer.position = 7;
  f.snapshots.content = { working: 'missed edit', head: 'locked base' };
  for (let i = 0; i < 3; i++) {
    f.source.open();
    await settle();
    assert.equal(f.elements.main.children[0], unchangedViewer.container);
    assert.equal(unchangedViewer.position, 7);
    assert.deepEqual([f.mounts.length, f.disposed.length], counts);
    assert.equal(menu.classList.contains('is-open'), true);
  }
  assert.equal(f.sources.length, 3, 'only file, worktree and activity streams exist');
  assert.equal(f.timers.size, 1, 'reconnect introduces no timer');
  f.app.dispose();
  f.app.dispose();
  assert.equal(f.timers.size, 0);
  assert.ok(f.sources.every((source) => source.closeCount === 1));
  const afterDispose = f.requests.length;
  f.source.open();
  assert.equal(f.requests.length, afterDispose);
});

test('removed selected added file keeps its path and shows the existing not-found error after reconnect', async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  f.snapshots.content = { head: null, working: 'untracked content' };
  f.rows('.rail__tree').find((row) => row.title === 'gone.txt').click();
  await settle();
  const counts = [f.mounts.length, f.disposed.length];
  f.snapshots.tree = [file('open.txt', 'modified'), file('deleted.txt', 'clean')];
  f.snapshots.content = { head: null, working: null };
  f.source.open();
  await settle();
  assert.equal(f.requests.at(-1), '/api/file-content?worktree=%2Fa&file=gone.txt');
  assert.equal(f.elements.main.children[0].textContent, 'Failed to load file: request failed with status 404');
  assert.deepEqual([f.mounts.length, f.disposed.length], [counts[0], counts[1] + 1]);
  assert.equal(f.rows('.rail__tree').some((row) => row.title === 'gone.txt'), false);
  assert.equal(f.rows('.changed-files').some((row) => row.title === 'gone.txt'), false);
  assert.equal(f.elements.toolbar.querySelector('.viewer__filename').textContent, 'gone.txt');
  f.source.open();
  await settle();
  assert.equal(f.requests.at(-1), '/api/file-content?worktree=%2Fa&file=gone.txt', 'selection is not silently replaced');
  assert.equal(f.elements.main.children[0].textContent, 'Failed to load file: request failed with status 404');
});

test('reconnect of a selected tracked deletion shows original content and the existing File-mode deletion state', async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  f.snapshots.content = { head: 'tracked original', working: 'tracked original' };
  f.rows('.rail__tree').find((row) => row.title === 'deleted.txt').click();
  await settle();
  f.elements.toolbar.querySelector('.view-toggle--mode').querySelectorAll('.view-toggle__btn')[0].click();
  await settle();
  f.snapshots.tree = [file('deleted.txt', 'deleted'), file('open.txt', 'modified')];
  f.snapshots.content = { head: 'tracked original', working: null };
  f.source.open();
  await settle();
  assert.equal(f.requests.at(-1), '/api/file-content?worktree=%2Fa&file=deleted.txt');
  assert.equal(f.mounts.at(-1).options.original, 'tracked original');
  assert.equal(f.mounts.at(-1).options.modified, '');
  for (const selector of ['.rail__tree', '.changed-files']) {
    const row = f.rows(selector).find((row) => row.title === 'deleted.txt');
    assert.equal(row.classList.contains('status-deleted'), true);
    assert.equal(row.classList.contains('is-active'), true);
  }
  f.elements.toolbar.querySelector('.view-toggle--mode').querySelectorAll('.view-toggle__btn')[1].click();
  assert.equal(f.elements.main.children[0].children[0].textContent, 'This file was deleted from the working tree.');
  f.source.open();
  await settle();
  assert.equal(f.requests.at(-1), '/api/file-content?worktree=%2Fa&file=deleted.txt');
  assert.equal(f.elements.main.children[0].children[0].textContent, 'This file was deleted from the working tree.');
});
