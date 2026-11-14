import { parseDesktopMarkdown } from '@kite-ai/ui/desktop/markdown';

export function escapePreviewText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Never execute document HTML, resolve resource URLs, or load remote Markdown images. */
export function markdownPreview(text: string): string {
  const tree = parseDesktopMarkdown(text);
  type Node = {
    type: string;
    value?: string;
    alt?: string;
    depth?: number;
    ordered?: boolean;
    start?: number;
    children?: Node[];
  };
  const render = (node: Node): string => {
    const content = () => (node.children ?? []).map(render).join('');
    switch (node.type) {
      case 'root':
        return content();
      case 'text':
      case 'inlineMath':
      case 'math':
        return escapePreviewText(node.value ?? '');
      case 'paragraph':
        return `<p>${content()}</p>`;
      case 'heading':
        return `<h${Math.max(1, Math.min(6, node.depth ?? 1))}>${content()}</h${Math.max(1, Math.min(6, node.depth ?? 1))}>`;
      case 'strong':
        return `<strong>${content()}</strong>`;
      case 'emphasis':
        return `<em>${content()}</em>`;
      case 'delete':
        return `<del>${content()}</del>`;
      case 'inlineCode':
        return `<code>${escapePreviewText(node.value ?? '')}</code>`;
      case 'code':
        return `<pre><code>${escapePreviewText(node.value ?? '')}</code></pre>`;
      case 'blockquote':
        return `<blockquote>${content()}</blockquote>`;
      case 'list':
        return node.ordered
          ? `<ol start="${Number.isSafeInteger(node.start) ? node.start : 1}">${content()}</ol>`
          : `<ul>${content()}</ul>`;
      case 'listItem':
        return `<li>${content()}</li>`;
      case 'table':
        return `<table><tbody>${content()}</tbody></table>`;
      case 'tableRow':
        return `<tr>${content()}</tr>`;
      case 'tableCell':
        return `<td>${content()}</td>`;
      case 'thematicBreak':
        return '<hr>';
      case 'break':
        return '<br>';
      case 'image':
      case 'imageReference':
        return `<span>${escapePreviewText(node.alt ?? '')}</span>`;
      case 'html':
        return escapePreviewText(node.value ?? '');
      case 'definition':
        return '';
      default:
        return content();
    }
  };
  return previewDocument(render(tree as Node));
}
export function previewDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.65 system-ui,sans-serif;color:#202124;margin:0;padding:24px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.3}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px}code{font-size:.9em}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td{border:1px solid #ddd;padding:6px 10px}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:16px;color:#666}</style></head><body>${body}</body></html>`;
}
export function previewUtf8(bytes: Uint8Array): string | undefined {
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}
