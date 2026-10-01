import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCommentIndex, commentsForView, renderComposer } from '../../public/comments-view.js';

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

test('valid inline ranges are available; unavailable anchors never become general', () => {
  const state = { activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
    fileContent: { working: 'one\ntwo' }, comments: { threads: [
      { ...thread, file: 'a.js', unavailable: null, line_range: { start: 1, end: 2 } }, thread,
      { id: 'general', messages: [] },
    ] } };
  const result = commentsForView(state);
  assert.equal(result.threads[0].unavailable, null);
  assert.equal(result.threads[1].file, 'missing.js');
  assert.equal(result.threads[1].unavailable, 'missing');
  assert.equal(Object.hasOwn(result.threads[2], 'file'), false);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const find = (node, tag) => [...(node.tag === tag ? [node] : []), ...node.children.flatMap((child) => find(child, tag))];
const submit = (form) => form.events.submit({ preventDefault() {} });

function composer(options = {}) {
  const calls = [];
  const view = renderComposer(document, { line: 7, onInput: (text) => calls.push(['input', text]),
    onSave: async (text) => { calls.push(['save', text]); }, onCancel: () => calls.push(['cancel']), ...options });
  return { view, calls, form: find(view.node, 'form')[0], textarea: find(view.node, 'textarea')[0] };
}

test('composer is a labelled native form whose draft text is passed on save', async () => {
  const { view, calls, form, textarea } = composer({ text: 'draft' });
  assert.equal(textarea.value, 'draft');
  assert.match(texts(view.node), /line 7/);
  assert.equal(find(view.node, 'button').map((button) => button.type).join(), 'submit,button');
  textarea.value = 'typed <b>text</b>';
  textarea.events.input();
  submit(form);
  await tick();
  assert.deepEqual(calls, [['input', 'typed <b>text</b>'], ['save', 'typed <b>text</b>']]);
});

test('composer ignores blank saves and cancels through its button', () => {
  const { view, calls, form, textarea } = composer();
  textarea.value = '  \n';
  submit(form);
  assert.deepEqual(calls, []);
  find(view.node, 'button')[1].events.click();
  assert.deepEqual(calls, [['cancel']]);
});

test('a failed save shows the error as text, keeps the draft and allows retry; a second submit while saving is ignored', async () => {
  let fail = true;
  const saves = [];
  const { view, form, textarea } = composer({ onSave: async (text) => { saves.push(text); if (fail) throw new Error('Comments changed <i>'); } });
  textarea.value = 'my long comment';
  submit(form);
  submit(form);
  await tick();
  assert.deepEqual(saves, ['my long comment']);
  assert.equal(textarea.value, 'my long comment');
  const alert = find(view.node, 'p')[0];
  assert.equal(alert.role, 'alert');
  assert.equal(alert.textContent, 'Comments changed <i>');
  fail = false;
  submit(form);
  await tick();
  assert.deepEqual(saves, ['my long comment', 'my long comment']);
  assert.equal(alert.textContent, '');
});

test('composer restores a retained error with its draft', () => {
  const { view } = composer({ text: 'kept', error: 'Disk full' });
  assert.equal(find(view.node, 'p')[0].textContent, 'Disk full');
});
