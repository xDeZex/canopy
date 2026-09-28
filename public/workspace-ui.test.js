import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceUI } from './workspace-ui.js';
import { createWorkspaceStore } from './workspace-state.js';
import { createCommitLockStore } from './commit-lock.js';
import { createViewModeStore } from './view-mode.js';

// Only the DOM surface used by the workspace controls; no browser dependency.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
  }

  get classList() {
    const tokens = () => this.className.split(' ').filter(Boolean);
    return {
      contains: (name) => tokens().includes(name),
      add: (name) => { this.className = [...new Set([...tokens(), name])].join(' '); },
      remove: (name) => { this.className = tokens().filter((token) => token !== name).join(' '); },
      toggle: (name, force) => {
        if (force ?? !tokens().includes(name)) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }

  append(...children) {
    for (const child of children) {
      if (child.tag === 'fragment') this.append(...child.children);
      else {
        child.parentElement = this;
        this.children.push(child);
      }
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  querySelectorAll(selector) {
    const name = selector.slice(1);
    return this.children.flatMap((child) => [
      ...(child.classList.contains(name) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  click() { this.listeners.get('click')?.(); }
  setAttribute(name, value) { this[name] = value; }
}

function fixture() {
  const document = {
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
  };
  const window = { addEventListener() {} };
  const tabsWrapperEl = new Element('div');
  const tabsEl = new Element('div');
  const railEl = new Element('div');
  const toolbarEl = new Element('div');
  const commitLock = createCommitLockStore();
  const viewModeStore = createViewModeStore({ getItem: () => null, setItem() {} });
  const requests = [];
  let ui;
  const workspace = createWorkspaceStore({
    commitLock, viewModeStore,
    fetch(url) {
      return new Promise((resolve) => { requests.push({ url, resolve }); });
    },
    onActivePathChanged() {},
    onChange(part) {
      if (part === 'render') {
        ui.renderTabs();
        ui.renderToolbar();
      }
      if (part === 'toolbar') ui.renderToolbar();
      if (part === 'rail') ui.renderRail();
    },
  });
  ui = createWorkspaceUI({
    tabsWrapperEl, tabsEl, railEl, toolbarEl, workspace, commitLock, viewModeStore,
    treeExpansion: { isExpanded: () => false, toggle() {} },
    computeTabScrollAffordance: () => ({ showLeft: false, showRight: false }),
    formatRelativeTime: () => 'recently', DIFF_RENDER_MODES: ['inline', 'side-by-side', 'collapsed'],
    onViewModeChanged() {}, onDiffRenderModeChanged() {}, getDiffRenderMode: () => 'inline',
    document, window,
  });
  const reply = async (request, body) => {
    request.resolve({ ok: true, json: async () => body });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ui, workspace, commitLock, tabsEl, railEl, toolbarEl, requests, reply };
}

test('commit picker locks base, reloads tree and open file, then displays lock and Auto', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  assert.equal(f.tabsEl.querySelector('.tabs__branch').textContent, 'main');
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.querySelector('.rail__file').click();
  assert.equal(f.workspace.getState().activeFile, 'a.txt');
  const sha = 'abcdef123456';
  const fileCommits = f.requests.find((r) => r.url === '/api/commits?worktree=%2Frepo&file=a.txt');
  await f.reply(fileCommits, [{ sha, message: 'Earlier version', date: '2025-01-01' }]);
  const picker = f.toolbarEl.querySelector('.commit-picker');
  picker.querySelector('.commit-picker__trigger').click();
  assert.equal(picker.querySelector('.commit-picker__menu').classList.contains('is-open'), true);
  picker.querySelector('.commit-picker__item-sha').parentElement.click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), sha);
  assert.equal(f.requests[4].url, `/api/files?worktree=%2Frepo&ref=${sha}`);
  assert.equal(f.requests[5].url, `/api/file-content?worktree=%2Frepo&file=a.txt&ref=${sha}`);
  assert.equal(f.toolbarEl.querySelector('.commit-picker'), picker, 'editor controls stay mounted');
  assert.equal(picker.querySelector('.commit-picker__menu').classList.contains('is-open'), false);
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'abcdef1');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'locked');
  assert.equal(picker.querySelector('.commit-picker__item-time').textContent, 'recently');

  picker.querySelector('.commit-picker__menu').children[0].click();
  assert.equal(f.commitLock.getLockedCommit('/repo'), null);
  assert.equal(f.requests[6].url, '/api/files?worktree=%2Frepo');
  assert.equal(f.requests[7].url, '/api/file-content?worktree=%2Frepo&file=a.txt');
  assert.equal(picker.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
  assert.equal(picker.querySelector('.commit-picker__trigger-label').textContent, 'since last commit');
});

test('toolbar controls survive commit updates and reset on worktree change', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }, { path: '/b' }]);
  const oldPicker = f.toolbarEl.querySelector('.commit-picker');
  oldPicker.querySelector('.commit-picker__trigger').click();
  await f.reply(f.requests[1], [{ sha: '12345678', message: 'commit' }]);
  assert.equal(f.toolbarEl.querySelector('.commit-picker'), oldPicker);
  assert.equal(oldPicker.querySelector('.commit-picker__menu').classList.contains('is-open'), true);
  f.tabsEl.children[1].click();
  assert.notEqual(f.toolbarEl.querySelector('.commit-picker'), oldPicker);
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger-sha').textContent, 'HEAD');
  f.ui.renderError(new Error('unavailable'));
  assert.equal(f.tabsEl.children.length, 0);
  assert.equal(f.railEl.children.length, 0);
  assert.equal(f.toolbarEl.hidden, true);
  assert.equal(f.toolbarEl.children.length, 0);
});

test('locking without a selected file still refreshes the tree, not file content', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/a' }]);
  await f.reply(f.requests[1], [{ sha: '12345678', message: 'base' }]);
  f.toolbarEl.querySelector('.commit-picker__item-sha').parentElement.click();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].url, '/api/files?worktree=%2Fa&ref=12345678');
  assert.equal(f.toolbarEl.querySelector('.commit-picker__trigger-sha').textContent, '1234567');
});

test('commit dropdown marks only commits that touched the open file, keeping all in order', async () => {
  const f = fixture();
  f.workspace.updateWorktrees([{ path: '/repo', branch: 'main' }]);
  await f.reply(f.requests[0], [{ type: 'file', name: 'a.txt', path: 'a.txt', status: 'modified' }]);
  f.railEl.querySelector('.rail__file').click();
  const fileCommits = f.requests.find((r) => r.url === '/api/commits?worktree=%2Frepo&file=a.txt');
  await f.reply(fileCommits, [
    { sha: '1111111aaa', message: 'touched', date: '2025-01-01', touchesFile: true },
    { sha: '2222222bbb', message: 'unrelated', date: '2025-01-01', touchesFile: false },
  ]);
  const items = f.toolbarEl.querySelector('.commit-picker__menu').children.slice(1);
  assert.deepEqual(items.map((i) => i.classList.contains('commit-picker__item--touches-file')), [true, false]);
  assert.deepEqual(items.map((i) => i.querySelector('.commit-picker__item-sha').textContent), ['1111111', '2222222']);
});
