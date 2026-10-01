// Owns #main's visible state and the lifecycle of its Monaco controller.
import { commentsForView, renderConversationView } from './comments-view.js';

export function createViewer({ mainEl, document, getState, getViewMode, getDiffRenderMode, mountEditor, mountDiffEditor, languageForPath, getAutoScroll, getWrap, addComment }) {
  let currentView = null;
  let generation = 0;
  let viewerError = null;
  let showingConversation = false;
  let disposed = false;
  // An unsaved comment belongs to one file of one worktree. It outlives
  // editor remounts (live file updates) but not a change of file or worktree.
  let draft = null;

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
    // Invalidate pending mounts before touching the DOM; a late resolution
    // must dispose its own controller, never replace the latest one.
    const thisRender = ++generation;
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
      }, { general }));
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
              ...(threads.length ? { threads } : {}), ...(composer ? { composer } : {}) })
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
            });
        if (thisRender !== generation) view.dispose();
        else {
          currentView = view;
          viewerError = null;
          updateEditor(currentComments());
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
    dispose() { disposed = true; generation++; currentView?.dispose(); currentView = null; },
    nextChange: forward('nextChange'),
    prevChange: forward('prevChange'),
    addComment: forward('addComment'),
    scrollUp: forward('scrollUp'),
    scrollDown: forward('scrollDown'),
  };
}
