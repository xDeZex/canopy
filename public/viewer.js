// Owns #main's visible state and the lifecycle of its Monaco controller.
export function createViewer({ mainEl, document, getState, getViewMode, getDiffRenderMode, mountEditor, mountDiffEditor, languageForPath, getAutoScroll, getWrap }) {
  let currentView = null;
  let generation = 0;

  function render() {
    // Invalidate pending mounts before touching the DOM; a late resolution
    // must dispose its own controller, never replace the latest one.
    const thisRender = ++generation;
    currentView?.dispose();
    currentView = null;

    const { activeFile, worktrees, activePath, fileContent, fileContentError } = getState();
    function showMessage(text, viewer = false) {
      mainEl.classList.toggle('main--viewer', viewer);
      const message = document.createElement('p');
      message.className = 'empty';
      message.textContent = text;
      mainEl.replaceChildren(message);
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
    mainEl.replaceChildren(container);
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
          ? await mountEditor(container, { content: fileContent.working, language, wrap: getWrap() })
          : await mountDiffEditor(container, {
              original: fileContent.head ?? '',
              modified: fileContent.working ?? '',
              language,
              mode: getDiffRenderMode(),
              autoScroll: getAutoScroll(),
              wrap: getWrap(),
            });
        if (thisRender !== generation) view.dispose();
        else currentView = view;
      } catch (err) {
        if (thisRender === generation) console.error('Failed to mount file viewer', err);
      }
    }
    void mount();
  }

  // Missing capabilities and unmounted views are a no-op.
  return {
    render,
    nextChange: () => currentView?.nextChange?.(),
    prevChange: () => currentView?.prevChange?.(),
    scrollUp: () => currentView?.scrollUp?.(),
    scrollDown: () => currentView?.scrollDown?.(),
  };
}
