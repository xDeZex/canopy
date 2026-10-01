// THROWAWAY #26: three inline review layouts on the real / route via ?variant=A/B/C.
// Winner B: can anchored user/agent threads make follow-up and resolution clear?
import { mountDiffEditor } from './monaco-view.js';
import { collectFiles } from './collect-files.js';

const variants = { A: 'Full-width conversation', B: 'Compact review rail', C: 'Paired context + feedback' };
const lineLabel = (anchor) => {
  const { start, end } = anchor.line_range ?? anchor;
  return start === end ? `L${start}` : `L${start}–${end}`;
};
const quote = (value) => JSON.stringify(value); // JSON double-quoted scalars are valid YAML.
const message = (author, text, created_at = new Date().toISOString()) => ({ id: crypto.randomUUID(), author, text, created_at });
const initialText = (thread) => thread.messages[0].text;

export function proposedYaml(threads) {
  if (!threads.length) return 'version: 1\nthreads: []\n';
  return `version: 1\nthreads:\n${threads.map((thread) => [
    `  - id: ${quote(thread.id)}`,
    `    file: ${quote(thread.file)}`,
    `    side: ${thread.side}`,
    `    line_range: { start: ${thread.line_range.start}, end: ${thread.line_range.end} }`,
    `    created_at: ${quote(thread.created_at)}`,
    `    resolved: ${thread.resolved}`,
    '    messages:',
    ...thread.messages.flatMap((item) => [
      `      - id: ${quote(item.id)}`,
      `        author: ${item.author}`,
      `        text: ${quote(item.text)}`,
      `        created_at: ${quote(item.created_at)}`,
    ]),
  ].join('\n')).join('\n')}\n`;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text, action, className = '') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

// Separate shapes; only the message/actions are shared. All remain inline view zones.
export function VariantA(meta, message, actions) {
  const card = node('article', 'prototype-card prototype-card--a');
  card.append(meta, message, actions);
  return card;
}

export function VariantB(meta, message, actions) {
  const card = node('article', 'prototype-card prototype-card--b');
  const rail = node('div', 'prototype-card__rail');
  rail.append(meta, actions);
  card.append(rail, message);
  return card;
}

export function VariantC(meta, message, actions, context) {
  const card = node('article', 'prototype-card prototype-card--c');
  const evidence = node('div', 'prototype-card__evidence');
  evidence.append(meta, node('pre', '', context));
  const feedback = node('div', 'prototype-card__feedback');
  feedback.append(node('strong', '', 'Feedback for your agent'), message, actions);
  card.append(evidence, feedback);
  return card;
}

export function PrototypeSwitcher(getVariant, setVariant) {
  const switcher = node('nav', 'prototype-switcher');
  switcher.setAttribute('aria-label', 'Throwaway prototype variants');
  const label = node('span', '');
  const step = (delta) => {
    const keys = Object.keys(variants);
    setVariant(keys[(keys.indexOf(getVariant()) + delta + keys.length) % keys.length]);
  };
  const previous = button('←', () => step(-1));
  previous.setAttribute('aria-label', 'Previous variant');
  const next = button('→', () => step(1));
  next.setAttribute('aria-label', 'Next variant');
  switcher.append(previous, label, next);
  document.body.append(switcher);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    // Monaco uses a read-only textarea: exclude the entire editor, not just typing inputs.
    if (event.target.closest?.('input, textarea, select, [contenteditable], .monaco-editor, [role="separator"]')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    step(event.key === 'ArrowLeft' ? -1 : 1);
  });
  return { render: () => { label.textContent = `THROWAWAY · ${getVariant()} / ${variants[getVariant()]}`; } };
}

export async function startCommentPrototype(startApp) {
  const stylesheet = node('link', '');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/prototype-comments.css';
  document.head.append(stylesheet);
  document.body.classList.add('prototype-comments-active');
  let variant = new URLSearchParams(location.search).get('variant');
  let app;
  let activeMount = null;
  let selectedRange = null;
  let draft = null;
  let lastAction = 'Started prototype (memory only)';
  let pendingJump = null;
  let mountedDiffOptions = null;
  const threadsByWorktree = new Map();
  const replyDrafts = new Map();
  const getState = () => app?.workspace.getState() ?? {};
  const ordered = (path = getState().activePath) => [...(threadsByWorktree.get(path) ?? [])]
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const tools = node('section', 'prototype-tools');
  const heading = node('strong', '', 'INLINE THREADS · B SELECTED · THROWAWAY / MEMORY ONLY');
  const picker = node('div', 'prototype-picker');
  const menu = node('div', 'prototype-picker__menu');
  menu.hidden = true;
  const trigger = button('Comments ▾', () => { menu.hidden = !menu.hidden; });
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', () => trigger.setAttribute('aria-expanded', String(!menu.hidden)));
  picker.append(trigger, menu);
  const add = button('Comment on selection', () => {
    if (activeMount) activeMount.compose(selectedRange ?? { start: 1, end: 1 });
  });
  const hint = node('span', 'prototype-hint', 'Drag/select code, then click + in the gutter. Shift-click + to extend a range. Modified side only.');
  tools.append(heading, picker, add, hint);
  document.querySelector('.workspace-content').prepend(tools);

  const inspector = node('section', 'prototype-inspector');
  const status = node('div', 'prototype-inspector__status');
  const yaml = node('pre', 'prototype-yaml');
  const stateJson = node('pre', 'prototype-state');
  const stateDetails = node('details', '');
  stateDetails.append(node('summary', '', 'Full relevant state (also window.__canopyCommentPrototype)'), stateJson);
  inspector.append(status, yaml, stateDetails);
  document.querySelector('#app').append(inspector);

  function publish(action = lastAction) {
    lastAction = action;
    const { activePath = null, activeFile = null, fileContent } = getState();
    const comments = ordered();
    const state = {
      variant, activeWorktree: activePath, activeFile, anchorSide: 'modified',
      selectedRange, draft, pendingJump, lastAction,
      diffLoaded: Boolean(activeMount), comparisonHasContent: Boolean(fileContent),
      diffOptions: mountedDiffOptions,
      comparisonRef: app?.workspace.commitLock.getLockedCommit(activePath) ?? 'HEAD',
      threadsByWorktree: Object.fromEntries(threadsByWorktree), replyDrafts: Object.fromEntries(replyDrafts),
      yaml: proposedYaml(comments), persistence: 'in-memory; reload resets; no filesystem writes',
    };
    window.__canopyCommentPrototype = state;
    stateJson.textContent = JSON.stringify(state, null, 2);
    yaml.textContent = `# Proposed ${activePath ?? '(select worktree)'}/.canopy/comments.yaml\n${state.yaml}`;
    status.textContent = `${variant}: ${variants[variant]} · ${activeFile ?? 'Select a real file, then Diff'} · ${selectedRange ? lineLabel(selectedRange) : 'no range selected'} · ${action}`;
    trigger.textContent = `${comments.length} worktree threads ▾`;
    add.disabled = !activeMount;
    const items = comments.map((comment) => {
      const item = button(`${comment.resolved ? '✓ Resolved' : '○ Open'} · ${comment.file}:${lineLabel(comment)}\n${initialText(comment).slice(0, 120)}\n${comment.created_at}`, () => jump(comment), 'prototype-picker__item');
      item.classList.toggle('is-resolved', comment.resolved);
      return item;
    });
    menu.replaceChildren(...(items.length ? items : [node('p', '', 'No comments yet. Select a file in Diff mode.')]));
    switcher.render();
  }

  function change(id, transform, action) {
    const path = getState().activePath;
    threadsByWorktree.set(path, ordered(path).flatMap((comment) => comment.id === id ? (transform(comment) ?? []) : comment));
    activeMount?.renderZones();
    publish(action);
  }

  function setVariant(next) {
    variant = next;
    const url = new URL(location.href);
    url.searchParams.set('variant', variant);
    history.replaceState(null, '', url);
    activeMount?.renderZones();
    publish(`Switched to ${variant}; comments retained`);
  }
  const switcher = PrototypeSwitcher(() => variant, setVariant);
  window.addEventListener('popstate', () => {
    const next = new URLSearchParams(location.search).get('variant');
    if (variants[next]) { variant = next; activeMount?.renderZones(); publish('URL navigation'); }
    else location.reload();
  });
  document.addEventListener('click', (event) => {
    if (!picker.contains(event.target)) { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
  });

  function jump(comment) {
    pendingJump = comment;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    app.onViewModeChanged('diff');
    if (getState().activeFile !== comment.file) app.workspace.selectFile(comment.file);
    else activeMount?.jump(comment);
    publish(`Jump to ${comment.file}:${lineLabel(comment)}`);
  }

  function attach(diff, context) {
    const editor = diff.getModifiedEditor();
    const model = editor.getModel();
    const maxLine = model.getLineCount();
    const { activePath: path, activeFile: file } = context;
    if (!threadsByWorktree.has(path)) {
      const firstEnd = Math.min(3, maxLine);
      const otherFile = collectFiles(context.fileTree ?? []).find((item) => item.path !== file)?.path;
      const seedTime = Date.now() - 60_000;
      const createdAt = (offset) => new Date(seedTime + offset).toISOString();
      const sample = (targetFile, start, end, text, offset, resolved = false) => ({
        id: crypto.randomUUID(), file: targetFile, side: 'modified', line_range: { start, end },
        created_at: createdAt(offset), resolved, messages: [message('user', text, createdAt(offset))],
      });
      const open = sample(file, Math.min(2, maxLine), firstEnd, 'Please explain this change and make the intent clear to the next reviewer.', 0);
      open.messages.push(message('agent', 'Should the explanation cover the fallback path too? Is this resolved, or would you like more detail?', createdAt(3)));
      const resolved = sample(file, Math.min(6, maxLine), Math.min(6, maxLine), 'Please clarify the original concern here.', 1, true);
      resolved.messages.push(message('agent', 'I clarified the intent and addressed the concern. Resolving this thread for review.', createdAt(4)));
      threadsByWorktree.set(path, [open, resolved,
        ...(otherFile ? [sample(otherFile, 1, 1, 'Cross-file review: check that this agrees with the changed behavior.', 2)] : []),
      ]);
    }
    editor.updateOptions({ glyphMargin: true });
    const gutter = editor.createDecorationsCollection([{
      range: new monaco.Range(1, 1, maxLine, 1),
      options: { isWholeLine: true, glyphMarginClassName: 'prototype-gutter-plus', glyphMarginHoverMessage: { value: 'Add inline comment. Select text first, or Shift-click to extend range.' } },
    }]);
    let zones = [];
    let disposed = false;
    let rangeOrigin = 1;
    let selectionDecoration = editor.createDecorationsCollection();
    const observers = [];
    const currentComments = () => ordered(path).filter((comment) => comment.file === file);

    function select(range) {
      selectedRange = range;
      selectionDecoration.set([{
        range: new monaco.Range(range.start, 1, range.end, model.getLineMaxColumn(range.end)),
        options: { isWholeLine: true, className: 'prototype-selected-range' },
      }]);
      publish('Range selected');
    }

    function compose(range) {
      const start = Math.max(1, Math.min(maxLine, range.start));
      const end = Math.max(start, Math.min(maxLine, range.end));
      select({ start, end });
      draft = { file, start, end, text: '' };
      renderZones();
      publish('New inline draft');
      requestAnimationFrame(() => editor.getDomNode().querySelector('.prototype-composer textarea')?.focus());
    }

    function commentCard(comment) {
      const meta = node('div', 'prototype-card__meta');
      meta.append(node('strong', '', `${comment.resolved ? '✓ Resolved' : '○ Open'} · ${lineLabel(comment)}`), node('time', '', comment.created_at));
      const conversation = node('div', 'prototype-conversation');
      const messages = node('ol', 'prototype-messages');
      for (const item of comment.messages) {
        const entry = node('li', 'prototype-message');
        const header = node('div', 'prototype-message__meta');
        const time = node('time', '', item.created_at);
        time.dateTime = item.created_at;
        header.append(node('strong', '', item.author === 'user' ? 'User' : 'Agent'), time);
        entry.append(header, node('p', 'prototype-card__message', item.text));
        messages.append(entry);
      }
      conversation.append(messages, replyForm(comment));
      const actions = node('div', 'prototype-card__actions');
      const asks = button('Agent asks', () => change(comment.id, (thread) => ({
        ...thread, resolved: false, messages: [...thread.messages, message('agent', 'Would you like more detail on this change? Is this resolved?')],
      }), 'Simulated agent follow-up on this thread; still open'));
      const resolves = button('Agent resolves', () => change(comment.id, (thread) => ({
        ...thread, resolved: true, messages: [...thread.messages, message('agent', 'I addressed the feedback and clarified the change. Resolving this thread.')],
      }), 'Simulated agent response + resolution on this thread'));
      resolves.disabled = comment.resolved;
      const simulation = node('div', 'prototype-agent-actions');
      simulation.append(node('span', '', 'Simulate this thread'), asks, resolves);
      conversation.append(simulation);
      actions.append(
        button('Delete thread', () => {
          replyDrafts.delete(comment.id);
          change(comment.id, () => null, 'Deleted entire thread (memory only)');
        }),
        button(comment.resolved ? 'Reopen' : 'Resolve', () => change(comment.id, (thread) => ({ ...thread, resolved: !thread.resolved }), comment.resolved ? 'User reopened thread' : 'User resolved thread')),
      );
      const { start, end } = comment.line_range;
      const contextText = model.getLinesContent().slice(start - 1, end).map((text, index) => `${start + index}  ${text}`).join('\n');
      const card = variant === 'A' ? VariantA(meta, conversation, actions)
        : variant === 'B' ? VariantB(meta, conversation, actions) : VariantC(meta, conversation, actions, contextText);
      card.dataset.commentId = comment.id;
      card.classList.toggle('is-resolved', comment.resolved);
      return card;
    }

    function replyForm(thread) {
      const form = node('form', 'prototype-reply');
      const label = node('label', '', `Reply as user · ${lineLabel(thread)}`);
      const input = node('textarea', '');
      input.value = replyDrafts.get(thread.id) ?? '';
      input.rows = 2;
      input.required = true;
      input.placeholder = 'Continue this conversation…';
      input.addEventListener('input', () => { replyDrafts.set(thread.id, input.value); publish('Reply draft changed'); });
      label.append(input);
      const submit = button('Reply', () => {});
      submit.type = 'submit';
      form.append(label, submit, node('span', 'prototype-reply__hint', thread.resolved ? 'Reply reopens this thread.' : 'Reply keeps this thread open.'));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        const text = input.value;
        replyDrafts.delete(thread.id);
        change(thread.id, (current) => ({ ...current, resolved: false, messages: [...current.messages, message('user', text)] }), 'User replied; thread open');
      });
      return form;
    }

    function composerCard() {
      const card = node('form', 'prototype-composer');
      const label = node('label', '', `New thread · ${lineLabel(draft)} (modified side)`);
      const input = node('textarea', '');
      input.value = draft.text;
      input.placeholder = 'Tell your agent what to change…';
      input.rows = 3;
      input.required = true;
      input.setAttribute('aria-label', 'Comment text');
      input.addEventListener('input', () => { draft.text = input.value; publish('Draft text changed'); });
      label.append(input);
      const save = button('Save comment', () => {});
      save.type = 'submit';
      card.append(label, save, button('Cancel', () => { draft = null; renderZones(); publish('Draft cancelled'); }));
      card.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!draft.text.trim()) return;
        const saved = { ...draft };
        draft = null;
        const created_at = new Date().toISOString();
        threadsByWorktree.set(path, [...ordered(path), { id: crypto.randomUUID(), file, side: 'modified', line_range: { start: saved.start, end: saved.end }, created_at, resolved: false, messages: [message('user', saved.text, created_at)] }]);
        renderZones();
        publish('Created comment (memory only)');
      });
      return card;
    }

    function renderZones() {
      if (disposed) return;
      observers.splice(0).forEach((observer) => observer.disconnect());
      editor.changeViewZones((accessor) => {
        zones.forEach((id) => accessor.removeZone(id));
        zones = [];
        const groups = new Map();
        for (const comment of currentComments()) {
          const anchor = Math.min(comment.line_range.end, maxLine);
          if (!groups.has(anchor)) groups.set(anchor, []);
          groups.get(anchor).push(commentCard(comment));
        }
        if (draft?.file === file) {
          const anchor = draft.end;
          if (!groups.has(anchor)) groups.set(anchor, []);
          groups.get(anchor).push(composerCard());
        }
        for (const [anchor, cards] of groups) {
          const zoneNode = node('div', `prototype-zone prototype-zone--${variant.toLowerCase()}`);
          const content = node('div', 'prototype-zone__content');
          content.style.width = `${Math.max(120, editor.getLayoutInfo().contentWidth - 16)}px`;
          content.append(...cards);
          zoneNode.append(content);
          // Keep native focus/selection: true makes Monaco preventDefault and focus its own input.
          const zone = { afterLineNumber: anchor, heightInPx: 160 * cards.length, domNode: zoneNode, suppressMouseDown: false, showInHiddenAreas: true };
          const id = accessor.addZone(zone);
          zones.push(id);
          const observer = new ResizeObserver(() => {
            const height = Math.ceil(content.getBoundingClientRect().height) + 12;
            if (height > 12 && height !== zone.heightInPx && !disposed) {
              zone.heightInPx = height;
              editor.changeViewZones((next) => next.layoutZone(id));
            }
          });
          observer.observe(content);
          observers.push(observer);
        }
      });
    }

    const selectionListener = editor.onDidChangeCursorSelection((event) => {
      const selection = event.selection;
      if (!selection) return;
      rangeOrigin = selection.selectionStartLineNumber;
      select({ start: selection.startLineNumber, end: selection.endLineNumber });
    });
    const mouseListener = editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      if (!line) return;
      event.event.preventDefault();
      const selection = editor.getSelection();
      const range = event.event.shiftKey
        ? { start: Math.min(rangeOrigin, line), end: Math.max(rangeOrigin, line) }
        : selection && !selection.isEmpty() && line >= selection.startLineNumber && line <= selection.endLineNumber
          ? { start: selection.startLineNumber, end: selection.endLineNumber }
          : { start: line, end: line };
      if (!event.event.shiftKey) rangeOrigin = range.start;
      compose(range);
    });
    const layoutListener = editor.onDidLayoutChange(() => {
      editor.getDomNode().querySelectorAll('.prototype-zone__content').forEach((content) => {
        content.style.width = `${Math.max(120, editor.getLayoutInfo().contentWidth - 16)}px`;
      });
    });
    const mount = {
      compose, renderZones,
      jump(comment) {
        const start = Math.min(comment.line_range.start, maxLine);
        const end = Math.min(comment.line_range.end, maxLine);
        editor.revealLinesInCenter(start, end);
        editor.setSelection(new monaco.Range(start, 1, end, model.getLineMaxColumn(end)));
        selectedRange = { start, end };
        pendingJump = null;
        publish('Jumped to inline comment');
      },
      dispose() {
        disposed = true;
        observers.forEach((observer) => observer.disconnect());
        selectionListener.dispose();
        mouseListener.dispose();
        layoutListener.dispose();
        gutter.clear();
        selectionDecoration.clear();
        if (activeMount === mount) { activeMount = null; selectedRange = null; draft = null; publish('Viewer changed'); }
      },
    };
    activeMount = mount;
    renderZones();
    if (pendingJump?.file === file) mount.jump(pendingJump);
    publish('Real Monaco diff attached; sample comments seeded only once per worktree');
    return mount;
  }

  await startApp({
    onReady: (owners) => { app = owners; },
    onWorkspaceChange: () => publish('Workspace updated'),
    mountDiffEditor: (container, options) => {
      const context = { ...getState() };
      mountedDiffOptions = { mode: options.mode, autoScroll: options.autoScroll, wrap: options.wrap };
      return mountDiffEditor(container, { ...options, onMount: (diff) => attach(diff, context) });
    },
  });
  publish();
}
