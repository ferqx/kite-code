import { memo } from 'react';
import { terminalText } from './controller';
import MarkdownBlock, { type MarkdownRenderSlice } from './ink/MarkdownBlock';

/** The original Ink Markdown renderer, using the new public body reader. */
export const TerminalMarkdown = memo(function TerminalMarkdown({
  content,
  streaming = false,
  maxWidth,
  parsedSlice,
}: {
  content: string;
  streaming?: boolean;
  maxWidth?: number;
  parsedSlice?: MarkdownRenderSlice;
}) {
  return (
    <MarkdownBlock
      content={terminalText(content)}
      streaming={streaming}
      maxWidth={maxWidth}
      parsedSlice={parsedSlice}
    />
  );
});
