// Owns #main's visible state and the lifecycle of its Monaco controller.
import { commentsForView, renderConversation, renderConversationView, captureCommentFocus } from './comments-view.js';
import { hasFileAnchor } from './comment-dom.js';
import type { CommentThread, Comments } from './comment-dom.js';
import type { FileNode } from './collect-files.js';
import { errorMessage } from './editor-port.js';
import type { ViewerNode, ViewerDocument, ViewerController, EditorOptions, DiffOptions, Draft, CommentInput, Composer } from './editor-port.js';

export interface ViewerState {
  activeFile: string | null; activePath: string | null; worktrees: { path: string | null }[];
  fileContent: { head: string | null; working: string | null } | null;
  fileContentError?: { message: string } | null; fileTree?: FileNode[];
  comments?: Comments & { revision?: string | null }; mainView?: string; selectedThreadId?: string | null;
}
export interface ReplyInput { threadId: string; text: string; worktree: string | null }
export interface ResolutionInput { threadId: string; resolved: boolean; worktree: string | null }
export interface ViewerOptions<E> {
  mainEl: E; document: ViewerDocument<E>; getState(): ViewerState;
  getViewMode(): string; getDiffRenderMode(): string; getAutoScroll(): boolean; getWrap(): boolean;
  mountEditor?(container: E, options: EditorOptions<E>): Promise<ViewerController>;
  mountDiffEditor(container: E, options: DiffOptions<E>): Promise<ViewerController>;
  languageForPath(path: string): string;
  addComment?(input: CommentInput & { file: string | null }): Promise<unknown>;
  addReply?(input: ReplyInput): Promise<unknown>;
  setThreadResolved?(input: ResolutionInput): Promise<unknown>;
}

export function createViewer<E extends ViewerNode<E>>({ mainEl, document, getState, getViewMode, getDiffRenderMode, mountEditor, mountDiffEditor, languageForPath, getAutoScroll, getWrap, addComment, addReply, setThreadResolved }: ViewerOptions<E>) {
  let currentView: ViewerController | null = null;
  let generation = 0;
  let viewerError: string | null = null;
  let showingConversation = false;
  let disposed = false;
  // An unsaved comment belongs to one file of one worktree. It outlives
  // editor remounts (live file updates) but not a change of file or worktree.
  let draft: (Draft & { worktree: string | null; file: string | null }) | null = null;
  // Reply drafts are native forms owned by a worktree/thread, not by an
  // editor mount or an anchor. Keep their DOM through navigation/remounts.
  const conversations = new Map<string, { article: ReturnType<typeof renderConversation<E>>; worktree: string | null; id: string }>();
  let pendingReplyFocus: { worktree: string | null; id: string; restore: () => void } | null = null;
  function conversation(thread: CommentThread) {
    const worktree = getState().activePath;
    const key = JSON.stringify([worktree, thread.id]);
    let article = conversations.get(key)?.article;
    if (!article) {
      article = renderConversation(document, thread, { ...(addReply ? { onReply: async (text) => {
        if (getState().activePath !== worktree) throw new Error('The active worktree changed; return to this conversation to retry');
        await addReply({ threadId: thread.id, text, worktree });
      } } : {}), ...(setThreadResolved ? { onSetResolved: async (resolved) => {
        if (getState().activePath !== worktree) throw new Error('The active worktree changed; return to this conversation to retry');
        await setThreadResolved({ threadId: thread.id, resolved, worktree });
      } } : {}) });
      conversations.set(key, { article, worktree, id: thread.id });
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
  function inlineThreads(comments: Comments) {
    return comments.threads.filter((thread) => hasFileAnchor(thread) && !thread.unavailable);
  }
  function selectedThread(comments: Comments) {
    return comments.threads.find((thread) => thread.id === getState().selectedThreadId);
  }
  function needsConversation(comments: Comments) {
    return getState().mainView === 'general' || Boolean(selectedThread(comments)?.unavailable);
  }
  // Navigation reveals the selected thread; a live refresh must not move the reader.
  function updateEditor(comments: Comments, { reveal = true } = {}) {
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
    const newlyFocused = [...conversations.values()].map(({ article, worktree, id }) => ({ worktree, id, restore: captureCommentFocus(document, article) })).find((entry) => entry.restore);
    if (newlyFocused?.restore) {
      pendingReplyFocus = { ...newlyFocused, restore: newlyFocused.restore };
    } else if (document.activeElement && document.activeElement !== document.body) pendingReplyFocus = null;
    if (pendingReplyFocus && pendingReplyFocus.worktree !== getState().activePath) pendingReplyFocus = null;
    const focused = pendingReplyFocus;
    const restoreFocus = () => {
      if (!focused) return;
      pendingReplyFocus = null;
      const { worktree: path, id } = focused;
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
    const mountConversation = (thread: CommentThread) => thisRender === generation ? conversation(thread) : renderConversation(document, thread);
    currentView?.dispose();
    currentView = null;
    if (!preserveError) viewerError = null;

    const { activeFile, worktrees, activePath, fileContent, fileContentError } = getState();
    if (draft && (draft.worktree !== activePath || draft.file !== activeFile)) draft = null;
    const composer: Composer | undefined = addComment && {
      draft: draft && { line: draft.line, endLine: draft.endLine, text: draft.text, error: draft.error },
      onChange: (next) => { draft = next && { ...next, worktree: getState().activePath, file: getState().activeFile }; },
      // Record a failure on the draft too: a remount may already have replaced
      // the composer that would otherwise show it.
      save: async ({ line, endLine, text }) => {
        try {
          await addComment({ file: getState().activeFile, line, endLine, text });
        } catch (err) {
          if (draft) draft = { ...draft, error: errorMessage(err) };
          throw err;
        }
      },
    };
    const comments = currentComments();
    const threads = inlineThreads(comments);
    showingConversation = needsConversation(comments);
    const replaceMain = (node: E) => {
      mainEl.replaceChildren(node);
    };
    function showMessage(text: string, viewer = false) {
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
        threads: general ? comments.threads.filter((thread) => !hasFileAnchor(thread)) : comments.threads.filter((thread) => thread.id === getState().selectedThreadId),
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

    const path = activeFile;
    const content = fileContent;
    async function mount() {
      try {
        const language = languageForPath(path);
        const view = mode === 'file'
          ? await mountEditor?.(container, { content: content.working, language, wrap: getWrap(), document,
              ...(threads.length ? { threads } : {}), ...(composer ? { composer } : {}), ...(addReply || setThreadResolved ? { conversation: mountConversation } : {}) })
          : await mountDiffEditor(container, {
              original: content.head ?? '',
              modified: content.working ?? '',
              language,
              mode: getDiffRenderMode(),
              autoScroll: getAutoScroll(),
              wrap: getWrap(),
              document,
              ...(threads.length ? { threads } : {}),
              ...(composer ? { composer } : {}),
              ...(addReply || setThreadResolved ? { conversation: mountConversation } : {}),
            });
        if (!view) throw new Error('File editor mounting is unavailable');
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
          viewerError = errorMessage(err);
          const message = document.createElement('p');
          message.className = 'empty';
          message.textContent = `Failed to mount file viewer: ${viewerError}`;
          container.replaceChildren(message);
          refreshComments();
        }
      }
    }
    void mount();
  }

  // Missing capabilities and unmounted views are a no-op.
  const forward = (name: 'nextChange' | 'prevChange' | 'addComment' | 'scrollUp' | 'scrollDown') => () => currentView?.[name]?.();
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
