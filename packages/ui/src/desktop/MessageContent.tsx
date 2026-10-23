import type { ComponentPropsWithoutRef } from 'react';
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import Markdown, { type ExtraProps } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { useConversationReadActive } from '../conversation-activity';
import { MarkdownCodeBlock, MarkdownSourceContext } from './MarkdownCodeBlock';
import { desktopMarkdownSemantics } from './markdown-extensions';
import { type PreparedDesktopMarkdown, reuseDesktopMarkdownParse } from './markdown-parse-cache';

type MarkdownNode = {
  type: string;
  tagName?: string;
  value?: string;
  spread?: boolean;
  children?: MarkdownNode[];
};

/** Preserve paragraph boxes in tight lists, including text after a code block. */
function retainListParagraphs() {
  return (tree: MarkdownNode) => {
    const pending = [tree];
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (node.type === 'list') node.spread = true;
      if (node.children) pending.push(...node.children);
    }
  };
}

/** Keep long text nodes small without omitting text or changing its normal inline flow. */
function segmentLongTextNodes() {
  return (tree: MarkdownNode) => {
    const pending = [tree];
    for (let parent = pending.pop(); parent; parent = pending.pop()) {
      if (!parent.children || parent.tagName === 'code' || parent.tagName === 'pre') continue;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value || child.value.length <= 4096) {
          if (child.children) pending.push(child);
          return [child];
        }
        const text = child.value,
          segments = /[^\p{ASCII}]/u.test(text)
            ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
            : undefined,
          parts: MarkdownNode[] = [];
        for (let offset = 0; offset < text.length; ) {
          let end = Math.min(offset + 2048, text.length);
          const boundary = segments?.containing(end);
          if (boundary && boundary.index < end)
            end =
              boundary.index > offset ? boundary.index : boundary.index + boundary.segment.length;
          parts.push({ type: 'text', value: text.slice(offset, end) });
          offset = end;
        }
        return parts;
      });
    }
  };
}

const FileLinkContext = createContext<((path: string) => void) | undefined>(undefined);

function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const openFile = useContext(FileLinkContext);
  const readActive = useConversationReadActive();
  if (!href) return <span>{children}</span>;
  if (href.startsWith('#'))
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (!readActive) return;
          const root = event.currentTarget.closest('.typeset-chat');
          const target = [...(root?.querySelectorAll<HTMLElement>('[id]') ?? [])].find(
            (element) => element.id === href.slice(1),
          );
          target?.scrollIntoView({ block: 'nearest' });
          target?.focus({ preventScroll: true });
        }}
      >
        {children}
      </a>
    );
  if (/^https?:\/\//i.test(href))
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  if (!openFile || /^[a-z][a-z\d+.-]*:/i.test(href)) return <span>{children}</span>;
  return (
    <button
      type="button"
      className="file-link"
      aria-disabled={!readActive || undefined}
      onClick={() => {
        if (!readActive) return;
        let path = href;
        try {
          path = decodeURIComponent(href);
        } catch {
          /* Native validation still applies. */
        }
        openFile(path);
      }}
    >
      {children}
    </button>
  );
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <section
      className="markdown-table-scroll"
      aria-label="表格"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Wide tables need a keyboard-scrollable reading region.
      tabIndex={0}
    >
      <table>{children}</table>
    </section>
  );
}

export const MessageContent = memo(function MessageContent({
  text,
  openFile,
  prepared,
}: {
  text: string;
  openFile?: (path: string) => void;
  prepared?: PreparedDesktopMarkdown;
}) {
  const currentOpenFile = useRef(openFile);
  useLayoutEffect(() => {
    currentOpenFile.current = openFile;
    return () => {
      currentOpenFile.current = undefined;
    };
  }, [openFile]);
  const dispatchOpenFile = useCallback((path: string) => currentOpenFile.current?.(path), []);
  return (
    <FileLinkContext.Provider value={openFile ? dispatchOpenFile : undefined}>
      <MarkdownContent text={text} prepared={prepared} />
    </FileLinkContext.Provider>
  );
});

const MarkdownContent = memo(function MarkdownContent({
  text,
  prepared,
}: {
  text: string;
  prepared?: PreparedDesktopMarkdown;
}) {
  const prefix = `md-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  return (
    <MarkdownSourceContext.Provider value={text}>
      <div className="typeset typeset-chat">
        <Markdown
          remarkPlugins={[
            remarkGfm,
            remarkMath,
            [reuseDesktopMarkdownParse, prepared],
            retainListParagraphs,
          ]}
          remarkRehypeOptions={{ footnoteLabel: '脚注', footnoteBackLabel: '返回正文' }}
          rehypePlugins={[
            [
              rehypeKatex,
              {
                trust: false,
                strict: 'ignore',
                maxExpand: 100,
                maxSize: 20,
                errorColor: 'var(--foreground)',
              },
            ],
            [desktopMarkdownSemantics, { prefix }],
            segmentLongTextNodes,
          ]}
          skipHtml
          components={{
            a: MarkdownLink,
            pre: MarkdownCodeBlock,
            table: MarkdownTable,
            // Message bodies must not fetch remote images or interpret local paths as web assets.
            img: ({ alt }) => (
              <span className="image-description">{alt ? `图片：${alt}` : '图片'}</span>
            ),
          }}
        >
          {text}
        </Markdown>
      </div>
    </MarkdownSourceContext.Provider>
  );
});
