import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCommentIndex, commentsForView } from '../../public/comments-view.js';

const element = (tag) => ({ tag, children: [], textContent: '', events: {},
  setAttribute(name, value) { this[name] = value; },
  replaceChildren(...children) { this.children = children; },
  addEventListener(name, listener) { this.events[name] = listener; },
});
const document = { createElement: element };
const thread = { id: 't', file: 'missing.js', side: 'modified', line_range: { start: 4, end: 8 },
  created_at: '2026-10-01T12:00:00Z', resolved: true, unavailable: 'missing',
  messages: [{ id: 'm', author: 'agent', text: 'Secret full text', created_at: 'now' }] };
const texts = (node) => [node.textContent, ...node.children.flatMap(texts)].join(' ');

test('sidebar exposes only file/range buttons and the always-useful general navigation button', () => {
  const { file, side, line_range, unavailable, ...general } = { ...thread, id: 'general' };
  const selected = [];
  const index = renderCommentIndex(document, { threads: [thread, general] }, {
    onSelectThread: (id) => selected.push(id), onGeneralComments: () => selected.push('general'),
  });
  assert.equal(index.children[0].textContent, 'Comments without a file');
  assert.equal(index.children[1].textContent, 'missing.js:4–8');
  for (const button of index.children) {
    assert.equal(button.tag, 'button');
    assert.equal(button.type, 'button');
    button.events.click();
  }
  assert.deepEqual(selected, ['general', 't']);
  assert.doesNotMatch(texts(index), /Secret|agent|2026|Resolved|missing(?!\.js)/);
  assert.equal(renderCommentIndex(document, { threads: [] }, {}).children[0].textContent, 'Comments without a file');
});

test('File and expanded Diff permit exact ranges; collapsed and unavailable anchors never become general', () => {
  const state = { activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { working: 'one\ntwo' }, comments: { threads: [
      { ...thread, file: 'a.js', unavailable: null, line_range: { start: 1, end: 2 } }, thread,
      { id: 'general', messages: [] },
    ] } };
  for (const mode of ['file', 'diff']) {
    const result = commentsForView(state, mode, 'inline');
    assert.equal(result.threads[0].unavailable, null);
    assert.equal(result.threads[1].file, 'missing.js');
    assert.equal(Object.hasOwn(result.threads[2], 'file'), false);
  }
  assert.match(commentsForView(state, 'diff', 'collapsed').threads[0].unavailable, /Collapsed/);
});
