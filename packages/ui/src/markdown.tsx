import { memo } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Pure full-body presentation: no HTML execution, image fetch, file editor or network owner. */
export const SafeMessageMarkdown = memo(function SafeMessageMarkdown({
  content,
}: {
  readonly content: string;
}) {
  return (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={defaultUrlTransform}
        components={{
          img: ({ alt }) => <span>{alt ?? ''}</span>,
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
});
