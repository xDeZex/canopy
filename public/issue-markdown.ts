// A deliberately small Markdown subset. All source text enters the DOM through
// textContent, including unsupported Markdown and raw HTML.
export interface IssueMarkdownNode<E> {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  replaceChildren(...children: E[]): void;
}

export interface IssueMarkdownDocument<E> {
  createElement(tag: string): E;
}

interface Budget { tokens: number; search: number }

function issueBase(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    // The caller supplies the trusted issue URL; enterprise hosts are valid too.
    if (url.protocol !== 'https:' || !url.hostname || url.port || url.username || url.password) return undefined;
    if (!/^\/[^/]+\/[^/]+(?:\/issues\/\d+)?\/?$/.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function safeHref(value: string, baseUrl?: string): string | null {
  // Do not let URL's whitespace normalization turn obfuscated schemes into links.
  if (!value || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (!/^https?:\/\//i.test(value) && (!baseUrl || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//'))) return null;
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Render a bounded, read-only Markdown subset without HTML parsing or image loads. */
export function renderIssueMarkdown<E extends IssueMarkdownNode<E>>(
  document: IssueMarkdownDocument<E>, markdown: string, { baseUrl }: { baseUrl?: string } = {},
): E {
  const base = issueBase(baseUrl);
  const budget: Budget = { tokens: 4000, search: 2_000_000 };
  const node = (tag: string, text?: string): E => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const find = (text: string, delimiter: string, start: number): number => {
    budget.search -= text.length - start;
    return budget.search < 0 ? -1 : text.indexOf(delimiter, start);
  };
  const inline = (text: string, depth = 0, allowLinks = true): E[] => {
    if (depth >= 12 || budget.tokens <= 0 || budget.search < 0) return [node('span', text)];
    const children: E[] = [];
    let plain = '';
    const flush = () => { if (plain) { children.push(node('span', plain)); plain = ''; } };
    for (let i = 0; i < text.length;) {
      if (budget.tokens <= 0 || budget.search < 0) { plain += text.slice(i); break; }
      const char = text[i];
      if (char === '\\' && /[\\`*_[\]{}()#+.!>~-]/.test(text[i + 1] ?? '')) {
        plain += text[i + 1]; i += 2; continue;
      }
      if (char === '`') {
        let end = i + 1;
        while (text[end] === '`') end++;
        const marker = text.slice(i, end);
        const close = find(text, marker, end);
        if (close >= 0) {
          flush(); budget.tokens--;
          children.push(node('code', text.slice(end, close).replace(/\n/g, ' ')));
          i = close + marker.length; continue;
        }
        // Consume an unmatched run once, rather than rescanning its suffixes.
        plain += marker; i = end; continue;
      }
      if (allowLinks && (char === '[' || (char === '!' && text[i + 1] === '['))) {
        const image = char === '!';
        const start = i + (image ? 2 : 1);
        const labelEnd = find(text, '](', start);
        if (labelEnd >= 0 && !text.slice(start, labelEnd).includes('\n')) {
          let end = labelEnd + 2;
          let balance = 1;
          for (; end < text.length && balance > 0; end++) {
            if (text[end] === '(') balance++;
            if (text[end] === ')') balance--;
          }
          if (balance === 0) {
            const destination = text.slice(labelEnd + 2, end - 1);
            const href = safeHref(destination, base);
            const label = text.slice(start, labelEnd);
            flush(); budget.tokens--;
            const link = node(href ? 'a' : 'span');
            if (href) {
              link.setAttribute('href', href);
              link.setAttribute('target', '_blank');
              link.setAttribute('rel', 'noopener noreferrer');
            }
            // Images are explicit links, never automatic external requests.
            link.replaceChildren(...inline(image ? `Image: ${label || destination}` : label, depth + 1, false));
            children.push(link); i = end; continue;
          }
        }
      }
      if (char === '*' || char === '_') {
        const marker = text[i + 1] === char ? char + char : char;
        // Underscores inside identifiers are ordinary text.
        const word = char === '_' && /[\p{L}\p{N}]/u.test(text[i - 1] ?? '');
        const close = word ? -1 : find(text, marker, i + marker.length);
        if (close > i + marker.length && !/\s/.test(text[i + marker.length]) && !/\s/.test(text[close - 1])) {
          flush(); budget.tokens--;
          const emphasis = node(marker.length === 2 ? 'strong' : 'em');
          emphasis.replaceChildren(...inline(text.slice(i + marker.length, close), depth + 1, allowLinks));
          children.push(emphasis); i = close + marker.length; continue;
        }
      }
      plain += char; i++;
    }
    flush();
    return children;
  };
  const listMatch = (line: string) => /^ {0,3}([-+*]|\d{1,9}[.)])\s+(.*)$/.exec(line);
  const fenceMatch = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const startsBlock = (line: string) => /^ {0,3}(#{1,6}(?:\s|$)|>)/.test(line) || Boolean(fenceMatch(line) || listMatch(line));
  const block = (lines: string[], depth = 0): E[] => {
    if (depth >= 12) return [node('p', lines.join('\n'))];
    const children: E[] = [];
    for (let i = 0; i < lines.length;) {
      if (!lines[i].trim()) { i++; continue; }
      const fence = fenceMatch(lines[i]);
      if (fence) {
        const content: string[] = [];
        const marker = fence[1];
        i++;
        while (i < lines.length) {
          const close = /^ {0,3}(`+|~+)\s*$/.exec(lines[i]);
          if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { i++; break; }
          content.push(lines[i++]);
        }
        const pre = node('pre');
        pre.replaceChildren(node('code', content.join('\n')));
        children.push(pre); continue;
      }
      const heading = /^ {0,3}(#{1,6})(?:\s+(.*)|$)/.exec(lines[i]);
      if (heading) {
        const element = node(`h${heading[1].length}`);
        element.replaceChildren(...inline((heading[2] ?? '').replace(/\s+#+\s*$/, '')));
        children.push(element); i++; continue;
      }
      if (/^ {0,3}>/.test(lines[i])) {
        const quoted: string[] = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        const quote = node('blockquote');
        quote.replaceChildren(...block(quoted, depth + 1));
        children.push(quote); continue;
      }
      const firstItem = listMatch(lines[i]);
      if (firstItem) {
        const ordered = /^\d/.test(firstItem[1]);
        const list = node(ordered ? 'ol' : 'ul');
        if (ordered) list.setAttribute('start', String(parseInt(firstItem[1], 10)));
        const items: E[] = [];
        while (i < lines.length) {
          const item = listMatch(lines[i]);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          const li = node('li');
          li.replaceChildren(...inline(item[2]));
          items.push(li); i++;
        }
        list.replaceChildren(...items); children.push(list); continue;
      }
      const paragraph = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) paragraph.push(lines[i++]);
      const p = node('p');
      p.replaceChildren(...inline(paragraph.join('\n')));
      children.push(p);
    }
    return children;
  };
  // Bound formatting work, not readable content. Beyond the source/line budget,
  // retain the entire remainder in one inert node instead of dropping it.
  const source = markdown.replace(/\r\n?/g, '\n');
  const cutoff = /[\uD800-\uDBFF]/.test(source[99_999] ?? '') && /[\uDC00-\uDFFF]/.test(source[100_000] ?? '') ? 99_999 : 100_000;
  const lines = source.slice(0, cutoff).split('\n').slice(0, 2000);
  const remainder = source.slice(lines.join('\n').length);
  const root = node('div');
  root.className = 'issue-markdown';
  const children = block(lines);
  if (remainder) children.push(node('pre', remainder));
  root.replaceChildren(...children);
  return root;
}
