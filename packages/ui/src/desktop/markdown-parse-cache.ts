import type { Processor } from 'unified';

import type { DesktopMarkdownTree } from './markdown-parser';

export { type DesktopMarkdownTree, parseDesktopMarkdown } from './markdown-parser';

const MAX_ENTRIES = 32;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/** Fixed Desktop GFM syntax only. Never retain processors, files, React nodes or host callbacks. */
export class DesktopMarkdownParseCache {
  private readonly entries = new Map<string, { tree: DesktopMarkdownTree; bytes: number }>();
  private bytes = 0;

  get(text: string): DesktopMarkdownTree | undefined {
    const cached = this.entries.get(text);
    if (!cached) return undefined;
    this.entries.delete(text);
    this.entries.set(text, cached);
    return structuredClone(cached.tree);
  }

  remember(text: string, tree: DesktopMarkdownTree): void {
    const old = this.entries.get(text);
    if (old) {
      this.bytes -= old.bytes;
      this.entries.delete(text);
    }
    const bytes = retainedBytes(tree, text.length * 2);
    if (bytes > MAX_ENTRY_BYTES) return;
    this.entries.set(text, { tree: structuredClone(tree), bytes });
    this.bytes += bytes;
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  parse(text: string, parse: () => DesktopMarkdownTree): DesktopMarkdownTree {
    const cached = this.get(text);
    if (cached) return cached;
    const tree = parse();
    this.remember(text, tree);
    return tree;
  }
}

/** Conservative retained payload budget, including the exact UTF-16 source key and tree strings. */
function retainedBytes(tree: DesktopMarkdownTree, sourceBytes: number): number {
  let bytes = sourceBytes;
  const pending: unknown[] = [tree];
  while (pending.length && bytes <= MAX_ENTRY_BYTES) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += 16 + value.length * 2;
    else if (value && typeof value === 'object') {
      bytes += 32;
      for (const [key, child] of Object.entries(value)) {
        bytes += 16 + key.length * 2;
        pending.push(child);
      }
    } else bytes += 8;
  }
  return bytes;
}

const desktopCache = new DesktopMarkdownParseCache();

/** Installed after remark-gfm, exclusively by Desktop MessageContent's fixed processor. */
export type PreparedDesktopMarkdown = { readonly text: string; readonly tree: DesktopMarkdownTree };

export const getDesktopMarkdownParse = (text: string) => desktopCache.get(text);
export const rememberDesktopMarkdownParse = (text: string, tree: DesktopMarkdownTree) =>
  desktopCache.remember(text, tree);

export function reuseDesktopMarkdownParse(this: Processor, prepared?: PreparedDesktopMarkdown) {
  const parser = this.parser;
  if (!parser) throw Error('desktop_markdown_parser_unavailable');
  this.parser = (text, file) =>
    prepared?.text === text
      ? structuredClone(prepared.tree)
      : desktopCache.parse(text, () => parser(text, file));
}
