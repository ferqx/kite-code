/** Small, non-interactive Mermaid subset. Rejected content remains available as source. */
export function diagramRestriction(source: string): string | undefined {
  if (source.length > 16384) return '图表较大，请查看源码';
  const body = source.replace(/^\s*%%[^\n]*\n/gm, '').trim();
  if (
    !/^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram)\b/.test(body)
  )
    return '此图表类型暂不支持，请查看源码';
  if (
    /%%\{|^\s*---|@\{|<\s*[a-z!/]|\b(?:click|classDef|linkStyle|style|href|img|icon)\b|url\s*\(|@import/i.test(
      source,
    )
  )
    return '图表含自定义样式或交互内容，请查看源码';
  return undefined;
}

export function isClosedDiagramFence(
  source: string,
  position?: { start: { offset?: number }; end: { offset?: number } },
): boolean {
  if (position?.start.offset === undefined || position.end.offset === undefined) return false;
  const lines = source.slice(position.start.offset, position.end.offset).trimEnd().split(/\r?\n/);
  const opening = /^\s*(`{3,}|~{3,})/.exec(lines[0] ?? '')?.[1];
  const lineStart = source.lastIndexOf('\n', position.start.offset - 1) + 1;
  const quoteDepth = (source.slice(lineStart, position.start.offset).match(/>/g) ?? []).length;
  let lastLine = lines.at(-1) ?? '';
  for (let depth = 0; depth < quoteDepth; depth++) lastLine = lastLine.replace(/^\s*>[ \t]?/, '');
  const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(lastLine)?.[1];
  return (
    lines.length > 1 &&
    !!opening &&
    !!closing &&
    closing[0] === opening[0] &&
    closing.length >= opening.length
  );
}

// initialize + render must be serialized together because Mermaid owns global configuration.
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;
export interface DiagramColors {
  foreground: string;
  accent: string;
  secondary: string;
}
export function renderMarkdownDiagram(
  source: string,
  { foreground, accent, secondary }: DiagramColors,
  signal: AbortSignal,
): Promise<string> {
  const job = queue
    .catch(() => {})
    .then(async () => {
      if (signal.aborted) throw new Error('aborted');
      const restriction = diagramRestriction(source);
      if (restriction) throw new Error(restriction);
      const { default: mermaid } = await import('mermaid');
      if (signal.aborted) throw new Error('aborted');
      const container = document.createElement('div');
      container.style.cssText =
        'position:fixed;left:-100000px;top:0;width:1000px;visibility:hidden;pointer-events:none';
      container.setAttribute('aria-hidden', 'true');
      document.body.append(container);
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          maxTextSize: 16384,
          maxEdges: 250,
          theme: 'base',
          themeCSS: '* { filter: none !important; }',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          dompurifyConfig: { ALLOWED_TAGS: [], ALLOWED_ATTR: [] },
          themeVariables: {
            background: 'transparent',
            primaryColor: 'transparent',
            secondaryColor: 'transparent',
            tertiaryColor: 'transparent',
            primaryTextColor: foreground,
            secondaryTextColor: foreground,
            tertiaryTextColor: foreground,
            primaryBorderColor: accent,
            secondaryBorderColor: secondary,
            tertiaryBorderColor: secondary,
            lineColor: accent,
            textColor: foreground,
            nodeTextColor: foreground,
            mainBkg: 'transparent',
            nodeBorder: accent,
            clusterBkg: 'transparent',
            clusterBorder: secondary,
            actorBkg: 'transparent',
            actorBorder: accent,
            actorTextColor: foreground,
            actorLineColor: secondary,
            signalColor: accent,
            signalTextColor: foreground,
            labelBoxBkgColor: 'transparent',
            labelBoxBorderColor: secondary,
            labelTextColor: foreground,
            loopTextColor: foreground,
            noteBkgColor: 'transparent',
            noteBorderColor: secondary,
            noteTextColor: foreground,
            edgeLabelBackground: 'transparent',
            fontFamily: 'system-ui, sans-serif',
          },
        });
        const { svg } = await mermaid.render(`markdown-diagram-${++nextId}`, source, container);
        if (signal.aborted) throw new Error('aborted');
        const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const image = document.documentElement;
        const [, , width, height] = (image.getAttribute('viewBox') ?? '')
          .split(/[\s,]+/)
          .map(Number);
        if (
          !width ||
          !height ||
          width > 12000 ||
          height > 12000 ||
          width * height > 16000000 ||
          svg.length > 2000000
        )
          throw new Error('diagram_too_large');
        image.setAttribute('width', String(Math.ceil(width)));
        image.setAttribute('height', String(Math.ceil(height)));
        // Image mode disables SVG scripting/navigation; never mount generated markup in the app DOM.
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(image))}`;
      } finally {
        container.remove();
      }
    });
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}
