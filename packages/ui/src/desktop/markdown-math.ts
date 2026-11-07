/** Fixed rendering limits for all Markdown messages. */
export const desktopKatexOptions = {
  trust: false,
  strict: 'ignore' as const,
  maxExpand: 100,
  maxSize: 20,
  errorColor: 'var(--foreground)',
};

type MathNode = {
  type: string;
  tagName?: string;
  children?: MathNode[];
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
};
/** Give inline and display math the same layout boundary before KaTeX replaces its input. */
export function wrapMarkdownMath() {
  return (tree: MathNode) => {
    const visit = (parent: MathNode) => {
      parent.children = parent.children?.map((node) => {
        const code =
          node.tagName === 'pre'
            ? node.children?.find((child) => child.tagName === 'code')
            : node.tagName === 'code'
              ? node
              : undefined;
        const classes = code?.properties?.className;
        if (
          Array.isArray(classes) &&
          classes.some((name) => /^(language-math|math-inline|math-display)$/.test(String(name)))
        )
          return {
            type: 'element',
            tagName: node.tagName === 'pre' ? 'div' : 'span',
            position: node.position,
            properties: {
              className: [
                node.tagName === 'pre' ? 'markdown-math-display' : 'markdown-math-inline',
              ],
            },
            children: [node],
          };
        visit(node);
        return node;
      });
    };
    visit(tree);
  };
}
