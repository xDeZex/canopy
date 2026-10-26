import type { WorkspaceDocument, WorkspaceElement } from './workspace-dom.js';
import type { createIssuesStore } from './issues-state.js';
import type { GitHubRepository } from './issue-contracts.js';
import { renderIssueMarkdown } from './issue-markdown.js';

function issueUrl(value: string, repository: GitHubRepository, number: number): string | undefined {
  if (/[\s\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    const path = `/${repository.owner}/${repository.name}/issues/${number}`;
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.hostname.toLowerCase() !== repository.host.toLowerCase() || url.pathname.replace(/\/$/, '').toLowerCase() !== path.toLowerCase()) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function createIssuesView<E extends WorkspaceElement<E>>({ document, railEl, mainEl, toolbarEl, store }: {
  document: WorkspaceDocument<E>; railEl: E; mainEl: E; toolbarEl: E;
  store: ReturnType<typeof createIssuesStore>;
}) {
  let visible = true;
  let renderedKey = '';
  let mainPosition = 0;
  let railPosition = 0;

  function capturePosition() {
    mainPosition = mainEl.scrollTop ?? 0;
    railPosition = railEl.scrollTop ?? 0;
  }

  function update(capture: boolean) {
    if (!visible) return;
    if (capture) capturePosition();
    const state = store.getState();
    const key = `${state.repository?.id ?? ''}#${state.selectedNumber ?? ''}`;
    if (key !== renderedKey) mainPosition = 0;
    renderContent();
    renderedKey = key;
    mainEl.scrollTop = mainPosition;
    railEl.scrollTop = railPosition;
  }

  // Capture before the coordinator hides us: display:none can report scrollTop=0.
  // Hidden completions update the store only; render on resume, then refresh.
  function setVisible(value: boolean) {
    if (visible === value) return;
    if (!value) capturePosition();
    visible = value;
    if (visible) update(false);
  }

  function element(tag: string, className: string, text: string) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function repositoryRecovery() {
    const resolve = element('button', 'issues-resolve-repositories', 'Choose repository again');
    resolve.type = 'button';
    resolve.addEventListener('click', () => { void store.load(null); });
    mainEl.append(resolve);
  }

  function renderContent() {
    const state = store.getState();
    toolbarEl.replaceChildren(element('span', 'issues-source', state.repository
      ? `${state.repository.host}/${state.repository.owner}/${state.repository.name}` : 'GitHub issues'));
    const error = state.error ?? state.detailsError;
    const loading = state.status === 'loading' || state.detailsStatus === 'loading';
    const refresh = element('button', 'issues-refresh', loading ? 'Refreshing…' : error ? 'Retry refresh' : 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => { void store.load(); });
    if (error) {
      const status = element('span', 'issues-refresh-status', error);
      status.title = error;
      status.setAttribute('role', 'status');
      toolbarEl.append(status);
    }
    toolbarEl.append(refresh);
    railEl.replaceChildren();
    mainEl.replaceChildren();
    if ((state.status === 'loading' || state.status === 'idle') && !state.repository) {
      mainEl.append(element('p', 'empty', 'Loading issues…'));
      return;
    }
    if (state.status === 'error') {
      mainEl.append(element('p', 'empty', `Failed to load issues: ${state.error}`));
      const retry = element('button', 'issues-retry', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => { void store.load(); });
      mainEl.append(retry);
      repositoryRecovery();
      if (!state.repository) return;
    }
    if (state.notice) mainEl.append(element('p', 'issues-notice', state.notice));
    if (!state.repository) {
      mainEl.append(element('p', 'empty', state.repositories.length ? 'Choose a repository to view issues.' : 'No GitHub repository found.'));
      for (const repository of state.repositories) {
        const choice = element('button', 'issues-repository', `${repository.host}/${repository.owner}/${repository.name}`);
        choice.type = 'button';
        choice.addEventListener('click', () => { void store.load(repository.id); });
        mainEl.append(choice);
      }
      return;
    }
    if (!state.issues.length) {
      mainEl.append(element('p', 'empty', 'No open issues.'));
      return;
    }
    for (const issue of state.issues) {
      const row = element('button', `issues-list__item${issue.number === state.selectedNumber ? ' is-active' : ''}`, `#${issue.number} ${issue.title}`);
      row.type = 'button';
      row.setAttribute('aria-pressed', String(issue.number === state.selectedNumber));
      row.addEventListener('click', () => store.select(issue.number));
      railEl.append(row);
    }
    const selected = state.issues.find((issue) => issue.number === state.selectedNumber);
    if (!selected) return;
    const details = state.details;
    mainEl.append(element('h1', 'issues-title', `#${selected.number} ${details?.title ?? selected.title}`));
    if (state.detailsStatus === 'loading' || state.detailsStatus === 'idle') {
      mainEl.append(element('p', 'issues-detail-status', 'Loading issue conversation…'));
      if (!details) return;
    }
    if (state.detailsStatus === 'error') {
      mainEl.append(element('p', 'issues-detail-status', `Failed to load issue conversation: ${state.detailsError}`));
      const retry = element('button', 'issues-retry', 'Retry conversation');
      retry.type = 'button';
      retry.addEventListener('click', () => { void store.loadDetails(); });
      mainEl.append(retry);
      repositoryRecovery();
      if (!details) return;
    }
    if (!details) return;
    const metadata = element('div', 'issues-metadata', '');
    const createdAt = element('time', 'issues-created-at', details.createdAt);
    createdAt.setAttribute('datetime', details.createdAt);
    metadata.append(element('span', 'issues-author', details.author),
      element('span', 'issues-state', details.state), createdAt);
    for (const label of details.labels) metadata.append(element('span', 'issues-label', label));
    const baseUrl = issueUrl(details.url, state.repository, details.number);
    if (baseUrl) {
      const link = element('a', 'issues-open-link', 'Open in GitHub');
      link.setAttribute('href', baseUrl);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      metadata.append(link);
    }
    const description = renderIssueMarkdown(document, details.body || 'No description.', { baseUrl });
    description.className += ' issues-description';
    const comments = element('section', 'issues-comments', '');
    comments.append(element('h2', 'issues-comments__heading', `Comments (${details.comments.length})`));
    if (!details.comments.length) comments.append(element('p', 'empty', 'No comments.'));
    for (const comment of details.comments) {
      const article = element('article', 'issues-comment', '');
      const header = element('header', 'issues-comment__metadata', '');
      const time = element('time', 'issues-comment__time', comment.createdAt);
      time.setAttribute('datetime', comment.createdAt);
      header.append(element('span', 'issues-comment__author', comment.author), time);
      article.append(header, renderIssueMarkdown(document, comment.body || 'No comment text.', { baseUrl }));
      comments.append(article);
    }
    mainEl.append(metadata, description, comments);
  }

  function scroll(direction: number) {
    if (!visible) return;
    mainEl.scrollTop = Math.max(0, (mainEl.scrollTop ?? 0) + direction * Math.max(100, (mainEl.clientHeight ?? 0) * 0.75));
  }

  return { render: () => update(true), setVisible, scroll };
}
