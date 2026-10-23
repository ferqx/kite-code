import {
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { ExtraProps } from 'react-markdown';
import { useConversationReadActive } from '../conversation-activity';
import { CodeCopyEligibilityContext } from './clipboard';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from './components/ui/code-block';
import { MarkdownDiagram } from './MarkdownDiagram';
import { isClosedDiagramFence } from './markdown-diagram';
import { highlightMarkdownCode } from './markdown-highlight';

/** Adapt only block code; inline code keeps the Markdown renderer's original semantics. */
export const MarkdownSourceContext = createContext('');

export function MarkdownCodeBlock({ children, node }: { children?: ReactNode } & ExtraProps) {
  const canCopy = useContext(CodeCopyEligibilityContext);
  const source = useContext(MarkdownSourceContext);
  const readActive = useConversationReadActive();
  const [sourceVisible, setSourceVisible] = useState(false);
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children))
    return <pre>{children}</pre>;
  const { className, children: code } = children.props;
  if (typeof code !== 'string') return <pre>{children}</pre>;
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? '')?.[1];
  const diagram = language?.toLowerCase() === 'mermaid';
  return (
    <CodeBlock className="markdown-code-block">
      <CodeBlockHeader>
        <CodeBlockTitle>{language || '代码'}</CodeBlockTitle>
        {(canCopy || diagram) && (
          <CodeBlockActions>
            {diagram && (
              <button
                type="button"
                className="markdown-source-toggle"
                aria-pressed={sourceVisible}
                aria-disabled={!readActive || undefined}
                onClick={() => {
                  if (readActive) setSourceVisible((value) => !value);
                }}
              >
                {sourceVisible ? '图表' : '源码'}
              </button>
            )}
            {canCopy && <CodeBlockCopyButton value={code} />}
          </CodeBlockActions>
        )}
      </CodeBlockHeader>
      {diagram ? (
        <MarkdownDiagram
          code={code}
          complete={isClosedDiagramFence(source, node?.position)}
          sourceVisible={sourceVisible}
        />
      ) : (
        <CodeBlockContent
          codeClassName={className}
          aria-label={language ? `${language} 代码` : '代码'}
        >
          <HighlightedCode code={code} language={language} />
        </CodeBlockContent>
      )}
    </CodeBlock>
  );
}

function HighlightedCode({ code, language }: { code: string; language?: string }) {
  return useMemo(() => highlightMarkdownCode(code, language?.toLowerCase()), [code, language]);
}
