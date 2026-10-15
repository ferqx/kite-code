import type { LineGroup, MarkdownParseCache, MarkdownRenderSlice } from './ink/MarkdownBlock';

export interface LiveMarkdownPart {
  /** Original parser source-line boundary, stable under append-only updates. */
  key: number;
  version: string;
  slice: MarkdownRenderSlice;
}
/** The existing parser reparses only its final group; preceding groups can enter native history. */
export function partitionLiveMarkdown(cache: MarkdownParseCache): {
  stable: LiveMarkdownPart[];
  tail: LiveMarkdownPart | undefined;
} {
  const parts: LiveMarkdownPart[] = [];
  let previousGroup: LineGroup | undefined;
  let previousBlanks = 0;
  for (const group of cache.groups) {
    const blank = group.kind === 'single' && !group.line.trim();
    parts.push({
      key: group.kind === 'single' ? group.index : group.startIndex,
      version: JSON.stringify(group),
      slice: { groups: [group], previousGroup, previousBlanks },
    });
    if (blank) previousBlanks++;
    else {
      previousGroup = group;
      previousBlanks = 0;
    }
  }
  return { stable: parts.slice(0, -1), tail: parts.at(-1) };
}
