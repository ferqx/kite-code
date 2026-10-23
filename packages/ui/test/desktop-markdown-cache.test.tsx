import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { MessageContent } from '../src/desktop/MessageContent';
import {
  DesktopMarkdownParseCache,
  reuseDesktopMarkdownParse,
} from '../src/desktop/markdown-parse-cache';
import { parseDesktopMarkdown } from '../src/desktop/markdown-parser';

test('Desktop caches exact GFM syntax data and isolates every mutable pipeline tree', () => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(reuseDesktopMarkdownParse);
  const source =
    '# cache isolation\n\n| A |\n| - |\n| ~~B~~ |\n\n- [x] checked\n\n[link](src/a.ts)';
  const first = processor.parse(source),
    expected = structuredClone(first);
  first.children.length = 0;
  const second = processor.parse(source);
  expect(second).toEqual(expected);
  expect(second).not.toBe(first);
  second.children.length = 0;
  expect(processor.parse(source)).toEqual(expected);
  expect(JSON.stringify(expected)).toContain('table');
  expect(JSON.stringify(expected)).toContain('delete');
  expect(JSON.stringify(expected)).toContain('checked');
  expect(processor.parse(`${source}\n\nexact changed tail🙂`)).not.toEqual(expected);
});

test('Desktop parse cache bounds entry count, aggregate payload and oversized individual source/tree data', () => {
  const cache = new DesktopMarkdownParseCache(),
    calls = new Map<string, number>();
  const parse = (key: string, value = key) =>
    cache.parse(key, () => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return { type: 'root', value };
    });
  for (let index = 0; index < 32; index++) parse(String(index));
  parse('0');
  expect(calls.get('0')).toBe(1);
  parse('32');
  parse('1');
  expect(calls.get('1')).toBe(2);
  parse('0');
  expect(calls.get('0')).toBe(1);
  const large = '中'.repeat(250000);
  for (let index = 0; index < 20; index++) parse(`large-${index}`, large);
  parse('large-19', large);
  expect(calls.get('large-19')).toBe(1);
  parse('large-0', large);
  expect(calls.get('large-0')).toBe(2);
  const oversizedSource = 's'.repeat(1100000),
    oversizedTree = 't'.repeat(1100000);
  parse(oversizedSource);
  parse(oversizedSource);
  expect(calls.get(oversizedSource)).toBe(2);
  parse('oversized-tree', oversizedTree);
  parse('oversized-tree', oversizedTree);
  expect(calls.get('oversized-tree')).toBe(2);
});

test('remounting the cached Desktop pipeline preserves safety, exact Unicode/code and current file capability', () => {
  const unicode = 'e\u0301👩🏽‍💻𠮷漢字'.repeat(1500);
  const text = `# cached desktop\n\n${unicode}\n\n<script>window.bad=1</script>\n\n![alt](https://invalid.example/no-fetch.png)\n\n[local](src/unique-cache-file.ts) [unsafe](javascript:alert(1)) [web](https://example.com)\n\n\`\`\`txt\n${unicode}\n\`\`\``;
  const render = (openFile?: (path: string) => void) =>
    renderToStaticMarkup(<MessageContent text={text} openFile={openFile} />);
  const allowed = render(() => {}),
    denied = render(),
    restored = render(() => {});
  expect(allowed).toBe(restored);
  expect(allowed).toContain('class="file-link"');
  expect(denied).not.toContain('class="file-link"');
  for (const html of [allowed, denied, restored]) {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(
      `<code data-slot="code-block-code" class="language-txt">${unicode}\n</code>`,
    );
  }
  // Above the cache budget, the complete body remains readable on each mount.
  const overBudget = `\`\`\`txt\n${'全'.repeat(1100000)}\nUNTRUNCATED🙂\n\`\`\``;
  for (let index = 0; index < 2; index++) {
    const html = renderToStaticMarkup(<MessageContent text={overBudget} />);
    expect(html).toContain('UNTRUNCATED🙂');
    expect(html.match(/全/g)).toHaveLength(1100000);
  }
});

test('prepared syntax keeps the fixed renderer safety policy and exact source identity', () => {
  const source =
    '# prepared🙂\n\n|a|\n|-|\n|~~b~~|\n\n<script>alert(1)</script>\n\n![remote](https://example.com/private.png)\n\n[unsafe](javascript:alert(1))\n\n[file](src/main.ts)';
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  const prepared = { text: source, tree };
  const expected = renderToStaticMarkup(<MessageContent text={source} />);
  const actual = renderToStaticMarkup(<MessageContent text={source} prepared={prepared} />);
  expect(actual).toBe(expected);
  expect(actual).not.toContain('<script');
  expect(actual).not.toContain('<img');
  expect(actual).not.toContain('href="javascript:');
  expect(actual).toContain('<table');
  expect(actual).toContain('prepared🙂');
  expect(
    renderToStaticMarkup(<MessageContent text="different content🙂" prepared={prepared} />),
  ).toContain('different content🙂');
  expect(tree.children.length).toBeGreaterThan(0);
});

test('fixed pure parser preserves named references across full Markdown context', () => {
  const source =
    '## &copy; &NotEqualTilde; &semi; &notit; 🙂\n\n[late][target]\n\n[target]: https://example.com/?a=1&amp;b=2';
  const parsed = parseDesktopMarkdown(source);
  const output = renderToStaticMarkup(
    <MessageContent text={source} prepared={{ text: source, tree: parsed }} />,
  );
  expect(output).toBe(renderToStaticMarkup(<MessageContent text={source} />));
  expect(output).toContain('©');
  expect(output).toContain('≂̸');
  expect(output).toContain('&amp;notit;');
  expect(output).toContain('href="https://example.com/?a=1&amp;b=2"');
});
