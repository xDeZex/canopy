import { collectFiles } from './collect-files.js';

// Never relocate an invalid range onto a convenient line or a synthetic
// deleted-file model. Unavailable threads stay readable in the main pane.
export function commentsForView(state) {
  const files = new Set(collectFiles(state.fileTree ?? []).map((file) => file.path));
  const threads = (state.comments?.threads ?? []).map((thread) => {
    if (!Object.hasOwn(thread, 'file')) return thread;
    let unavailable = thread.unavailable;
    if (!unavailable) {
      if (!files.has(thread.file)) unavailable = 'Anchor file is not available in the file tree';
      else if (thread.file !== state.activeFile) unavailable = 'Select this file to view its inline anchor';
      else if (state.fileContentError) unavailable = 'Anchor content could not be loaded';
      else if (!state.fileContent) unavailable = 'Anchor content is loading';
      else if (state.fileContent.working === null) unavailable = 'Deleted file: no modified-side anchor';
      else if (state.viewerError) unavailable = `Inline editor unavailable: ${state.viewerError}`;
      else {
        const lineCount = state.fileContent.working.split(/\r\n|\r|\n/).length;
        if (thread.line_range.end > lineCount) unavailable = `Anchor range is outside modified lines 1–${lineCount}`;
      }
    }
    return { ...thread, unavailable: unavailable ?? null };
  });
  return { warning: state.comments?.warning ?? null, threads };
}

function textNode(document, tag, text, className = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// DOM moves/remounts blur native inputs. Restore only an input that actually
// had focus, and never override a later user focus choice during an async mount.
export function captureCommentFocus(document, root) {
  const active = document.activeElement;
  if (!active || !root?.contains?.(active)) return null;
  const { selectionStart, selectionEnd, selectionDirection } = active;
  return () => {
    if (active.isConnected === false) return;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== active) return;
    active.focus?.();
    if (Number.isInteger(selectionStart)) active.setSelectionRange?.(selectionStart, selectionEnd, selectionDirection);
  };
}

export function renderConversation(document, thread, { onReply, onSetResolved } = {}) {
  const article = document.createElement('article');
  const metadata = textNode(document, 'div', '', 'review-thread__metadata');
  const messages = document.createElement('div');
  messages.className = 'review-thread__messages';
  const actions = document.createElement('div');
  const resolutionActions = document.createElement('div');
  resolutionActions.className = 'review-thread__resolution';
  let updateResolution = () => {};
  let messageSnapshot = null;
  // Only the read-only history changes on refresh. The native form stays put,
  // preserving typing, focus, selection and a pending save across updates.
  article.updateThread = (next) => {
    thread = next;
    article.className = `review-thread${thread.resolved ? ' review-thread--resolved' : ''}`;
    article.setAttribute('aria-label', `Thread ${thread.id}, ${thread.resolved ? 'Resolved' : 'Open'}`);
    metadata.textContent = `${thread.resolved ? 'Resolved' : 'Open'} · ${Object.hasOwn(thread, 'file') ? `${thread.file}:${thread.line_range.start}–${thread.line_range.end}` : 'Comments without a file'}\n${thread.created_at}`;
    updateResolution();
    const snapshot = JSON.stringify(thread.messages);
    if (snapshot === messageSnapshot) return;
    messageSnapshot = snapshot;
    messages.replaceChildren(...[...thread.messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map((message) => {
      const item = document.createElement('section');
      item.replaceChildren(
        textNode(document, 'p', `${message.author} · ${message.created_at}`, 'review-thread__author'),
        textNode(document, 'p', message.text, 'review-thread__text'),
      );
      return item;
    }));
  };
  article.updateThread(thread);
  article.replaceChildren(metadata, messages, ...(onReply ? [actions] : []), ...(onSetResolved ? [resolutionActions] : []));
  if (onReply) {
    const reply = textNode(document, 'button', 'Reply');
    reply.type = 'button';
    reply.setAttribute('aria-expanded', 'false');
    let composer = null;
    let replyState = { blocked: false };
    article.updateReplyState = (next) => {
      replyState = next;
      composer?.setBlocked(next);
    };
    const close = () => {
      const focused = composer?.hasFocus();
      composer = null;
      reply.setAttribute('aria-expanded', 'false');
      actions.replaceChildren(reply);
      if (focused) reply.focus?.();
    };
    reply.addEventListener('click', () => {
      if (!composer) {
        composer = renderComposer(document, { label: `Reply to thread ${thread.id}`, saveLabel: 'Save reply', retryLabel: 'Retry reply',
          onSave: async (text) => { await onReply(text); close(); }, onCancel: close });
        composer.setBlocked(replyState);
        reply.setAttribute('aria-expanded', 'true');
        actions.replaceChildren(reply, composer.node);
      }
      composer.focus();
    });
    actions.replaceChildren(reply);
  }
  if (onSetResolved) {
    const toggle = textNode(document, 'button', '');
    toggle.type = 'button';
    const status = textNode(document, 'p', '', 'review-comments__warning');
    status.setAttribute('role', 'alert');
    let saving = false;
    let blocked = false;
    let warning = null;
    let error = null;
    let retryResolved = null;
    updateResolution = () => {
      const resolved = retryResolved ?? !thread.resolved;
      const action = resolved ? 'resolve' : 'reopen';
      toggle.textContent = retryResolved === null ? (resolved ? 'Resolve' : 'Reopen') : `Retry ${action}`;
      toggle.setAttribute('aria-label', `${retryResolved === null ? (resolved ? 'Resolve' : 'Reopen') : `Retry ${action}`} thread ${thread.id}`);
      toggle.disabled = saving || blocked;
      status.textContent = [error, warning].filter(Boolean).join('\n');
    };
    article.updateResolutionState = (next) => {
      blocked = next.blocked;
      warning = next.warning ?? null;
      updateResolution();
    };
    toggle.addEventListener('click', async () => {
      if (saving || blocked) return;
      const resolved = retryResolved ?? !thread.resolved;
      saving = true;
      error = null;
      updateResolution();
      try {
        await onSetResolved(resolved);
        retryResolved = null;
      } catch (err) {
        error = err.message;
        retryResolved = resolved;
      } finally {
        saving = false;
        updateResolution();
      }
    });
    resolutionActions.replaceChildren(toggle, status);
    updateResolution();
  }
  return article;
}

export function renderCommentIndex(document, { threads = [], warning = null }, { onSelectThread, onGeneralComments }) {
  const panel = document.createElement('section');
  panel.className = 'comment-index';
  panel.setAttribute('aria-label', 'Comment index');
  const general = textNode(document, 'button', 'Comments without a file', 'comment-index__button');
  general.type = 'button';
  general.addEventListener('click', () => onGeneralComments?.());
  const children = [general];
  if (warning) {
    const message = textNode(document, 'p', warning, 'review-comments__warning');
    message.setAttribute('role', 'status');
    children.push(message);
  }
  for (const thread of threads.filter((thread) => Object.hasOwn(thread, 'file'))) {
    const { start, end } = thread.line_range;
    const button = textNode(document, 'button', `${thread.file}:${start}${start === end ? '' : `–${end}`}`, 'comment-index__button');
    if (thread.resolved) button.className += ' comment-index__button--resolved';
    button.setAttribute('aria-label', `${button.textContent}, ${thread.resolved ? 'Resolved' : 'Open'}`);
    button.type = 'button';
    button.addEventListener('click', () => onSelectThread?.(thread.id));
    children.push(button);
  }
  panel.replaceChildren(...children);
  return panel;
}

export function renderConversationView(document, { threads = [], warning = null }, { general = false, conversation = (thread) => renderConversation(document, thread) } = {}) {
  const panel = document.createElement('section');
  panel.className = 'conversation-view';
  panel.setAttribute('aria-label', general ? 'Comments without a file' : 'Review conversation');
  panel.setAttribute('tabindex', '0');
  const children = [textNode(document, 'h2', general ? 'Comments without a file' : 'Review conversation')];
  if (warning) children.push(textNode(document, 'p', warning, 'review-comments__warning'));
  if (!threads.length) children.push(textNode(document, 'p', general ? 'No comments without a file.' : 'This conversation is no longer available.', 'empty'));
  for (const thread of threads) {
    if (thread.unavailable) children.push(textNode(document, 'p', thread.unavailable, 'review-comments__warning'));
    children.push(conversation(thread));
  }
  panel.replaceChildren(...children);
  return panel;
}

// A native form for a new comment on `line`, through `endLine` for a range.
// The caller owns the draft: `onInput` reports edits, and a rejected `onSave`
// shows its message as text while the typed text stays so it can be retried.
export function renderComposer(document, { line, endLine = line, text = '', error = null, label: labelText, saveLabel = 'Save comment', retryLabel, onInput, onSave, onCancel }) {
  const form = document.createElement('form');
  form.className = 'review-composer';
  const target = endLine > line ? `lines ${line}-${endLine}` : `line ${line}`;
  const description = labelText ?? `New comment on ${target}`;
  const label = textNode(document, 'label', description, 'review-composer__label');
  const textarea = document.createElement('textarea');
  textarea.className = 'review-composer__text';
  textarea.rows = 3;
  textarea.value = text;
  textarea.setAttribute('aria-label', description);
  textarea.addEventListener('input', () => onInput?.(textarea.value));
  const status = textNode(document, 'p', error ?? '', 'review-comments__warning');
  status.setAttribute('role', 'alert');
  const save = textNode(document, 'button', saveLabel);
  save.type = 'submit';
  const cancel = textNode(document, 'button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => onCancel?.());
  let saving = false;
  let blocked = false;
  let blockedMessage = null;
  let saveError = error;
  const setBlocked = ({ blocked: next, warning = null }) => {
    blocked = next;
    blockedMessage = warning;
    save.disabled = saving || blocked;
    status.textContent = blockedMessage ?? saveError ?? '';
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || blocked || textarea.value.trim() === '') return;
    saving = true;
    save.disabled = true;
    cancel.disabled = true;
    textarea.readOnly = true;
    status.textContent = '';
    try {
      await onSave(textarea.value);
      saveError = null;
    } catch (err) {
      saveError = err.message;
      status.textContent = blockedMessage ? `${err.message}\n${blockedMessage}` : err.message;
      if (retryLabel) save.textContent = retryLabel;
    } finally {
      saving = false;
      save.disabled = blocked;
      cancel.disabled = false;
      textarea.readOnly = false;
    }
  });
  const actions = document.createElement('div');
  actions.className = 'review-composer__actions';
  actions.replaceChildren(save, cancel);
  form.replaceChildren(label, textarea, status, actions);
  return { node: form, setBlocked, focus: () => textarea.focus?.(), hasFocus: () =>
    document.activeElement === textarea || document.activeElement === save || document.activeElement === cancel };
}
