import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { pdfPreviewHtml, pdfPreviewInstallScript } from '../electron/pdf-preview';

test('PDF navigation is isolated read-only chrome, lazy and counter-scaled', () => {
  const dom = new JSDOM(pdfPreviewHtml(3), { runScripts: 'outside-only' }),
    w = dom.window;
  w.eval(pdfPreviewInstallScript());
  const rail = w.document.querySelector('nav')!,
    img = w.document.querySelector('main img') as HTMLImageElement;
  expect(rail.querySelectorAll('button').length).toBe(3);
  expect(rail.querySelectorAll('img[loading=lazy]').length).toBe(3);
  expect(img.getAttribute('src')).toBe('page-1.png');
  (rail.querySelectorAll('button')[2] as HTMLButtonElement).click();
  expect(img.getAttribute('src')).toBe('page-3.png');
  expect(rail.querySelector('[aria-current=true]')?.getAttribute('data-page')).toBe('3');
  Object.defineProperty(img, 'naturalWidth', { value: 800 });
  w.eval('kitePdfPreview.control({kind:"zoom",value:2})');
  expect(img.style.width).toBe('1600px');
  expect(rail.style.zoom).toBe('1');
  Object.defineProperty(w, 'innerWidth', { value: 400 });
  w.dispatchEvent(new w.Event('resize'));
  expect(rail.classList.contains('kite-rail-compact')).toBe(true);
  expect(w.document.body.style.paddingLeft).toBe('40px');
  img.dispatchEvent(new w.Event('error'));
  expect(w.document.querySelector('[role=status]')?.textContent).toContain('读取失败');
  expect(w.eval('typeof kiteOfficeInteraction')).toBe('undefined');
  dom.window.close();
});
test('PDF rejects unreasonable page counts before creating resources', () => {
  for (const count of [0, -1, 1.5, 501, Infinity])
    expect(() => pdfPreviewHtml(count)).toThrow('preview_pdf_page_budget');
});
