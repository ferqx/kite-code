import { parseDesktopMarkdown } from '@kite-ai/ui/desktop/markdown';
import { isolatedPreviewChromeCss } from './isolated-preview-chrome';

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
      case 'table': {
        const [header, ...rows] = node.children ?? [];
        const headings = (header?.children ?? [])
          .map((cell) => `<th scope="col">${(cell.children ?? []).map(render).join('')}</th>`)
          .join('');
        return `<div class="table-scroll"><table><thead><tr>${headings}</tr></thead><tbody>${rows.map(render).join('')}</tbody></table></div>`;
      }
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
  return previewDocument(render(tree as Node), 'markdown');
}
export function previewDocument(body: string, kind: 'text' | 'markdown' = 'text'): string {
  return `<!doctype html><html class="kite-file-preview-chrome"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
${isolatedPreviewChromeCss}
html{background:var(--office-background)}
body{box-sizing:border-box;margin:0 auto;padding:clamp(12px,4vw,26px);font:14px/1.65 var(--office-font);overflow-wrap:anywhere}
.markdown{max-width:76ch}
body>:first-child,blockquote>:first-child,li>:first-child{margin-block-start:0}
body>:last-child,blockquote>:last-child,li>:last-child{margin-block-end:0}
:where(p,pre,ul,ol,table,blockquote,hr){margin-block:0 12px}
:where(h1,h2,h3,h4,h5,h6){margin-block:20px 8px;font-weight:600;line-height:1.35}
h1{font-size:1.5em}h2{font-size:1.25em}h3{font-size:1.125em}
:where(h1,h2):not(:last-child){padding-block-end:.3em;border-block-end:1px solid var(--office-border)}
ul,ol{padding-inline-start:1.5em}li+li{margin-block-start:2px}
pre,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
pre{white-space:pre-wrap;tab-size:4}
:not(pre)>code{padding:1px 4px;border-radius:4px;background:var(--office-selected)}
pre:has(>code),blockquote{padding:9px 12px;background:var(--office-card);border:1px solid var(--office-border);border-radius:6px}
blockquote{margin-inline:0;border-inline-start:3px solid var(--office-muted)}
.table-scroll{max-width:100%;overflow:auto;margin-block-end:12px}
table{margin:0;border-collapse:collapse}
:is(th,td){border-block-end:1px solid var(--office-border);padding:6px 10px;text-align:start}
th{font-weight:600}
hr{border:0;border-block-start:1px solid var(--office-border)}
</style></head><body class="${kind}">${body}</body></html>`;
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
