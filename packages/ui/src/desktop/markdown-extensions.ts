import GithubSlugger from 'github-slugger';

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

const alerts: Record<string, string> = {
  NOTE: '说明',
  TIP: '提示',
  IMPORTANT: '重要',
  WARNING: '警告',
  CAUTION: '注意',
};
const textContent = (node: Node): string =>
  node.value ?? node.children?.map(textContent).join('') ?? '';

/** Only generated HAST is transformed; raw HTML remains disabled by the renderer. */
export function desktopMarkdownSemantics({ prefix }: { prefix: string }) {
  return (tree: Node) => {
    const slugger = new GithubSlugger();
    const nodes: Node[] = [];
    const walk = (node: Node) => {
      nodes.push(node);
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    const ids = new Map<string, string>();
    // Reserve renderer-generated footnote IDs before allocating heading slugs.
    for (const node of nodes) {
      if (typeof node.properties?.id === 'string') slugger.slug(node.properties.id);
    }
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      node.properties ??= {};
      const props = node.properties;
      if (/^h[1-6]$/.test(node.tagName ?? '') && !props.id)
        props.id = slugger.slug(textContent(node) || 'section');
      if (typeof props.id === 'string') {
        const id = `${prefix}${props.id}`;
        ids.set(props.id, id);
        props.id = id;
        if (node.tagName !== 'a') props.tabIndex = -1;
      }
      if (node.tagName !== 'blockquote') continue;
      const firstElement = node.children?.find((child) => child.type === 'element');
      const paragraph = firstElement?.tagName === 'p' ? firstElement : undefined;
      const first = paragraph?.children?.[0];
      const marker =
        first?.type === 'text' &&
        /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.exec(first.value ?? '');
      if (!marker || !first) continue;
      first.value = first.value!.slice(marker[0].length);
      props.className = ['markdown-alert'];
      props['data-alert'] = marker[1]!.toLowerCase();
      node.children!.unshift({
        type: 'element',
        tagName: 'p',
        properties: { className: ['markdown-alert-title'] },
        children: [{ type: 'text', value: alerts[marker[1]!]! }],
      });
      if (paragraph && !textContent(paragraph))
        node.children = node.children!.filter((child) => child !== paragraph);
    }
    for (const node of nodes) {
      const props = node.properties;
      if (!props) continue;
      if (typeof props.href === 'string' && props.href.startsWith('#')) {
        try {
          const id = ids.get(decodeURIComponent(props.href.slice(1)));
          // A fragment can only target this exact message, never another message or app element.
          props.href = id ? `#${id}` : undefined;
        } catch {
          props.href = undefined;
        }
      }
      if (Array.isArray(props.ariaDescribedBy))
        props.ariaDescribedBy = props.ariaDescribedBy.map((id) => ids.get(String(id)) ?? id);
    }
  };
}
