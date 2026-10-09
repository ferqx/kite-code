import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownNode = {
  type: string;
  tagName?: string;
  value?: string;
  children?: MarkdownNode[];
};

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

export const MessageContent = memo(function MessageContent({
  text,
  openFile,
}: {
  text: string;
  openFile?: (path: string) => void;
}) {
  const currentOpenFile = useRef(openFile);
  useLayoutEffect(() => {
    currentOpenFile.current = openFile;
    return () => {
      currentOpenFile.current = undefined;
    };
  }, [openFile]);
  const dispatchOpenFile = useCallback((path: string) => currentOpenFile.current?.(path), []);
  return <MarkdownContent text={text} openFile={openFile ? dispatchOpenFile : undefined} />;
});

const MarkdownContent = memo(function MarkdownContent({
  text,
  openFile,
}: {
  text: string;
  openFile?: (path: string) => void;
}) {
  return (
    <div className="typeset typeset-chat">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[segmentLongTextNodes]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            if (/^https?:\/\//i.test(href))
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            if (!openFile || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href))
              return <span>{children}</span>;
            return (
              <button
                type="button"
                className="file-link"
                onClick={() => {
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
          },
          // Message bodies must not fetch remote images or interpret local paths as web assets.
          img: ({ alt }) => (
            <span className="image-description">{alt ? `图片：${alt}` : '图片'}</span>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
