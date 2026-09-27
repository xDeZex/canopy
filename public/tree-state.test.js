import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeExpansionStore } from './tree-state.js';

test('a folder is collapsed by default', () => {
  const store = createTreeExpansionStore();
  assert.equal(store.isExpanded('/repo/a', 'server'), false);
});

test('toggling an unexpanded folder expands it', () => {
  const store = createTreeExpansionStore();
  store.toggle('/repo/a', 'server');
  assert.equal(store.isExpanded('/repo/a', 'server'), true);
});

test('toggling an expanded folder collapses it again', () => {
  const store = createTreeExpansionStore();
  store.toggle('/repo/a', 'server');
  store.toggle('/repo/a', 'server');
  assert.equal(store.isExpanded('/repo/a', 'server'), false);
});

test('expansion is scoped per worktree', () => {
  const store = createTreeExpansionStore();
  store.toggle('/repo/a', 'server');
  assert.equal(store.isExpanded('/repo/b', 'server'), false);
  assert.equal(store.isExpanded('/repo/a', 'server'), true);
});

test('expansion is independent per folder path within the same worktree', () => {
  const store = createTreeExpansionStore();
  store.toggle('/repo/a', 'server');
  assert.equal(store.isExpanded('/repo/a', 'public'), false);
  assert.equal(store.isExpanded('/repo/a', 'server'), true);
});
