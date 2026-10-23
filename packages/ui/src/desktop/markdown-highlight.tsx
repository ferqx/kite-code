import { common, createLowlight } from 'lowlight';
import type { ReactNode } from 'react';

const highlighter = createLowlight(common);

type Token = {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: Token[];
};
function tokens(nodes: Token[]): ReactNode {
  return nodes.map((node, index) =>
    node.type === 'text' ? (
      node.value
    ) : (
      <span
        key={index}
        className={
          Array.isArray(node.properties?.className)
            ? node.properties.className.join(' ')
            : undefined
        }
      >
        {tokens(node.children ?? [])}
      </span>
    ),
  );
}

/** Explicit languages only. Oversized/unknown input keeps every original character. */
export function highlightMarkdownCode(code: string, language?: string): ReactNode {
  if (!language || code.length > 32768 || !highlighter.registered(language)) return code;
  try {
    return tokens(highlighter.highlight(language, code).children);
  } catch {
    return code;
  }
}
