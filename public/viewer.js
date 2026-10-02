// Owns #main's visible state and the lifecycle of its Monaco controller.
import { commentsForView, renderConversation, renderConversationView, captureCommentFocus } from './comments-view.js';

export function createViewer({ mainEl, document, getState, getViewMode, getDiffRenderMode, mountEditor, mountDiffEditor, languageForPath, getAutoScroll, getWrap, addComment, addReply, setThreadResolved }) {
  let currentView = null;
  let generation = 0;
  let viewerError = null;
  let showingConversation = false;
  let disposed = false;
  // An unsaved comment belongs to one file of one worktree. It outlives
  // editor remounts (live file updates) but not a change of file or worktree.
  let draft = null;
  // Reply drafts are native forms owned by a worktree/thread, not by an
  // editor mount or an anchor. Keep their DOM through navigation/remounts.
  const conversations = new Map();
  let pendingReplyFocus = null;
  function conversation(thread) {
    const worktree = getState().activePath;
    const key = JSON.stringify([worktree, thread.id]);
    let article = conversations.get(key);
    if (!article) {
      article = renderConversation(document, thread, { ...(addReply ? { onReply: async (text) => {
        if (getState().activePath !== worktree) throw new Error('The active worktree changed; return to this conversation to retry');
        await addReply({ threadId: thread.id, text, worktree });
      } } : {}), ...(setThreadResolved ? { onSetResolved: async (resolved) => {
        if (getState().activePath !== worktree) throw new Error('The active worktree changed; return to this conversation to retry');
        await setThreadResolved({ threadId: thread.id, resolved, worktree });
      } } : {}) });
      conversations.set(key, article);
    } else article.updateThread(thread);
    const comments = getState().comments;
    const mutationState = { blocked: Boolean(comments?.warning) || typeof comments?.revision !== 'string',
      warning: comments?.warning ? `Cannot save until comments refresh successfully: ${comments.warning}` :
        typeof comments?.revision !== 'string' ? 'Comments are still loading; wait before saving' : null };
    article.updateReplyState?.(mutationState);
    article.updateResolutionState?.(mutationState);
    return article;
  }

  function currentComments() {
    return commentsForView({ ...getState(), viewerError });
  }
  function inlineThreads(comments) {
    return comments.threads.filter((thread) => Object.hasOwn(thread, 'file') && !thread.unavailable);
  }
  function selectedThread(comments) {
    return comments.threads.find((thread) => thread.id === getState().selectedThreadId);
  }
  function needsConversation(comments) {
    return getState().mainView === 'general' || Boolean(selectedThread(comments)?.unavailable);
  }
  // Navigation reveals the selected thread; a live refresh must not move the reader.
  function updateEditor(comments, { reveal = true } = {}) {
    if (addReply || setThreadResolved) inlineThreads(comments).forEach(conversation);
    currentView?.updateThreads?.(inlineThreads(comments));
    const selected = selectedThread(comments);
    if (reveal && selected && !selected.unavailable) currentView?.revealThread?.(selected.id);
  }
  function refreshComments({ reveal = true } = {}) {
    if (disposed) return;
    const comments = currentComments();
    if (showingConversation || needsConversation(comments)) render({ preserveError: true });
    else updateEditor(comments, { reveal });
  }

  function render({ preserveError = false } = {}) {
    if (disposed) return;
    const newlyFocused = [...conversations].map(([key, article]) => ({ key, restore: captureCommentFocus(document, article) })).find((entry) => entry.restore);
    if (newlyFocused) pendingReplyFocus = newlyFocused;
    else if (document.activeElement && document.activeElement !== document.body) pendingReplyFocus = null;
    if (pendingReplyFocus && JSON.parse(pendingReplyFocus.key)[0] !== getState().activePath) pendingReplyFocus = null;
    const focused = pendingReplyFocus;
    const restoreFocus = () => {
      if (!focused) return;
      pendingReplyFocus = null;
      const [path, id] = JSON.parse(focused.key);
      const state = getState();
      if (path !== state.activePath) return;
      const comments = currentComments();
      const visible = showingConversation
        ? comments.threads.filter((thread) => state.mainView === 'general' ? !Object.hasOwn(thread, 'file') : thread.id === state.selectedThreadId)
        : inlineThreads(comments);
      if (visible.some((thread) => thread.id === id)) focused.restore();
    };
    // Invalidate pending mounts before touching the DOM; a late resolution
    // must dispose its own controller, never replace the latest one.
    const thisRender = ++generation;
    // An obsolete asynchronous mount must not move a retained form out of the
    // latest editor before its stale controller is disposed.
    const mountConversation = (thread) => thisRender === generation ? conversation(thread) : renderConversation(document, thread);
    currentView?.dispose();
    currentView = null;
    if (!preserveError) viewerError = null;

    const { activeFile, worktrees, activePath, fileContent, fileContentError } = getState();
    if (draft && (draft.worktree !== activePath || draft.file !== activeFile)) draft = null;
    const composer = addComment && {
      draft: draft && { line: draft.line, endLine: draft.endLine, text: draft.text, error: draft.error },
      onChange: (next) => { draft = next && { ...next, worktree: getState().activePath, file: getState().activeFile }; },
      // Record a failure on the draft too: a remount may already have replaced
      // the composer that would otherwise show it.
      save: async ({ line, endLine, text }) => {
        try {
          await addComment({ file: getState().activeFile, line, endLine, text });
        } catch (err) {
          if (draft) draft = { ...draft, error: err.message };
          throw err;
        }
      },
    };
    const comments = currentComments();
    const threads = inlineThreads(comments);
    showingConversation = needsConversation(comments);
    const replaceMain = (node) => {
      mainEl.replaceChildren(node);
    };
    function showMessage(text, viewer = false) {
      mainEl.classList.toggle('main--viewer', viewer);
      const message = document.createElement('p');
      message.className = 'empty';
      message.textContent = text;
      replaceMain(message);
    }

    if (showingConversation) {
      const general = getState().mainView === 'general';
      mainEl.classList.toggle('main--viewer', false);
      replaceMain(renderConversationView(document, { ...comments,
        threads: general ? comments.threads.filter((thread) => !Object.hasOwn(thread, 'file')) : [selectedThread(comments)],
      }, { general, conversation }));
      restoreFocus?.();
      return;
    }

    if (!activeFile) {
      const active = worktrees.find((worktree) => worktree.path === activePath);
      showMessage(active ? 'Select a file to view its diff.' : 'No worktrees found.');
      return;
    }
    if (fileContentError) {
      showMessage(`Failed to load file: ${fileContentError.message}`);
      return;
    }
    if (!fileContent) {
      showMessage('Loading file…');
      return;
    }

    mainEl.classList.add('main--viewer');
    const container = document.createElement('div');
    container.className = 'viewer__editor';
    replaceMain(container);
    const mode = getViewMode();
    if (mode === 'file' && fileContent.working === null) {
      // Deleted on disk: there is no current content to show in File mode.
      const message = document.createElement('p');
      message.className = 'empty';
      message.textContent = 'This file was deleted from the working tree.';
      container.replaceChildren(message);
      return;
    }

    async function mount() {
      try {
        const language = languageForPath(activeFile);
        const view = mode === 'file'
          ? await mountEditor(container, { content: fileContent.working, language, wrap: getWrap(), document,
              ...(threads.length ? { threads } : {}), ...(composer ? { composer } : {}), ...(addReply || setThreadResolved ? { conversation: mountConversation } : {}) })
          : await mountDiffEditor(container, {
              original: fileContent.head ?? '',
              modified: fileContent.working ?? '',
              language,
              mode: getDiffRenderMode(),
              autoScroll: getAutoScroll(),
              wrap: getWrap(),
              document,
              ...(threads.length ? { threads } : {}),
              ...(composer ? { composer } : {}),
              ...(addReply || setThreadResolved ? { conversation: mountConversation } : {}),
            });
        if (thisRender !== generation) view.dispose();
        else {
          currentView = view;
          viewerError = null;
          updateEditor(currentComments());
          restoreFocus();
        }
      } catch (err) {
        if (thisRender === generation) {
          console.error('Failed to mount file viewer', err);
          viewerError = err.message;
          const message = document.createElement('p');
          message.className = 'empty';
          message.textContent = `Failed to mount file viewer: ${err.message}`;
          container.replaceChildren(message);
          refreshComments();
        }
      }
    }
    void mount();
  }

  // Missing capabilities and unmounted views are a no-op.
  const forward = (name) => () => currentView?.[name]?.();
  return {
    render,
    refreshComments,
    dispose() { disposed = true; generation++; currentView?.dispose(); currentView = null; conversations.clear(); },
    nextChange: forward('nextChange'),
    prevChange: forward('prevChange'),
    addComment: forward('addComment'),
    scrollUp: forward('scrollUp'),
    scrollDown: forward('scrollDown'),
  };
}
