import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
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
