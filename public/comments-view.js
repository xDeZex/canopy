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

export function renderConversation(document, thread) {
  const article = document.createElement('article');
  article.className = `review-thread${thread.resolved ? ' review-thread--resolved' : ''}`;
  article.setAttribute('aria-label', `Thread ${thread.id}, ${thread.resolved ? 'Resolved' : 'Open'}`);
  const metadata = textNode(document, 'div',
    `${thread.resolved ? 'Resolved' : 'Open'} · ${Object.hasOwn(thread, 'file') ? `${thread.file}:${thread.line_range.start}–${thread.line_range.end}` : 'Comments without a file'}\n${thread.created_at}`,
    'review-thread__metadata');
  const messages = document.createElement('div');
  messages.className = 'review-thread__messages';
  messages.replaceChildren(...thread.messages.map((message) => {
    const item = document.createElement('section');
    item.replaceChildren(
      textNode(document, 'p', `${message.author} · ${message.created_at}`, 'review-thread__author'),
      textNode(document, 'p', message.text, 'review-thread__text'),
    );
    return item;
  }));
  article.replaceChildren(metadata, messages);
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
    button.type = 'button';
    button.addEventListener('click', () => onSelectThread?.(thread.id));
    children.push(button);
  }
  panel.replaceChildren(...children);
  return panel;
}

export function renderConversationView(document, { threads = [], warning = null }, { general = false } = {}) {
  const panel = document.createElement('section');
  panel.className = 'conversation-view';
  panel.setAttribute('aria-label', general ? 'Comments without a file' : 'Review conversation');
  panel.setAttribute('tabindex', '0');
  const children = [textNode(document, 'h2', general ? 'Comments without a file' : 'Review conversation')];
  if (warning) children.push(textNode(document, 'p', warning, 'review-comments__warning'));
  if (!threads.length) children.push(textNode(document, 'p', general ? 'No comments without a file.' : 'This conversation is no longer available.', 'empty'));
  for (const thread of threads) {
    if (thread.unavailable) children.push(textNode(document, 'p', thread.unavailable, 'review-comments__warning'));
    children.push(renderConversation(document, thread));
  }
  panel.replaceChildren(...children);
  return panel;
}
