import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../src/desktop/MessageContent';
import { diagramRestriction, isClosedDiagramFence } from '../src/desktop/markdown-diagram';
import { parseDesktopMarkdown } from '../src/desktop/markdown-parser';

test('desktop math, alerts, highlighted code and footnotes survive prepared parsing without source mutation', () => {
  const text =
    '# 目标\n\n[跳转](#目标) [不存在](#missing)\n\n> [!TIP]\n> 使用 **公式** $x^2$。\n\n$$\n\\frac{1}{2}\n$$\n\n正文[^a]\n\n[^a]: 注释\n\n```typescript\nconst x = "<img src=unsafe>";\n```\n\n```diff\n-old\n+new\n```';
  const tree = parseDesktopMarkdown(text),
    original = JSON.stringify(tree);
  for (const prepared of [undefined, { text, tree }]) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <>
          <MessageContent text={text} prepared={prepared} />
          <MessageContent text={text} prepared={prepared} />
        </>,
      ),
    );
    try {
      const document = dom.window.document;
      expect(document.querySelectorAll('.katex')).toHaveLength(4);
      expect(document.querySelectorAll('math')).toHaveLength(4);
      expect(document.querySelector('.markdown-alert-title')?.textContent).toBe('提示');
      expect(document.querySelector('.markdown-alert strong')?.textContent).toBe('公式');
      expect(document.querySelector('.hljs-keyword')?.textContent).toBe('const');
      expect(document.querySelector('.hljs-deletion')?.textContent).toBe('-old');
      expect(document.querySelector('.hljs-addition')?.textContent).toBe('+new');
      expect(document.querySelector('pre code')?.textContent).toBe(
        'const x = "<img src=unsafe>";\n',
      );
      expect(document.querySelector('img')).toBeNull();
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const message of document.querySelectorAll('.typeset-chat')) {
        for (const link of message.querySelectorAll('a[href^="#"]'))
          expect(
            message.contains(document.getElementById(link.getAttribute('href')!.slice(1))),
          ).toBe(true);
        const describedBy = message
          .querySelector('[data-footnote-ref]')!
          .getAttribute('aria-describedby')!;
        expect(message.contains(document.getElementById(describedBy))).toBe(true);
      }
      expect(document.querySelector('a[href="#missing"]')).toBeNull();
      expect(document.querySelector('[data-footnote-ref]')?.getAttribute('tabindex')).toBeNull();
    } finally {
      dom.window.close();
    }
  }
  expect(JSON.stringify(tree)).toBe(original);
});

test('unsupported code and invalid or untrusted formulas retain readable source without executable markup', () => {
  const text =
    '```unknown\n<b>original</b>\n```\n\n$\\invalidcommand$\n\n$\\href{javascript:alert(1)}{unsafe}$\n\n$\\includegraphics{https://invalid.example/image.png}$';
  const dom = new JSDOM(renderToStaticMarkup(<MessageContent text={text} />));
  expect(dom.window.document.querySelector('pre code')?.textContent).toBe('<b>original</b>\n');
  expect(dom.window.document.querySelectorAll('img, script, a[href^="javascript:"]')).toHaveLength(
    0,
  );
  expect(dom.window.document.body.textContent).toContain('invalidcommand');
  dom.window.close();
});

test('diagrams wait for matching closing fences and restrict resource-bearing or oversized syntax', () => {
  for (const source of ['```mermaid\ngraph TD\nA --> B', '```mermaid\ngraph TD\nA --> B\n~~~/']) {
    expect(
      isClosedDiagramFence(source, { start: { offset: 0 }, end: { offset: source.length } }),
    ).toBe(false);
    const html = renderToStaticMarkup(<MessageContent text={source} />);
    expect(html).toContain('图表生成中');
    expect(html).not.toContain('<img');
  }
  const source = '~~~~mermaid\ngraph TD\nA --> B\n~~~~~';
  for (const prefix of ['> ', '> > ', '- ']) {
    const nested = `${prefix}\`\`\`mermaid\n${prefix.replace('-', ' ')}graph TD\n${prefix.replace('-', ' ')}A --> B\n${prefix.replace('-', ' ')}\`\`\``;
    expect(renderToStaticMarkup(<MessageContent text={nested} />)).toContain('正在绘制图表');
  }
  const literalQuote = '```mermaid\ngraph TD\n> ```';
  expect(
    isClosedDiagramFence(literalQuote, {
      start: { offset: 0 },
      end: { offset: literalQuote.length },
    }),
  ).toBe(false);
  expect(
    isClosedDiagramFence(source, { start: { offset: 0 }, end: { offset: source.length } }),
  ).toBe(true);
  for (const type of [
    'graph TD',
    'flowchart LR',
    'sequenceDiagram',
    'classDiagram',
    'stateDiagram-v2',
    'erDiagram',
  ])
    expect(diagramRestriction(type)).toBeUndefined();
  for (const source of [
    'graph TD\nA[<img src="https://invalid.example">]',
    'graph TD\nclick A "https://example.com"',
    '%%{init: {}}%%\ngraph TD',
    'graph TD\nA@{ img: "https://invalid.example" }',
    '---\nconfig: {}\n---\ngraph TD',
    `graph TD\n${'A'.repeat(16384)}`,
    'mindmap\nroot',
  ])
    expect(diagramRestriction(source)).toBeDefined();
});
