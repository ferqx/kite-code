import { memo } from 'react';
import { terminalText } from './controller';
import MarkdownBlock from './ink/MarkdownBlock';

/** The original Ink Markdown renderer, using the new public body reader. */
export const TerminalMarkdown = memo(function TerminalMarkdown({
  content,
  streaming = false,
  maxWidth,
}: {
  content: string;
  streaming?: boolean;
  maxWidth?: number;
}) {
  return (
    <MarkdownBlock content={terminalText(content)} streaming={streaming} maxWidth={maxWidth} />
  );
});
