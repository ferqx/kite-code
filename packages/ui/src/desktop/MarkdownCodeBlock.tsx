import { isValidElement, type ReactNode, useContext } from 'react';
import { CodeCopyEligibilityContext } from './clipboard';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from './components/ui/code-block';

/** Adapt only block code; inline code keeps the Markdown renderer's original semantics. */
export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const canCopy = useContext(CodeCopyEligibilityContext);
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children))
    return <pre>{children}</pre>;
  const { className, children: code } = children.props;
  if (typeof code !== 'string') return <pre>{children}</pre>;
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? '')?.[1];
  return (
    <CodeBlock className="markdown-code-block">
      <CodeBlockHeader>
        <CodeBlockTitle>{language || '代码'}</CodeBlockTitle>
        {canCopy && (
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        )}
      </CodeBlockHeader>
      <CodeBlockContent
        codeClassName={className}
        aria-label={language ? `${language} 代码` : '代码'}
      >
        {code}
      </CodeBlockContent>
    </CodeBlock>
  );
}
