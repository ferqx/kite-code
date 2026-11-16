import { defaultOptions, parseAsync, renderDocument } from 'docx-preview';
import {
  installRenderedOfficeInteraction,
  type WordTextSource,
} from './office-preview-interaction';
import { fitOfficePages, startOfficePreview } from './office-preview-source';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const marker = '--kite-word-source';
const blockTypes = { p: 'paragraph', tbl: 'table', altChunk: 'altChunk' } as const;
type WordBlock = { type: string; children?: WordBlock[]; cssStyle?: Record<string, string> };
type Source = { element: Element; path: string };

function sourceChildren({ element, path }: Source) {
  const counts = new Map<string, number>();
  return Array.from(element.children)
    .filter((child) => child.namespaceURI === wordNamespace)
    .map((child) => {
      const tag = child.localName;
      const index = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, index);
      return { element: child, path: `${path}/${tag}[${index}]` };
    });
}

function sourceBlocks(parent: Source): Source[] {
  return sourceChildren(parent).flatMap((source) => {
    if (Object.hasOwn(blockTypes, source.element.localName)) return [source];
    if (source.element.localName === 'sdt') {
      const content = sourceChildren(source).find(
        (child) => child.element.localName === 'sdtContent',
      );
      if (content) return sourceBlocks(content);
    }
    return [];
  });
}

function pairBlocks(body: WordBlock, source: Source, anchors: Source[]) {
  const nodes = body.children ?? [];
  // docx-preview keeps these block orders, and flattens block-level content controls.
  const blocks = sourceBlocks(source);
  if (
    nodes.length !== blocks.length ||
    nodes.some(
      (node, index) =>
        node.type !== blockTypes[blocks[index]!.element.localName as keyof typeof blockTypes],
    )
  )
    return;
  for (const [index, node] of nodes.entries()) {
    const block = blocks[index]!;
    if (node.type === 'paragraph') {
      const id = anchors.push(block);
      node.cssStyle = { ...node.cssStyle, [marker]: String(id) };
      continue;
    }
    if (node.type !== 'table') continue;
    const rows = sourceChildren(block).filter((child) => child.element.localName === 'tr');
    if (rows.length !== node.children?.length) continue;
    for (const [rowIndex, row] of node.children.entries()) {
      const cells = sourceChildren(rows[rowIndex]!).filter(
        (child) => child.element.localName === 'tc',
      );
      if (row.type !== 'row' || cells.length !== row.children?.length) continue;
      for (const [column, cell] of row.children.entries())
        if (cell.type === 'cell') pairBlocks(cell, cells[column]!, anchors);
    }
  }
}

function renderedWordText(fragment: Element, sourceNodes: WeakSet<Node>) {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const runs: { start: number; length: number }[] = [];
  const fragments: string[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (sourceNodes.has(node) && text) {
      runs.push({ start: offset, length: text.length });
      fragments.push(text);
    }
    offset += text.length;
  }
  return { runs, text: fragments.join('') };
}

startOfficePreview('document.docx', async (root, bytes) => {
  const options = {
    className: 'kite-docx',
    renderAltChunks: false,
    ignoreLastRenderedPageBreak: false,
    useBase64URL: true,
  };
  // The version-pinned renderer exposes its parsed model and resolved main part.
  const doc = (await parseAsync(bytes, options)) as {
    documentPart?: { path: string; body: WordBlock };
    _package: { load(path: string): Promise<string | null> };
  };
  if (!doc.documentPart?.body) throw Error('preview_docx_main_part_missing');
  const sourceXml = await doc._package.load(doc.documentPart.path);
  const xml = new DOMParser().parseFromString(sourceXml ?? '', 'application/xml');
  const body = xml.getElementsByTagNameNS(wordNamespace, 'body').item(0);
  const anchors: Source[] = [];
  if (body) pairBlocks(doc.documentPart.body, { element: body, path: '/body' }, anchors);

  const rendered = new Map<number, Element[]>();
  const sourceNodes = new WeakSet<Node>();
  root.append(
    ...(await renderDocument(doc, {
      ...options,
      h(value) {
        // The pinned renderer passes authored text directly to h. Its generated
        // markers pass strings as children of an element instead.
        if (typeof value === 'string') {
          const node = defaultOptions.h(value);
          sourceNodes.add(node);
          return node;
        }
        if (value instanceof Node || !value.style || typeof value.style !== 'object')
          return defaultOptions.h(value);
        const { [marker]: token, ...style } = value.style;
        if (!token) return defaultOptions.h(value);
        const element = defaultOptions.h({ ...value, style });
        if (element instanceof Element && value.tagName === 'p') {
          const id = Number(token);
          const fragments = rendered.get(id) ?? [];
          fragments.push(element);
          rendered.set(id, fragments);
        }
        return element;
      },
    })),
  );
  const wordSources = new WeakMap<Element, WordTextSource>();
  for (const [id, fragments] of rendered) {
    const source = anchors[id - 1];
    if (!source) continue;
    const parts = fragments.filter((fragment) => root.contains(fragment));
    const mapped = parts.map((fragment) => renderedWordText(fragment, sourceNodes));
    const text = Array.from(
      source.element.getElementsByTagNameNS(wordNamespace, 't'),
      (run) => run.textContent,
    ).join('');
    // Validate even one fragment. A saved page break can split a source paragraph.
    if (mapped.map((part) => part.text).join('') !== text) continue;
    let offset = 0;
    for (const [index, fragment] of parts.entries()) {
      const { runs, text: fragmentText } = mapped[index]!;
      const start = offset;
      fragment.setAttribute('data-path', source.path);
      if (start) fragment.setAttribute('data-kite-word-offset', String(start));
      wordSources.set(fragment, {
        text,
        offsetAt(renderedOffset) {
          let position = start;
          for (const run of runs) {
            if (renderedOffset <= run.start) break;
            position += Math.min(renderedOffset - run.start, run.length);
          }
          return position;
        },
      });
      offset += fragmentText.length;
    }
  }
  const pages = Array.from(
    root.querySelectorAll<HTMLElement>('.kite-docx-wrapper > section.kite-docx'),
  );
  if (!pages.length) throw Error('preview_docx_pages_missing');
  const wrappers = pages.map((page) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    page.classList.add('page');
    const articles = Array.from(page.querySelectorAll(':scope > article'));
    if (articles.length === 1) articles[0]!.classList.add('page-body');
    else if (articles.length > 1) {
      const content = document.createElement('div');
      content.className = 'page-body';
      articles[0]!.before(content);
      content.append(...articles);
    }
    page.before(wrapper);
    wrapper.append(page);
    return wrapper;
  });
  for (const link of root.querySelectorAll('a[href]')) link.removeAttribute('href');
  const css = document.createElement('style');
  css.textContent = `body{margin:0}.kite-docx-wrapper{padding:10px 10px 0!important;background:transparent!important;align-items:safe center!important}
    .page-wrapper{margin-bottom:14px;flex:none;box-shadow:0 0 2px #0005}
    section.kite-docx.page{width:816px;background-color:#fff;color-scheme:light;font-family:Calibri,Arial,sans-serif}
    section.kite-docx>.page-body{margin-bottom:auto;z-index:1}`;
  document.head.append(css);
  await Promise.all([
    document.fonts.ready,
    ...Array.from(root.querySelectorAll('img'), (img) => img.decode().catch(() => {})),
  ]);
  const metadata = document.documentElement.dataset;
  metadata.kiteWordPaginationState = 'pending';
  let generation = 0;
  fitOfficePages(root, wrappers, () => {
    metadata.kiteWordPaginationGeneration = String(++generation);
    metadata.kiteWordPaginationState = 'settled';
  });
  installRenderedOfficeInteraction('word', root.dataset.editable === 'true', wordSources);
});
