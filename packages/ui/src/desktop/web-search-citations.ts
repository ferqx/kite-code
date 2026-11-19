/** Presentation DTO. Never infer a source, block boundary, or citation from answer text. */
export type WebSearchSource = { url: string; title?: string; snippet?: string };
export type WebSearchBlock = { index: number; offset: number; length: number; sha256: string };
export type WebSearchCitation = WebSearchSource & {
  blockIndex?: number;
  start?: number;
  end?: number;
};
export type WebSearchAnchor = { start: number; end: number; url: string };
export type WebSearchDisplay = {
  executionId: string;
  revision: number;
  status: 'running' | 'completed' | 'failed' | 'incomplete' | 'cancelled' | 'unknown';
  query?: string;
  route?: 'native' | 'provider';
  provider?: string;
  sources: readonly WebSearchSource[];
  citations: readonly WebSearchCitation[];
  blocks: readonly WebSearchBlock[];
  truncated?: boolean;
};
const limit = 64;
export function webSearchHref(raw: unknown): string | undefined {
  if (
    typeof raw !== 'string' ||
    !/^https?:\/\//i.test(raw) ||
    raw.length > 2048 ||
    /[\s\\\p{Cc}\p{Cf}]/u.test(raw)
  )
    return;
  try {
    const url = new URL(raw);
    if (url.username || url.password || !url.hostname) return;
    return url.href;
  } catch {
    return;
  }
}
export function webSearchLabel(value: unknown, max = 256): string {
  return typeof value === 'string'
    ? value
        .slice(0, max)
        .replace(/[\uD800-\uDBFF]$/u, '')
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .trim()
    : '';
}
export function webSearchLinks(items: readonly WebSearchSource[]) {
  const seen = new Set<string>();
  return items.slice(0, limit).flatMap((item) => {
    const url = webSearchHref(item.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const snippet = webSearchLabel(item.snippet, 320);
    return [
      {
        url,
        title: webSearchLabel(item.title) || new URL(url).hostname,
        ...(snippet ? { snippet } : {}),
      },
    ];
  });
}
const integer = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const boundary = (text: string, n: number) =>
  !(
    n > 0 &&
    n < text.length &&
    /[\uD800-\uDBFF]/u.test(text[n - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(text[n]!)
  );
/** Only decorate an exact immutable answer, on the originating Execution; do not re-anchor a rephrased tool answer. */
export async function verifyWebSearchAnchors(
  text: string,
  executionId: string,
  evidence: WebSearchDisplay,
): Promise<WebSearchAnchor[]> {
  if (
    executionId !== evidence.executionId ||
    evidence.status !== 'completed' ||
    !globalThis.crypto?.subtle ||
    text.length > 1024 * 1024 ||
    evidence.blocks.length > limit
  )
    return [];
  const blocks = new Map<number, WebSearchBlock>();
  let previousEnd = 0,
    previousIndex = -1;
  for (const block of evidence.blocks) {
    if (
      !integer(block.index) ||
      block.index <= previousIndex ||
      !integer(block.offset) ||
      block.offset < previousEnd ||
      !integer(block.length) ||
      block.offset + block.length > text.length ||
      !/^[a-f0-9]{64}$/.test(block.sha256) ||
      !boundary(text, block.offset) ||
      !boundary(text, block.offset + block.length)
    )
      return [];
    previousIndex = block.index;
    previousEnd = block.offset + block.length;
    blocks.set(block.index, block);
  }
  // The host proves the exact completed Execution; hash every supplied original block at its explicit offset. A sparse manifest is valid, never search for missing block boundaries.
  for (const block of blocks.values()) {
    const bytes = new TextEncoder().encode(text.slice(block.offset, block.offset + block.length));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== block.sha256) return [];
  }
  const anchors: WebSearchAnchor[] = [];
  for (const c of evidence.citations.slice(0, limit)) {
    const block = integer(c.blockIndex) && blocks.get(c.blockIndex),
      url = webSearchHref(c.url);
    if (
      !url ||
      !block ||
      !integer(c.start) ||
      !integer(c.end) ||
      c.start >= c.end ||
      c.end > block.length
    )
      continue;
    const start = block.offset + c.start,
      end = block.offset + c.end;
    if (!boundary(text, start) || !boundary(text, end)) continue;
    if (anchors.some((a) => a.start < end && a.end > start)) continue;
    anchors.push({ url, start, end });
  }
  return anchors.sort((a, b) => a.start - b.start);
}

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
/** Match only literal Markdown text nodes. Across markup, links, code or decoded escapes, the source panel is the fallback. */
export function decorateWebSearchAnchors({
  source,
  anchors,
}: {
  source: string;
  anchors?: readonly WebSearchAnchor[];
}) {
  return (tree: Node) => {
    if (!anchors?.length) return;
    const pending = [tree];
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (!node.children || ['a', 'code', 'pre', 'math', 'svg'].includes(node.tagName ?? ''))
        continue;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
          if (child.children) pending.push(child);
          return [child];
        }
        const start = child.position?.start.offset,
          end = child.position?.end.offset;
        if (start === undefined || end === undefined || source.slice(start, end) !== child.value)
          return [child];
        const parts: Node[] = [];
        let cursor = start;
        for (const a of anchors) {
          if (a.start < cursor || a.end > end || a.end <= a.start || !webSearchHref(a.url))
            continue;
          if (a.start > cursor) parts.push({ type: 'text', value: source.slice(cursor, a.start) });
          parts.push({
            type: 'element',
            tagName: 'a',
            properties: { href: a.url, className: ['web-search-citation'] },
            children: [{ type: 'text', value: source.slice(a.start, a.end) }],
          });
          cursor = a.end;
        }
        if (!parts.length) return [child];
        if (cursor < end) parts.push({ type: 'text', value: source.slice(cursor, end) });
        return parts;
      });
    }
  };
}
