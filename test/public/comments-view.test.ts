import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCommentIndex, commentsForView, renderComposer, renderConversation } from '../../public/comments-view.js';
import type { ComposerOptions } from '../../public/comments-view.js';
import type { CommentThread } from '../../public/comment-dom.js';
import { Element, FakeDocument } from './fake-dom.js';

const document = new FakeDocument();
const thread = { id: 't', file: 'missing.js', side: 'modified', line_range: { start: 4, end: 8 },
  created_at: '2026-10-01T12:00:00Z', resolved: true, unavailable: 'missing',
  messages: [{ id: 'm', author: 'agent', text: 'Secret full text', created_at: 'now' }] } satisfies CommentThread;
const texts = (node: Element): string => [node.textContent, ...node.children.flatMap(texts)].join(' ');

function pendingSave(): { resolve(): void; reject(reason: Error): void } {
  return { resolve() { throw new Error('No pending save'); }, reject(_reason: Error) { throw new Error('No pending save'); } };
}

test('sidebar exposes only file/range buttons and the always-useful general navigation button', () => {
  const { file, side, line_range, unavailable, ...general } = { ...thread, id: 'general' };
  const selected: string[] = [];
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

test('compact rail keeps resolved threads selectable and distinguishes their status without exposing messages', () => {
  const index = renderCommentIndex(document, { threads: [thread, { ...thread, id: 'open', resolved: false }] }, {});
  assert.equal(index.children.length, 3);
  assert.match(index.children[1].className, /comment-index__button--resolved/);
  assert.equal(index.children[1]['aria-label'], 'missing.js:4–8, Resolved');
  assert.equal(index.children[2]['aria-label'], 'missing.js:4–8, Open');
  assert.doesNotMatch(index.children[2].className, /--resolved/);
  assert.doesNotMatch(texts(index), /Secret full text/);
});

test('valid inline ranges are available; unavailable anchors never become general', () => {
  const state: Parameters<typeof commentsForView>[0] = { activeFile: 'a.js', fileTree: [{ type: 'file', path: 'a.js' }],
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const find = (node: Element, tag: string): Element[] => [...(node.tag === tag ? [node] : []), ...node.children.flatMap((child) => find(child, tag))];
const submit = (form: Element) => form.events.submit({ preventDefault() {} });

test('native Resolve/Reopen keeps reply drafts and explicit retry intent across incoming history, without interpreting text', async () => {
  let finish = pendingSave();
  const saves: boolean[] = [];
  const article = renderConversation(document, { ...thread, resolved: false }, { onReply: async () => {}, onSetResolved: (resolved) => {
    saves.push(resolved);
    return new Promise<void>((resolve, reject) => { finish = { resolve, reject }; });
  } });
  const reply = find(article, 'button')[0];
  const toggle = find(article, 'button')[1];
  assert.equal(toggle.textContent, 'Resolve');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle['aria-label'], 'Resolve thread t');
  reply.events.click();
  const textarea = find(article, 'textarea')[0];
  textarea.value = 'Is this resolved? <b>literal draft</b>';
  const saving = toggle.events.click();
  toggle.events.click();
  assert.equal(toggle.disabled, true);
  assert.deepEqual(saves, [true]);
  article.updateThread({ ...thread, messages: [...thread.messages, { id: 'incoming', author: 'agent', text: '<script>literal</script>', created_at: 'later' }] });
  finish.reject(new Error('Conflict <img>; review and retry'));
  await saving;
  assert.equal(toggle.textContent, 'Retry resolve', 'retry does not invert an incoming resolved flag');
  assert.equal(find(article, 'textarea')[0], textarea);
  assert.equal(textarea.value, 'Is this resolved? <b>literal draft</b>');
  assert.match(texts(article), /Conflict <img>/);
  assert.equal(find(article, 'p').at(-1)?.role, 'alert');
  assert.ok(article.updateResolutionState);
  article.updateResolutionState({ blocked: true, warning: 'Cannot refresh; reload comments' });
  assert.equal(toggle.disabled, true);
  await toggle.events.click();
  assert.deepEqual(saves, [true]);
  article.updateResolutionState({ blocked: false });
  const retry = toggle.events.click();
  finish.resolve();
  await retry;
  assert.deepEqual(saves, [true, true]);
  assert.equal(toggle.textContent, 'Reopen');
  const reopening = toggle.events.click();
  article.updateThread({ ...thread, resolved: false });
  finish.resolve();
  await reopening;
  assert.deepEqual(saves, [true, true, false]);
  assert.equal(toggle.textContent, 'Resolve');
  assert.doesNotMatch(texts(article), /Edit/);
});

test('resolved conversations expose native Reply, retain the same focused draft through updates and show safe retry text', async () => {
  let finish = pendingSave();
  const saves: string[] = [];
  const doc = new FakeDocument();
  const article = renderConversation(doc, thread, { onReply: (text) => {
    saves.push(text);
    return new Promise<void>((resolve, reject) => { finish = { resolve, reject }; });
  } });
  const reply = find(article, 'button')[0];
  assert.equal(reply.textContent, 'Reply');
  assert.equal(reply.type, 'button');
  assert.equal(reply['aria-expanded'], 'false');
  assert.doesNotMatch(texts(article), /Edit/);
  reply.events.click();
  const textarea = find(article, 'textarea')[0];
  assert.equal(textarea['aria-label'], 'Reply to thread t');
  assert.equal(doc.activeElement, textarea);
  textarea.value = 'my <b>draft</b>';
  textarea.events.input();
  article.updateThread({ ...thread, resolved: false, messages: [...thread.messages,
    { id: 'incoming', author: 'agent', text: '<script>incoming</script>', created_at: 'later' }] });
  assert.equal(find(article, 'textarea')[0], textarea);
  assert.equal(doc.activeElement, textarea);
  assert.equal(textarea.value, 'my <b>draft</b>');
  const form = find(article, 'form')[0];
  const saving = submit(form);
  submit(form);
  assert.equal(find(form, 'button')[0].disabled, true);
  assert.deepEqual(saves, ['my <b>draft</b>']);
  finish.reject(new Error('Conflict <img> — review incoming messages and retry'));
  await saving;
  assert.equal(find(form, 'button')[0].textContent, 'Retry reply');
  assert.match(texts(article), /Conflict <img>/);
  assert.match(texts(article), /<script>incoming<\/script>/);
  assert.equal(find(article, 'textarea')[0], textarea);
  const retry = submit(form);
  finish.resolve();
  await retry;
  assert.equal(find(article, 'textarea').length, 0);
  assert.equal(reply['aria-expanded'], 'false');
});

test('an unreadable refresh blocks reply retry until a valid conversation arrives without discarding the draft', async () => {
  let saves = 0;
  const article = renderConversation(document, thread, { onReply: async () => { saves++; throw new Error('Conflict'); } });
  find(article, 'button')[0].events.click();
  const textarea = find(article, 'textarea')[0];
  textarea.value = 'keep me';
  assert.ok(article.updateReplyState);
  article.updateReplyState({ blocked: true, warning: 'Failed to refresh; reload comments before retrying' });
  const form = find(article, 'form')[0];
  assert.equal(find(form, 'button')[0].disabled, true);
  await submit(form);
  assert.equal(saves, 0);
  assert.match(texts(form), /Failed to refresh/);
  article.updateReplyState({ blocked: false });
  assert.equal(find(form, 'button')[0].disabled, false);
  await submit(form);
  assert.equal(saves, 1);
  assert.equal(textarea.value, 'keep me');
});

function composer(options: Partial<ComposerOptions> = {}) {
  const calls: string[][] = [];
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
  const saves: string[] = [];
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

test('composer retry wording is explicit rather than inferred from save-button text', async () => {
  const { view, form, textarea } = composer({ saveLabel: 'Publish', retryLabel: 'Try again',
    onSave: async () => { throw new Error('Conflict'); } });
  textarea.value = 'draft';
  await submit(form);
  assert.equal(find(view.node, 'button')[0].textContent, 'Try again');
});

test('composer labels a range by its inclusive lines and a single line by its line', () => {
  const label = (options: Partial<ComposerOptions>) => find(composer(options).view.node, 'textarea')[0]['aria-label'];
  assert.equal(label({ line: 7 }), 'New comment on line 7');
  assert.equal(label({ line: 7, endLine: 7 }), 'New comment on line 7');
  assert.equal(label({ line: 3, endLine: 5 }), 'New comment on lines 3-5');
});
