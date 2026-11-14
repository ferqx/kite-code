import type { PdfSelection } from '../src/output-files-bridge';
import { installPageRail } from './document-page-rail';
import type { OfficeInteraction } from './office-preview-interaction';
export type PdfTextLayer = {
  status: 'available' | 'empty' | 'unavailable';
  width: number;
  height: number;
  items: {
    text: string;
    transform: number[];
    width: number;
    height: number;
    ascent: number | null;
    descent: number | null;
    vertical: boolean;
    dir: string;
    fontFamily: string;
    hasEOL: boolean;
  }[];
};
export function pdfPreviewHtml(pages: number) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500)
    throw Error('preview_pdf_page_budget');
  return `<!doctype html><meta charset="utf-8"><style>:root{--office-background:#fff;--office-border:#ddd;--office-muted:#888;--office-foreground:#222}body{margin:0;background:#eee;font:13px system-ui}nav{overflow:auto;box-sizing:border-box;padding:8px 4px;background:white}nav button{position:relative;display:block;width:96px;padding:4px;margin:0 0 8px;border:1px solid transparent;border-radius:6px;background:white}nav button[aria-current=true]{border-color:#555}nav img{display:block;width:86px;height:110px;object-fit:contain}main{padding:16px;overflow:auto}.page{position:relative;width:fit-content;margin:auto}main img{display:block;max-width:none;background:white}.text{position:absolute;inset:0;overflow:hidden;line-height:1}.text span{position:absolute;white-space:pre;transform-origin:0 0;color:transparent;cursor:text}.text ::selection{background:#4094ff66}.region{position:absolute;pointer-events:none;border:1px solid #4285f4;background:#4285f422;box-sizing:border-box}.request{position:fixed;z-index:5;border:1px solid #ddd;border-radius:8px;background:white;padding:6px 10px;box-shadow:0 2px 8px #0002;font:12px system-ui}p{padding:12px}</style><nav aria-label="PDF 预览页">${Array.from({ length: pages }, (_, i) => `<button type="button" data-page="${i + 1}" aria-label="预览第 ${i + 1} 页"><img loading="lazy" src="page-${i + 1}.png" alt=""><span>${i + 1}</span></button>`).join('')}</nav><main><p role="status"></p><div class="page"><img alt="第 1 页"><div class="text" title="选择文字；按住 Alt 拖动可选择区域" aria-label="PDF 文字与区域选择"></div><div class="region" hidden></div></div></main><button class="request" hidden type="button">请求修改</button>`;
}
function installPdf(railInstaller: typeof installPageRail) {
  const rail = document.querySelector('nav')!;
  railInstaller(rail);
  const image = document.querySelector('main img') as HTMLImageElement;
  const text = document.querySelector('.text') as HTMLElement;
  const region = document.querySelector('.region') as HTMLElement;
  const trigger = document.querySelector('.request') as HTMLButtonElement;
  const status = document.querySelector('[role=status]')!;
  let pageRequest = false;
  let imageFailed = false;
  let page = 1,
    zoom: number | 'fit' = 'fit',
    ready = false;
  let layer: PdfTextLayer | undefined,
    selected: PdfSelection | null = null;
  let frozen: PdfSelection | undefined,
    serial = 0,
    request = 0,
    invalidated = 0;
  let anchor: OfficeInteraction['requestAnchor'];
  let start: { x: number; y: number } | undefined;
  const refreshStatus = () => {
    status.textContent = imageFailed
      ? '此页读取失败，请重新打开预览'
      : !ready
        ? '正在读取页面…'
        : layer?.status === 'unavailable'
          ? '文字层不可用，可拖选区域或请求修改整页'
          : '';
    (status as HTMLElement).hidden = !status.textContent;
  };
  const pageSelection = (): PdfSelection => ({
    kind: 'pdf',
    page,
    pageBasis: 'pdf-rendered',
    scope: 'page',
    rects: [],
  });
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const point = (x: number, y: number) => {
    const r = image.getBoundingClientRect();
    return { x: clamp((x - r.x) / r.width), y: clamp((y - r.y) / r.height) };
  };
  const hide = () => {
    trigger.hidden = true;
    region.hidden = true;
    selected = null;
    getSelection()?.removeAllRanges();
  };
  const invalidate = () => {
    if (request) invalidated = request;
    request = 0;
    frozen = undefined;
    hide();
  };
  const place = () => {
    if (!selected || !ready) return;
    const r = image.getBoundingClientRect();
    const box = selected.rects.at(-1);
    const x = box ? r.x + (box.x + box.width) * r.width : r.x + 12;
    const y = box ? r.y + (box.y + box.height) * r.height : r.y + 12;
    anchor = {
      x: Math.max(0, Math.min(innerWidth - 20, x)),
      y: Math.max(0, Math.min(innerHeight - 20, y)),
      width: 0,
      height: 0,
    };
    trigger.style.left = `${Math.max(4, Math.min(innerWidth - 90, x))}px`;
    trigger.style.top = `${Math.max(4, Math.min(innerHeight - 32, y))}px`;
    trigger.hidden = false;
  };
  const draw = () => {
    text.replaceChildren();
    if (layer?.status !== 'available') return;
    const scale = image.getBoundingClientRect().width / layer.width;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    layer.items.forEach((item, i) => {
      const t = item.transform as [number, number, number, number, number, number];
      let angle = Math.atan2(t[1], t[0]);
      if (item.vertical) angle += Math.PI / 2;
      const height = Math.hypot(t[2], t[3]);
      context.font = `${height}px ${item.fontFamily}`;
      const metrics = context.measureText('');
      const fontTotal = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
      const ratio =
        Number.isFinite(fontTotal) && fontTotal > 0
          ? metrics.fontBoundingBoxAscent / fontTotal
          : (item.ascent ?? 0.8);
      const ascent = height * ratio;
      const span = document.createElement('span');
      span.dataset.item = String(i);
      span.textContent = item.text;
      span.dir = item.dir === 'rtl' ? 'rtl' : 'ltr';
      span.style.left = `${(t[4] + ascent * Math.sin(angle)) * scale}px`;
      span.style.top = `${(t[5] - ascent * Math.cos(angle)) * scale}px`;
      span.style.fontSize = `${height * scale}px`;
      span.style.fontFamily = item.fontFamily;
      context.font = `${height}px ${item.fontFamily}`;
      const measured = context.measureText(item.text).width;
      const width = item.vertical ? item.height : item.width;
      span.style.transform = `rotate(${angle}rad) scaleX(${measured > 0 ? width / measured : 1})`;
      text.append(span);
    });
  };
  const size = () => {
    image.style.width =
      zoom === 'fit'
        ? `${Math.max(1, innerWidth - (innerWidth < 600 ? 40 : 112) - 32)}px`
        : `${image.naturalWidth * zoom}px`;
    draw();
  };
  const show = (next: number) => {
    if (request) return;
    invalidate();
    page = next;
    layer = undefined;
    ready = false;
    text.replaceChildren();
    imageFailed = false;
    refreshStatus();
    image.style.visibility = 'hidden';
    rail.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-current', String(Number(b.dataset.page) === page));
    });
    image.src = `page-${page}.png`;
    image.alt = `第 ${page} 页`;
  };
  image.onload = () => {
    ready = true;
    if (pageRequest) {
      pageRequest = false;
      selected = pageSelection();
      place();
    }
    imageFailed = false;
    refreshStatus();
    image.style.visibility = 'visible';
    size();
  };
  image.onerror = () => {
    invalidate();
    ready = false;
    imageFailed = true;
    refreshStatus();
    image.style.visibility = 'hidden';
  };
  rail.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('button');
    if (b?.parentElement === rail) show(Number(b.dataset.page));
  });
  rail.addEventListener('contextmenu', (e) => {
    if (!e.isTrusted || request) return;
    const b = (e.target as Element).closest('button');
    if (b?.parentElement !== rail) return;
    e.preventDefault();
    show(Number(b.dataset.page));
    pageRequest = true;
  });
  document.querySelector('.page')!.addEventListener('contextmenu', (e) => {
    if (!e.isTrusted || request || !ready) return;
    e.preventDefault();
    selected ??= pageSelection();
    place();
  });
  text.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || request || !ready) return;
    hide();
    if (layer?.status !== 'available' || e.altKey) {
      e.preventDefault();
      start = point(e.clientX, e.clientY);
      text.setPointerCapture(e.pointerId);
    }
  });
  const captureSelection = (e: PointerEvent | KeyboardEvent) => {
    if (!e.isTrusted || request || !ready) return;
    if (start && 'clientX' in e) {
      const end = point(e.clientX, e.clientY);
      const r = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
      start = undefined;
      if (r.width > 0.002 && r.height > 0.002) {
        selected = { ...pageSelection(), scope: 'region', rects: [r] };
        Object.assign(region.style, {
          left: `${r.x * 100}%`,
          top: `${r.y * 100}%`,
          width: `${r.width * 100}%`,
          height: `${r.height * 100}%`,
        });
        region.hidden = false;
        place();
      }
      return;
    }
    const s = getSelection();
    if (!s?.rangeCount || s.isCollapsed || !layer) return;
    const range = s.getRangeAt(0);
    const a = range.startContainer.parentElement,
      b = range.endContainer.parentElement;
    if (a?.parentElement !== text || b?.parentElement !== text) return;
    const first = Number(a.dataset.item),
      last = Number(b.dataset.item);
    if (first > last) return;
    const content = layer.items
      .slice(first, last + 1)
      .map((item, i) =>
        item.text.slice(
          i === 0 ? range.startOffset : 0,
          i === last - first ? range.endOffset : undefined,
        ),
      )
      .join('');
    if (!content.trim() || content.length > 16000) return;
    if (range.getClientRects().length > 256) return;
    const rects = [...range.getClientRects()]
      .map((r) => {
        const low = point(r.x, r.y),
          high = point(r.right, r.bottom);
        return { x: low.x, y: low.y, width: high.x - low.x, height: high.y - low.y };
      })
      .filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return;
    selected = {
      ...pageSelection(),
      scope: 'text',
      rects,
      text: content,
      start: { item: first, offset: range.startOffset },
      end: { item: last, offset: range.endOffset },
    };
    place();
  };
  text.addEventListener('pointerup', captureSelection);
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey) captureSelection(e);
  });
  const begin = () => {
    if (request || !ready) return;
    selected ??= pageSelection();
    place();
    frozen = structuredClone(selected);
    request = ++serial;
    trigger.hidden = true;
  };
  trigger.addEventListener('click', (e) => {
    if (e.isTrusted) begin();
  });
  window.addEventListener('resize', () => {
    if (request) invalidate();
    else hide();
    size();
  });
  const controller = {
    page: () => page,
    setLayer(n: number, value: PdfTextLayer) {
      if (n !== page || layer) return;
      layer = value;
      draw();
      refreshStatus();
    },
    read() {
      return {
        selection: selected ?? (ready ? pageSelection() : null),
        zoom,
        ...(request
          ? { floatingRequest: request, floatingSelection: frozen, requestAnchor: anchor }
          : {}),
        ...(invalidated ? { requestInvalidated: invalidated } : {}),
      };
    },
    releaseScope(n: number) {
      if (request === n) {
        request = 0;
        frozen = undefined;
        hide();
      }
    },
    control(command: { kind: string; value?: number | 'fit' }) {
      if (command.kind === 'request-edit') begin();
      if (command.kind === 'zoom' && !request) {
        hide();
        zoom = command.value!;
        size();
      }
    },
  };
  Object.assign(globalThis, { kitePdfPreview: controller, kiteOfficeInteraction: controller });
  show(1);
}
export const pdfPreviewInstallScript = () =>
  `(${installPdf.toString()})(${installPageRail.toString()})`;
