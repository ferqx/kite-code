import { installPageRail } from './document-page-rail';
export function pdfPreviewHtml(pages: number) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500)
    throw Error('preview_pdf_page_budget');
  return `<!doctype html><meta charset="utf-8"><style>:root{--office-background:#fff;--office-border:#ddd;--office-muted:#888;--office-foreground:#222}body{margin:0;background:#eee;font:13px system-ui}nav{overflow:auto;box-sizing:border-box;padding:8px 4px;background:white}nav button{position:relative;display:block;width:96px;padding:4px;margin:0 0 8px;border:1px solid transparent;border-radius:6px;background:white}nav button[aria-current=true]{border-color:#555}nav img{display:block;width:86px;height:110px;object-fit:contain}main{padding:16px;overflow:auto}main img{display:block;max-width:none;margin:auto;background:white}p{padding:12px}</style><nav aria-label="PDF 预览页">${Array.from({ length: pages }, (_, i) => `<button type="button" data-page="${i + 1}" aria-label="预览第 ${i + 1} 页"><img loading="lazy" src="page-${i + 1}.png" alt=""><span>${i + 1}</span></button>`).join('')}</nav><main><p role="status"></p><img alt="第 1 页"></main>`;
}
function installPdf(railInstaller: typeof installPageRail) {
  const rail = document.querySelector('nav')!;
  railInstaller(rail);
  const image = document.querySelector('main img') as HTMLImageElement;
  const status = document.querySelector('[role=status]')!;
  let page = 1,
    zoom: number | 'fit' = 'fit';
  const size = () => {
    image.style.width =
      zoom === 'fit'
        ? `${Math.max(1, innerWidth - (innerWidth < 600 ? 40 : 112) - 32)}px`
        : `${image.naturalWidth * zoom}px`;
  };
  const show = (next: number) => {
    page = next;
    status.textContent = '正在读取页面…';
    image.style.visibility = 'hidden';
    rail.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-current', String(Number(b.dataset.page) === page));
    });
    image.src = `page-${page}.png`;
    image.alt = `第 ${page} 页`;
  };
  image.onload = () => {
    status.textContent = '';
    image.style.visibility = 'visible';
    size();
  };
  image.onerror = () => {
    status.textContent = '此页读取失败，请重新打开预览';
    image.style.visibility = 'hidden';
  };
  rail.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('button');
    if (b?.parentElement === rail) show(Number(b.dataset.page));
  });
  window.addEventListener('resize', size);
  Object.assign(globalThis, {
    kitePdfPreview: {
      control(command: { kind: string; value: number | 'fit' }) {
        if (command.kind !== 'zoom') return;
        zoom = command.value;
        size();
      },
    },
  });
  show(1);
}
export const pdfPreviewInstallScript = () =>
  `(${installPdf.toString()})(${installPageRail.toString()})`;
