import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../src/desktop/MessageContent';
import { parseDesktopMarkdown } from '../src/desktop/markdown-parser';
import { SafeMessageMarkdown } from '../src/markdown';

test('full Markdown structure with inert HTML, image alt and relative file text', () => {
  const tail = 'complete tail '.repeat(10000);
  const html = renderToStaticMarkup(
    <SafeMessageMarkdown
      content={`# Heading\n\nParagraph\n\n- List item\n\n> Quoted\n\n\`\`\`ts\nconst value = 1;\n\`\`\`\n\n| Column |\n| --- |\n| Value |\n\n<script>alert(1)</script>\n\n![Image text](https://invalid.example/image.png)\n\n[Local file](../file.ts) [Unsafe](javascript:alert(1)) [External](https://example.com)\n\n${tail}`}
    />,
  );
  for (const tag of ['h1', 'p', 'ul', 'blockquote', 'pre', 'table'])
    expect(html).toContain(`<${tag}`);
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('href="../file.ts"');
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('Image text');
  expect(html.includes(tail.trimEnd())).toBe(true);
  expect(html).toContain('rel="noopener noreferrer"');
});

test('desktop GFM preserves complete large text, original links and code, and ordinary words', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const ascii = 'x'.repeat(20000),
    unicode = 'e\u0301👩🏽‍💻👨‍👩‍👧‍👦🙂漢字𠮷'.repeat(1200),
    paragraph = `Before ${unicode} after.`,
    ordinary = 'Ordinary words with spaces and punctuation.',
    code = `const original = "${ascii}${unicode}";`,
    calls: string[] = [];
  try {
    await act(async () =>
      root.render(
        <MessageContent
          text={`# Heading ${ascii}\n\n${paragraph}\n\n[External ${unicode}](https://example.com/report) [Local file](src/file.ts) [Unsafe](javascript:alert(1))\n\n${ordinary}\n\n\`\`\`txt\n${code}\n\`\`\`\n\n| Column |\n| --- |\n| Value |\n\n![Original alt](https://invalid.example/image.png)`}
          openFile={(path) => calls.push(path)}
        />,
      ),
    );
    expect(host.querySelector('h1')!.textContent).toBe(`Heading ${ascii}`);
    const paragraphs = [...host.querySelectorAll('.typeset-chat > p')];
    expect(paragraphs[0]!.textContent).toBe(paragraph);
    expect(paragraphs[1]!.textContent).toBe(`External ${unicode} Local file Unsafe`);
    expect(paragraphs[2]!.textContent).toBe(ordinary);
    expect(paragraphs[2]!.querySelector('.message-long-word')).toBeNull();
    const originalRuns = [
      host.querySelector('h1')!.textContent!.slice('Heading '.length),
      paragraphs[0]!.textContent!.slice('Before '.length, -' after.'.length),
      host.querySelector('a')!.textContent!.slice('External '.length),
    ];
    expect(originalRuns).toEqual([ascii, unicode, unicode]);
    const external = host.querySelector('a')!;
    expect(external.textContent).toBe(`External ${unicode}`);
    const textNodeBoundaries = (element: Element) => {
      const text = element.textContent!,
        graphemeStarts = new Set(
          [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
            (grapheme) => grapheme.index,
          ),
        ),
        walker = dom.window.document.createTreeWalker(element, dom.window.NodeFilter.SHOW_TEXT),
        invalid: number[] = [];
      let offset = 0,
        nodes = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset > 0 && offset < text.length && !graphemeStarts.has(offset)) invalid.push(offset);
        offset += node.textContent!.length;
        nodes++;
      }
      return { invalid, nodes };
    };
    const paragraphBoundaries = textNodeBoundaries(paragraphs[0]!),
      linkBoundaries = textNodeBoundaries(external);
    expect([paragraphBoundaries.invalid, linkBoundaries.invalid]).toEqual([[], []]);
    expect(paragraphBoundaries.nodes > 1 && linkBoundaries.nodes > 1).toBe(true);
    expect(external.getAttribute('href')).toBe('https://example.com/report');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noreferrer');
    await act(async () => (host.querySelector('button.file-link') as HTMLButtonElement).click());
    expect(calls).toEqual(['src/file.ts']);
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    const fenced = host.querySelector('pre > code')!;
    expect(fenced.textContent).toBe(`${code}\n`);
    expect(fenced.className).toBe('language-txt');
    expect(fenced.querySelector('.message-long-word')).toBeNull();
    expect(host.querySelector('table th')!.textContent).toBe('Column');
    expect(host.querySelector('table td')!.textContent).toBe('Value');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.image-description')!.textContent).toBe('图片：Original alt');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

test('desktop tight and loose lists keep separate paragraph, code and nested-list edges without changing saved syntax', () => {
  const tight = [
    '1. Before **bold** [local](src/file.ts)',
    '   ```text',
    '   original command',
    '   ```',
    '   After the code.',
    '2. Nested steps:',
    '   - [x] Done',
    '   - [ ] Pending',
    '3. Ends with a code block:',
    '   ```text',
    '   last command',
    '   ```',
  ];
  const loose = tight.map((line, index) => ([1, 4, 5, 8, 9].includes(index) ? `\n${line}` : line));
  const outputs = [tight, loose].map((lines) => {
    const text = lines.join('\n'),
      tree = parseDesktopMarkdown(text),
      saved = JSON.stringify(tree),
      dom = new JSDOM(
        renderToStaticMarkup(<MessageContent text={text} prepared={{ text, tree }} />),
      );
    try {
      const list = dom.window.document.querySelector('.typeset-chat > ol')!,
        [first, second, last] = [...list.children];
      expect([...first!.children].map((element) => element.tagName)).toEqual(['P', 'PRE', 'P']);
      expect(first!.querySelector('strong')!.textContent).toBe('bold');
      expect(first!.querySelector('pre > code')!.textContent).toBe('original command\n');
      expect(first!.lastElementChild!.textContent).toBe('After the code.');
      expect([...second!.children].map((element) => element.tagName)).toEqual(['P', 'UL']);
      const checks = second!.querySelectorAll('input[type="checkbox"]');
      expect([...checks].map((input) => (input as HTMLInputElement).checked)).toEqual([
        true,
        false,
      ]);
      expect([...last!.children].map((element) => element.tagName)).toEqual(['P', 'PRE']);
      expect(last!.querySelector('pre > code')!.textContent).toBe('last command\n');
      expect(JSON.stringify(tree)).toBe(saved);
      return list.textContent;
    } finally {
      dom.window.close();
    }
  });
  expect(outputs[0]!.replace(/\s+/g, ' ')).toBe(outputs[1]!.replace(/\s+/g, ' '));
});

test('desktop Markdown file links use the current host callback, revoke and restore capability, and update the body', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const calls: string[] = [];
  const text = '[Local file](src/old%20file.ts) [External](https://example.com)';
  const render = (openFile?: (path: string) => void, body = text) =>
    act(async () => root.render(<MessageContent text={body} openFile={openFile} />));
  const click = () =>
    act(async () => (host.querySelector('button.file-link') as HTMLButtonElement).click());
  try {
    await render((path) => calls.push(`first:${path}`));
    await click();
    expect(calls).toEqual(['first:src/old file.ts']);
    await render((path) => calls.push(`second:${path}`));
    await click();
    expect(calls).toEqual(['first:src/old file.ts', 'second:src/old file.ts']);
    const retired = host.querySelector('button.file-link') as HTMLButtonElement;
    await render();
    expect(host.querySelector('button.file-link')).toBeNull();
    expect(host.textContent).toBe('Local file External');
    await act(async () => retired.click());
    expect(calls).toHaveLength(2);
    expect(host.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    await render((path) => calls.push(`restored:${path}`));
    await click();
    expect(calls.at(-1)).toBe('restored:src/old file.ts');
    await render((path) => calls.push(`new-body:${path}`), '[New file](src/new.ts)');
    expect(host.textContent).toBe('New file');
    await click();
    expect(calls.at(-1)).toBe('new-body:src/new.ts');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

test('desktop Markdown keeps table focus and horizontal reading position while rows stream in', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const text = '| Item | Status |\n| --- | :---: |\n| Original | Running |';
  try {
    await act(async () => root.render(<MessageContent text={text} />));
    const region = host.querySelector<HTMLElement>('[aria-label="表格"]')!;
    region.focus();
    region.scrollLeft = 180;
    await act(async () =>
      root.render(<MessageContent text={`${text}\n| Arrived later | Complete |`} />),
    );
    const current = host.querySelector<HTMLElement>('[aria-label="表格"]')!;
    expect(current.scrollLeft).toBe(180);
    expect(dom.window.document.activeElement).toBe(current);
    expect(current.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(current.querySelectorAll('th')[1]!.style.textAlign).toBe('center');
    expect(current.textContent).toContain('Arrived later');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});
