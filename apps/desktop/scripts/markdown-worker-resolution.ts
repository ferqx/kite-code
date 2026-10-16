import { createRequire } from 'node:module';

/** The browser export uses document.createElement; Workers require the equivalent pure lookup. */
export function desktopMarkdownDecoderAlias() {
  let entry = createRequire(import.meta.url).resolve('@kite-ai/ui/desktop/markdown');
  for (const dependency of [
    'remark-parse',
    'mdast-util-from-markdown',
    'micromark-util-decode-string',
    'decode-named-character-reference',
  ])
    entry = createRequire(entry).resolve(dependency);
  return { find: /^decode-named-character-reference$/, replacement: entry };
}
