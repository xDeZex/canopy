import test from 'node:test';
import assert from 'node:assert/strict';
import { renderIssueMarkdown } from '../../public/issue-markdown.js';
import { Element, FakeDocument } from './fake-dom.js';

const text = (node: Element): string => node.textContent + node.children.map(text).join('');
const find = (node: Element, tag: string): Element[] => [...(node.tag === tag ? [node] : []), ...node.children.flatMap((child) => find(child, tag))];
const render = (markdown: string, baseUrl?: string) => renderIssueMarkdown(new FakeDocument(), markdown, { baseUrl });

// Static compatibility: the same minimal document port accepts a real browser
// Document and returns an HTMLElement, without casting or running browser IO.
function browserDocument(document: Document): HTMLElement { return renderIssueMarkdown(document, '# Issue'); }
void browserDocument;

test('renders common issue Markdown as semantic blocks and nested inline elements', () => {
  const root = render('# Heading\r\n\r\nA **strong** and *emphasized* paragraph with `code` and [docs](https://example.com/docs).\ncontinued\n\n## Smaller\n\n- first\n- **second**\n\n3. third\n4. fourth\n\n> quoted\n>\n> another **paragraph**\n\n```ts\n<script>literal()</script>\n```');
  assert.equal(root.className, 'issue-markdown');
  assert.deepEqual(root.children.map((child) => child.tag), ['h1', 'p', 'h2', 'ul', 'ol', 'blockquote', 'pre']);
  assert.equal(text(root.children[0]), 'Heading');
  assert.equal(text(root.children[1]), 'A strong and emphasized paragraph with code and docs.\ncontinued');
  assert.equal(find(root, 'strong').length, 3);
  assert.equal(find(root, 'em').length, 1);
  assert.deepEqual(root.children[3].children.map(text), ['first', 'second']);
  assert.equal(root.children[4].getAttribute('start'), '3');
  assert.deepEqual(root.children[5].children.map(text), ['quoted', 'another paragraph']);
  assert.equal(text(root.children[6]), '<script>literal()</script>');
  assert.equal(find(root, 'script').length, 0);
});

test('supports alternate emphasis and fences, escapes and unclosed code without interpreting its contents', () => {
  const root = render('### __Bold__ with _em_\n\n\\*literal\\* snake_case_name and ``a `tick` here``\n\n~~~ html\n<img src=x onerror=alert(1)>\n**not bold**');
  assert.equal(text(root.children[0]), 'Bold with em');
  assert.equal(text(root.children[1]), '*literal* snake_case_name and a `tick` here');
  assert.equal(text(find(root, 'pre')[0]), '<img src=x onerror=alert(1)>\n**not bold**');
  assert.equal(find(root, 'img').length, 0);
});

test('raw HTML and hostile links remain inert text; images never load automatically', () => {
  const fixtures = [
    '<script>alert(1)</script><img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">raw</a>',
    '[bad](javascript:alert(1))', '[bad](JaVaScRiPt:alert(1))',
    '[bad](data:text/html,<script>alert(1)</script>)',
    '[bad](java\tscript:alert(1))', '[bad](java\u0000script:alert(1))',
    '[bad](javascript&#58;alert(1))', '[bad](vbscript:msgbox(1))',
    '[bad](//evil.example/path)', '[bad](https://user:password@example.com/)',
    '[bad](https:\\evil.example)', '[bad](file:///etc/passwd)',
  ];
  for (const fixture of fixtures) {
    const root = render(fixture);
    assert.equal(find(root, 'a').length, 0, fixture);
    assert.equal(find(root, 'script').length, 0, fixture);
    assert.equal(find(root, 'img').length, 0, fixture);
    assert.ok(text(root).length > 0, fixture);
  }
  const image = render('![tracking pixel](https://evil.example/pixel) ![bad](data:image/svg+xml,evil)');
  assert.equal(find(image, 'img').length, 0);
  assert.equal(find(image, 'a').length, 1);
  assert.equal(text(image), 'Image: tracking pixel Image: bad');
  assert.equal(text(render(fixtures[0])), fixtures[0]);
});

test('safe absolute and relative links have explicit new-tab isolation and validated bases', () => {
  const root = render('[external](https://example.com/a_(b)) [issue](../43) [repo](/owner/repo) [comment](#issuecomment-1)', 'https://github.com/owner/repo/issues/42');
  assert.deepEqual(find(root, 'a').map((link) => link.getAttribute('href')), [
    'https://example.com/a_(b)', 'https://github.com/owner/repo/43',
    'https://github.com/owner/repo', 'https://github.com/owner/repo/issues/42#issuecomment-1',
  ]);
  for (const link of find(root, 'a')) {
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  }
  for (const base of [undefined, 'javascript:alert(1)', 'http://github.com/owner/repo', 'https://user@github.com/owner/repo', 'https://github.com/owner', 'https://github.com:8443/owner/repo', 'https://github.com/owner/repo/pulls/42']) {
    assert.equal(find(render('[relative](./file) [fragment](#comment)', base), 'a').length, 0, String(base));
  }
  assert.equal(find(render('[file](./README.md)', 'https://github.com/owner/repo/'), 'a')[0].getAttribute('href'), 'https://github.com/owner/repo/README.md');
  const enterprise = render('[comment](#issuecomment-2) [file](/owner/repo/blob/main/file.md)', 'https://github.enterprise.example/owner/repo/issues/42');
  assert.deepEqual(find(enterprise, 'a').map((link) => link.getAttribute('href')), [
    'https://github.enterprise.example/owner/repo/issues/42#issuecomment-2',
    'https://github.enterprise.example/owner/repo/blob/main/file.md',
  ]);
  assert.equal(find(render('[bad](javascript:alert(1)) [bad](//evil.example/path)', 'https://github.enterprise.example/owner/repo'), 'a').length, 0);
});

test('malformed and unsupported Markdown stays readable and code suppresses inline formatting', () => {
  const root = render('an [unfinished](link and **unfinished\n\n`**literal** [link](https://example.com)`\n\n| unsupported | table |');
  assert.equal(text(root.children[0]), 'an [unfinished](link and **unfinished');
  assert.equal(find(root, 'a').length, 0);
  assert.equal(find(root, 'strong').length, 0);
  assert.equal(text(find(root, 'code')[0]), '**literal** [link](https://example.com)');
  assert.equal(text(root.children[2]), '| unsupported | table |');
  assert.equal(render('').children.length, 0);
});

test('large input retains its entire remainder as inert text while formatting work is bounded', () => {
  const largeSource = 'x'.repeat(100_001) + '<script>last-character-sentinel</script>';
  const large = render(largeSource);
  assert.equal(text(large.children[0]).length, 100_000);
  assert.equal(text(large), largeSource);
  assert.equal(large.children.at(-1)?.tag, 'pre');
  assert.match(text(large.children.at(-1)!), /last-character-sentinel/);
  assert.equal(find(large, 'script').length, 0);
  const unicodeSource = 'x'.repeat(99_999) + '😀tail';
  const unicode = render(unicodeSource);
  assert.equal(text(unicode.children[0]).length, 99_999);
  assert.equal(text(unicode.children.at(-1)!), '😀tail');
  assert.equal(text(unicode), unicodeSource);
  const lines = render('- item\r\n'.repeat(3000) + '<img src=x onerror=alert(1)>last-line-sentinel');
  assert.equal(find(lines, 'li').length, 2000);
  assert.equal(text(lines.children.at(-1)!), '\n' + '- item\n'.repeat(1000) + '<img src=x onerror=alert(1)>last-line-sentinel');
  assert.equal(find(lines, 'img').length, 0);
  const nested = render('> '.repeat(1000) + 'deep');
  assert.ok(find(nested, 'blockquote').length <= 12);
  assert.match(text(nested), /deep/);
  const markers = '['.repeat(99_999);
  assert.equal(text(render(markers)), markers);
  const ticks = 'prefix ' + '`'.repeat(99_000);
  assert.equal(text(render(ticks)), ticks);
  const manyTokens = render('*a* '.repeat(20_000) + 'token-tail-sentinel');
  assert.ok(find(manyTokens, 'em').length <= 4000);
  assert.match(text(manyTokens), /token-tail-sentinel$/);
});
