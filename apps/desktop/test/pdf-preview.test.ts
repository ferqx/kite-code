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
  expect(w.eval('kiteOfficeInteraction.read().selection')).toBeNull();
  dom.window.close();
});
test('PDF rejects unreasonable page counts before creating resources', () => {
  for (const count of [0, -1, 1.5, 501, Infinity])
    expect(() => pdfPreviewHtml(count)).toThrow('preview_pdf_page_budget');
});

test('PDF page request freezes navigation and releases only its matching serial', () => {
  const dom = new JSDOM(pdfPreviewHtml(2), { runScripts: 'outside-only' });
  const w = dom.window;
  Object.assign(w, { structuredClone });
  w.eval(pdfPreviewInstallScript());
  const img = w.document.querySelector('main img')!;
  img.dispatchEvent(new w.Event('load'));
  w.eval('kitePdfPreview.control({kind:"request-edit"})');
  const first = w.eval(
    'kiteOfficeInteraction.read()',
  ) as import('../electron/office-preview-interaction').OfficeInteraction;
  expect(first.floatingSelection).toEqual({
    kind: 'pdf',
    page: 1,
    pageBasis: 'pdf-rendered',
    scope: 'page',
    rects: [],
  });
  (w.document.querySelector('[data-page="2"]') as HTMLButtonElement).click();
  expect(img.getAttribute('src')).toBe('page-1.png');
  w.eval(`kiteOfficeInteraction.releaseScope(${first.floatingRequest! + 1})`);
  expect(w.eval('kiteOfficeInteraction.read().floatingRequest')).toBe(first.floatingRequest);
  w.eval(`kiteOfficeInteraction.releaseScope(${first.floatingRequest})`);
  (w.document.querySelector('[data-page="2"]') as HTMLButtonElement).click();
  expect(img.getAttribute('src')).toBe('page-2.png');
  expect(w.eval('kiteOfficeInteraction.read().selection')).toBeNull();
  dom.window.close();
});

test('PDF fallback status survives either image/text ordering and never masks image failure', () => {
  for (const status of ['empty', 'unavailable'])
    for (const layerFirst of [true, false]) {
      const dom = new JSDOM(pdfPreviewHtml(1), { runScripts: 'outside-only' });
      const w = dom.window;
      w.eval(pdfPreviewInstallScript());
      const img = w.document.querySelector('main img')!;
      const set = () =>
        w.eval(
          `kitePdfPreview.setLayer(1,${JSON.stringify({ status, width: 100, height: 100, items: [] })})`,
        );
      if (layerFirst) set();
      img.dispatchEvent(new w.Event('load'));
      if (!layerFirst) set();
      const message = w.document.querySelector('[role=status]')!.textContent;
      if (status === 'empty') {
        expect(message).toBe('');
        expect((w.document.querySelector('[role=status]') as HTMLElement).hidden).toBe(true);
      } else expect(message).toContain('文字层不可用');
      set();
      expect(w.document.querySelector('[role=status]')!.textContent).toBe(message);
      Object.assign(w, { structuredClone });
      w.eval('kitePdfPreview.control({kind:"request-edit"})');
      expect(
        (w.eval('kiteOfficeInteraction.read()') as { floatingSelection: { scope: string } })
          .floatingSelection.scope,
      ).toBe('page');
      img.dispatchEvent(new w.Event('error'));
      set();
      expect(w.document.querySelector('[role=status]')!.textContent).toContain('读取失败');
      dom.window.close();
    }
});
