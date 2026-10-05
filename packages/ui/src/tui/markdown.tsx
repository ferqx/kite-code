import { memo, type ReactNode, useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

interface Node {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
/** Real Markdown AST; URLs and media stay visible text, never terminal escape hyperlinks. */
export const TerminalMarkdown = memo(function TerminalMarkdown({ content }: { content: string }) {
  const { t } = useTuiPresentation();
  const tree = useMemo(
    () => unified().use(remarkParse).use(remarkGfm).parse(content) as Node,
    [content],
  );
  function children(node: Node): ReactNode {
    return node.children?.map((child, index) => <Text key={index}>{render(child)}</Text>);
  }
  function render(node: Node): ReactNode {
    if (node.type === 'text' || node.type === 'html' || node.type === 'inlineCode')
      return <Text>{terminalText(node.value ?? '')}</Text>;
    if (node.type === 'strong' || node.type === 'heading')
      return (
        <Text bold>
          {children(node)}
          {node.type === 'heading' ? '\n\n' : ''}
        </Text>
      );
    if (node.type === 'emphasis') return <Text italic>{children(node)}</Text>;
    if (node.type === 'delete') return <Text strikethrough>{children(node)}</Text>;
    if (node.type === 'paragraph')
      return (
        <Text>
          {children(node)}
          {'\n\n'}
        </Text>
      );
    if (node.type === 'code')
      return (
        <Text>
          {terminalText(node.value ?? '')}
          {'\n\n'}
        </Text>
      );
    if (
      node.type === 'link' &&
      node.children?.length === 1 &&
      node.children[0]?.type === 'text' &&
      node.children[0]?.value === node.url
    )
      return <Text>{children(node)}</Text>;
    if (node.type === 'link')
      return (
        <Text>
          {children(node)} {'('}
          {terminalText(node.url ?? '')}
          {')'}
        </Text>
      );
    if (node.type === 'image')
      return (
        <Text>
          {t('[image:')} {terminalText(node.alt ?? '')}
          {t('] (')}
          {terminalText(node.url ?? '')}
          {')'}
        </Text>
      );
    if (node.type === 'blockquote')
      return (
        <Text>
          {t('Quote:')} {children(node)}
        </Text>
      );
    if (node.type === 'list')
      return (
        <Text>
          {node.children?.map((child, index) => (
            <Text key={index}>
              {node.ordered ? `${(node.start ?? 1) + index}. ` : '• '}
              {children(child)}
              {'\n'}
            </Text>
          ))}
        </Text>
      );
    if (node.type === 'table')
      return (
        <Text>
          {node.children?.map((row, index) => (
            <Text key={index}>
              {row.children?.map((cell, column) => (
                <Text key={column}>
                  {column ? ' | ' : ''}
                  {children(cell)}
                </Text>
              ))}
              {'\n'}
            </Text>
          ))}
        </Text>
      );
    if (node.type === 'break') return '\n';
    if (node.type === 'thematicBreak') return '───\n';
    if (node.type === 'root') return children(node);
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    return (
      <Text>
        {start !== undefined && end !== undefined
          ? terminalText(content.slice(start, end))
          : children(node)}
      </Text>
    );
  }
  return <Text>{render(tree)}</Text>;
});
