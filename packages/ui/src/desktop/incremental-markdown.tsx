import { memo, type ReactNode, useLayoutEffect, useRef } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { isClosedDiagramFence } from './markdown-diagram';
import { StreamingTextReveal } from './streaming-text-reveal';

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  children?: Node[];
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
};
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const REVEAL_STEP_MS = 18;
const MAX_REVEAL_DELAY_MS = 180;
const characters = (text: string) => [...graphemes.segment(text)].map(({ segment }) => segment);

/** Source locations and reveal hints do not change an already rendered element. */
function sameMarkup(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const entries = (value: object) =>
    Object.entries(value).filter(([key]) => key !== 'position' && !key.startsWith('reveal'));
  const a = entries(left),
    b = entries(right);
  return (
    a.length === b.length &&
    a.every(([key, value], index) => key === b[index]?.[0] && sameMarkup(value, b[index]?.[1]))
  );
}

const MarkdownElement = memo(
  function MarkdownElement({ children }: { children?: ReactNode } & ExtraProps) {
    return children;
  },
  (previous, next) => sameMarkup(previous.node, next.node),
);

const MarkdownText = memo(
  function MarkdownText({
    children,
    revealFrom,
    revealDelay = 0,
    revealStep = REVEAL_STEP_MS,
  }: {
    children?: ReactNode;
    revealFrom?: number;
    revealDelay?: number;
    revealStep?: number;
  }) {
    const text = typeof children === 'string' ? children : '';
    // The owner appends CharacterData without replacing the reader's existing text ranges.
    const initial = useRef(text);
    const element = useRef<HTMLSpanElement>(null);
    const reveal = useRef<StreamingTextReveal | undefined>(undefined);
    useLayoutEffect(() => () => reveal.current?.dispose(), []);
    useLayoutEffect(() => {
      if (!element.current) return;
      reveal.current ??= new StreamingTextReveal(element.current);
      const boundary =
        revealFrom === undefined
          ? undefined
          : graphemes.segment(text).containing(revealFrom)?.index;
      reveal.current.update(
        text,
        boundary === revealFrom ? revealFrom : undefined,
        revealDelay,
        revealStep,
      );
    }, [text, revealFrom, revealDelay, revealStep]);
    return <span ref={element}>{initial.current}</span>;
  },
  (previous, next) => previous.children === next.children,
);
// Element memo boundaries return fragments; each text node keeps one ordinary inline span.
export const incrementalMarkdownComponents = {
  'kite-markdown-element': MarkdownElement,
  'kite-markdown-text': MarkdownText,
} as Components;

/** Keep full-document semantics, but let unchanged elements bail out before rendering children. */
export function incrementalMarkdown({
  source,
  revealAfter,
}: {
  source: string;
  revealAfter?: number;
}) {
  return (tree: Node) => {
    let revealIndex = 0;
    // Share ordering across inline Markdown nodes; large batches finish within 420ms.
    const step = Math.min(
      REVEAL_STEP_MS,
      MAX_REVEAL_DELAY_MS /
        Math.max(
          1,
          characters(revealAfter === undefined ? '' : source.slice(revealAfter)).length - 1,
        ),
    );
    const wrap = (node: Node): Node => {
      if (node.type === 'text') {
        // Formatting whitespace between list/table blocks cannot contain an inline element.
        if (!node.value?.trim()) return node;
        const start = node.position?.start.offset,
          end = node.position?.end.offset;
        const suffix =
          revealAfter !== undefined && start !== undefined && end !== undefined && end > revealAfter
            ? source.slice(Math.max(start, revealAfter), end)
            : '';
        const revealFrom =
          suffix && node.value?.endsWith(suffix) ? node.value.length - suffix.length : undefined;
        const revealDelay = revealFrom === undefined ? undefined : revealIndex * step;
        if (revealFrom !== undefined)
          revealIndex += characters(node.value!.slice(revealFrom)).length;
        return {
          type: 'element',
          tagName: 'kite-markdown-text',
          properties: {
            revealFrom,
            revealDelay,
            revealStep: revealFrom === undefined ? undefined : step,
          },
          children: [node],
        };
      }
      if (node.type !== 'element') return node;
      if (node.tagName === 'pre')
        node.data = { ...node.data, closedFence: isClosedDiagramFence(source, node.position) };
      // Code adapters consume literal children; KaTeX owns its generated math subtree.
      const classes = node.properties?.className;
      if (
        node.tagName !== 'pre' &&
        node.tagName !== 'code' &&
        !(Array.isArray(classes) && classes.includes('katex'))
      )
        node.children = node.children?.map(wrap);
      return {
        type: 'element',
        tagName: 'kite-markdown-element',
        properties: {},
        children: [node],
      };
    };
    tree.children = tree.children?.map(wrap);
  };
}
