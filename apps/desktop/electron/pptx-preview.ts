import {
  buildPresentation,
  materializeSlideNodes,
  parseZipLazyMedia,
  RECOMMENDED_ZIP_LIMITS,
  renderSlide,
  type SlideData,
  type SlideHandle,
} from '@aiden0z/pptx-renderer/browser';
import { installRenderedOfficeInteraction } from './office-preview-interaction';
import { fitOfficePages, startOfficePreview } from './office-preview-source';

const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';

function anchorSlideObjects(surface: HTMLElement, slide: SlideData, failures: ReadonlySet<string>) {
  // The pinned renderer draws background, master and layout before the visible slide
  // nodes, in source order. Check the geometry before attributing any rendered object.
  const visible = slide.nodes.filter((node) => !node.hidden);
  const elements = Array.from(surface.children).slice(surface.childElementCount - visible.length);
  if (
    visible.length !== elements.length ||
    elements.some((element, index) => {
      const node = visible[index]!;
      return (
        !(element instanceof HTMLElement) ||
        !(Math.abs(Number.parseFloat(element.style.left) - node.position.x) < 0.01) ||
        !(Math.abs(Number.parseFloat(element.style.top) - node.position.y) < 0.01)
      );
    })
  )
    return;
  const ids = new Map<string, number>();
  for (const node of slide.nodes)
    for (const properties of Array.from(
      node.source.element?.getElementsByTagNameNS(presentationNs, 'cNvPr') ?? [],
    )) {
      const id = properties.getAttribute('id');
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
  for (const [index, node] of visible.entries()) {
    if (!/^\d+$/.test(node.id) || ids.get(node.id) !== 1 || failures.has(node.id)) continue;
    const path = `/slide[${slide.index + 1}]/${slide.slidePath}#cNvPr[id=${node.id}]`;
    elements[index]!.setAttribute('data-path', path);
  }
}

startOfficePreview('presentation.pptx', async (root, bytes) => {
  const parts = await parseZipLazyMedia(bytes, RECOMMENDED_ZIP_LIMITS);
  const presentation = buildPresentation(parts, { lazySlides: true });
  if (!presentation.slides.length || presentation.slides.length > 1000)
    throw Error('preview_pptx_slide_budget');
  const css = document.createElement('style');
  css.textContent = `body{margin:0}#office-preview{box-sizing:border-box;padding:10px;min-width:0}
    .main > .slide-container{display:flex;width:max-content;margin:0 auto 14px;box-shadow:0 0 2px #0005}
    .slide{color-scheme:light}
    body.kite-present #office-preview{padding:8px}`;
  document.head.append(css);
  root.classList.add('main');
  const handles: SlideHandle[] = [];
  const dispose = () => {
    for (const handle of handles) handle.dispose();
  };
  window.addEventListener('pagehide', dispose, { once: true });
  const pages: HTMLElement[] = [];
  for (const slide of presentation.slides) {
    materializeSlideNodes(presentation, slide);
    const errors = new Set<string>();
    const handle = renderSlide(presentation, slide, {
      externalMedia: 'block',
      onNodeError: (id) => errors.add(id),
    });
    handles.push(handle);
    const page = document.createElement('section');
    page.className = 'slide-container';
    handle.element.classList.add('slide');
    page.append(handle.element);
    root.append(page);
    pages.push(page);
    await handle.ready;
    for (const link of page.querySelectorAll('a[href]')) link.removeAttribute('href');
    anchorSlideObjects(handle.element, slide, errors);
  }
  fitOfficePages(root, pages);
  installRenderedOfficeInteraction('powerpoint', root.dataset.editable === 'true');
});
