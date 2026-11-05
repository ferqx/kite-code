import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../src/desktop/MessageContent';
import { diagramRestriction, isClosedDiagramFence } from '../src/desktop/markdown-diagram';
import { parseDesktopMarkdown } from '../src/desktop/markdown-parser';

test('Chinese punctuation beside emphasis parses identically in direct, cached and prepared Desktop rendering', () => {
  const text =
    '**下周如何调整：**如果没有新的训练反馈，就先重复本周安排，不自动加量。若你反馈本周大多数训练都轻松完成、无异常不适且恢复良好，下周只小幅增加一项：例如步行多 **5 分钟**，或某个力量动作每组多 **1–2 次**；不要同时增加时长、组数和强度。';
  const tree = parseDesktopMarkdown(text),
    original = JSON.stringify(tree);
  for (const prepared of [undefined, undefined, { text, tree }]) {
    const dom = new JSDOM(renderToStaticMarkup(<MessageContent text={text} prepared={prepared} />));
    try {
      expect(
        [...dom.window.document.querySelectorAll('strong')].map((node) => node.textContent),
      ).toEqual(['下周如何调整：', '5 分钟', '1–2 次']);
      expect(dom.window.document.body.textContent).toBe(text.replaceAll('**', ''));
    } finally {
      dom.window.close();
    }
  }
  const paragraph = JSON.parse(original).children[0];
  if (paragraph.type !== 'paragraph') throw Error('paragraph_expected');
  expect(paragraph.children[0].type).toBe('strong');
  const position = paragraph.children[0].position!;
  expect(text.slice(position.start.offset, position.end.offset)).toBe('**下周如何调整：**');
  expect(JSON.stringify(tree)).toBe(original);
});

test('CJK emphasis keeps links, code, escapes, math and ordinary Latin punctuation boundaries intact', () => {
  const text =
    '前缀**重点。**后续，*提示：*正文。\n\n**「说明」**继续，**提示：[链接](https://example.com)！**后续。\n\n`**代码：**原样`\n\n\\*\\*转义：\\*\\*原样\n\n**value:**tail\n\n$x^2$\n\n```txt\n**代码块：**原样\n```';
  const dom = new JSDOM(renderToStaticMarkup(<MessageContent text={text} />));
  try {
    const document = dom.window.document;
    expect([...document.querySelectorAll('strong')].map((node) => node.textContent)).toEqual([
      '重点。',
      '「说明」',
      '提示：链接！',
    ]);
    expect(document.querySelector('em')?.textContent).toBe('提示：');
    expect(document.querySelector('strong a')?.getAttribute('href')).toBe('https://example.com');
    expect(document.querySelector('code')?.textContent).toBe('**代码：**原样');
    expect(document.querySelector('pre code')?.textContent).toBe('**代码块：**原样\n');
    expect(document.body.textContent).toContain('**转义：**原样');
    expect(document.body.textContent).toContain('**value:**tail');
    expect(document.querySelector('.katex')).not.toBeNull();
  } finally {
    dom.window.close();
  }
});

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
