import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { isClosedDiagramFence } from './markdown-diagram';

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

/** One browser animation per visible character; React never updates per animation frame. */
function RevealedText({
  children,
  delay,
  step,
}: {
  children: string;
  delay: number;
  step: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const attempted = useRef(false);
  const letters = useMemo(() => [...graphemes.segment(children)], [children]);
  useLayoutEffect(() => {
    // Activity reconnects layout effects when a cached conversation returns.
    if (attempted.current) return;
    attempted.current = true;
    const element = ref.current;
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!element?.animate || motion?.matches || document.hidden || element.closest('[hidden]'))
      return;
    const animations = new Set(
      [...element.children].map((letter, index) =>
        letter.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 240,
          delay: Math.min(MAX_REVEAL_DELAY_MS, delay + index * step),
          fill: 'backwards',
          easing: 'ease-out',
        }),
      ),
    );
    const reduce = () => {
      if (motion?.matches) for (const animation of animations) animation.cancel();
    };
    const release = () => motion?.removeEventListener('change', reduce);
    motion?.addEventListener('change', reduce);
    for (const animation of animations) {
      const complete = () => {
        animation.onfinish = animation.oncancel = null;
        animations.delete(animation);
        if (animations.size === 0) release();
      };
      animation.onfinish = animation.oncancel = complete;
    }
    return () => {
      release();
      for (const animation of animations) animation.cancel();
    };
  }, [delay, step]);
  return (
    <span ref={ref}>
      {letters.map(({ segment, index: offset }) => (
        <span key={offset}>{segment}</span>
      ))}
    </span>
  );
}

function graphemeStart(text: string, offset: number) {
  if (!/[^\p{ASCII}]/u.test(text)) return offset;
  return graphemes.segment(text).containing(offset)?.index ?? offset;
}

function textRun(
  text: string,
  revealFrom: number | undefined,
  offset = 0,
  delay = 0,
  step = REVEAL_STEP_MS,
): ReactNode[] {
  if (revealFrom === undefined || revealFrom >= text.length) return [text];
  // A newly completed combining sequence/emoji stays in one shaping run.
  if (graphemeStart(text, revealFrom) < revealFrom) return [text];
  return [
    text.slice(0, revealFrom),
    <RevealedText key={offset + revealFrom} delay={delay} step={step}>
      {text.slice(revealFrom)}
    </RevealedText>,
  ];
}

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
    let [rendered, setRendered] = useState(() => ({
      text,
      runs: textRun(text, revealFrom, 0, revealDelay, revealStep),
    }));
    if (rendered.text !== text) {
      const previous = rendered;
      rendered = {
        text,
        runs:
          text.startsWith(previous.text) &&
          graphemeStart(text, previous.text.length) === previous.text.length
            ? previous.runs.concat(
                textRun(
                  text.slice(previous.text.length),
                  revealFrom === undefined
                    ? undefined
                    : Math.max(0, revealFrom - previous.text.length),
                  previous.text.length,
                  revealDelay,
                  revealStep,
                ),
              )
            : [text],
      };
      setRendered(rendered);
    }
    return rendered.runs;
  },
  (previous, next) => previous.children === next.children,
);

// Synthetic HAST elements return fragments; no wrapper boxes enter the document.
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
