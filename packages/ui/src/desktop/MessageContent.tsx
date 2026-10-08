import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const MessageContent = memo(function MessageContent({
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
