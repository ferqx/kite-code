import { describe, expect, test } from 'bun:test';
import { markdownPreview, previewUtf8 } from '../../electron/static-file-preview';
import { filePreviewFormat } from '../../src/file-preview-format';

describe('static file preview without document authority', () => {
  test('formats headings, lists, emphasis, code and GFM tables', () => {
    const html = markdownPreview(
      '# 标题\n\n**重点**\n\n- 第一项\n- 第二项\n\n|字段|值|\n|---|---|\n|A|1|\n\n```js\nalert(1)\n```',
    );
    for (const fragment of [
      '<h1>标题</h1>',
      '<strong>重点</strong>',
      '<ul>',
      '<li>',
      '<table>',
      '<td>A</td>',
      '<pre><code>alert(1)',
    ])
      expect(html).toContain(fragment);
  });
  test('HTML, image URLs and links cannot create executable or external resources', () => {
    const html = markdownPreview(
      '<script>fetch("https://secret")</script>\n\n![remote](https://example.com/track)\n\n![local](file:///etc/passwd)\n\n[run](javascript:alert)\n\n[site](https://example.com)\n\n<iframe src="http://localhost"/>',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(html).not.toMatch(/<[^>]+\ssrc=/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('remote');
    expect(html).toContain('site');
  });
  test('text detection is distinct from filename classification and read errors', () => {
    expect(previewUtf8(new TextEncoder().encode('中文\n正文\t测试'))).toBe('中文\n正文\t测试');
    expect(previewUtf8(new Uint8Array([0xff, 0x80]))).toBeUndefined();
    expect(previewUtf8(new Uint8Array([0xff, 0xfe, 65, 0]))).toBe('A');
    expect(previewUtf8(new Uint8Array([65, 0, 66]))).toBeUndefined();
    expect(filePreviewFormat('photo.jpg', 'application/octet-stream')).toBe('image');
    expect(filePreviewFormat('notes.md')).toBe('markdown');
    expect(filePreviewFormat('report.pdf')).toBe('pdf');
    for (const name of ['x.ts', 'x.svg', 'x.xml', 'x.html', 'x.json'])
      expect(filePreviewFormat(name)).toBe('code');
    expect(filePreviewFormat('notes.log')).toBe('text');
    expect(filePreviewFormat('file.bin')).toBe('unknown');
  });
});
