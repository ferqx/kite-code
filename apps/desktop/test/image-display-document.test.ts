import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  imageDisplayDocument,
  imageDisplayMediaType,
  imageDisplayReadingEdge,
} from '../electron/image-display-document';
import { imageDisplayViewportScript } from '../electron/image-display-viewport';
import { validateImageZoom } from '../src/image-zoom';

test('image document references only derivative resource and labels animation first frame', () => {
  const image = {
    width: 2048,
    height: 1024,
    sourceWidth: 12000,
    sourceHeight: 6000,
    animated: true,
    bytes: new Uint8Array([12, 13, 14]),
  };
  const html = imageDisplayDocument(image);
  expect(html).toContain('src="image"');
  expect(html).toContain('width="2048"');
  expect(html).toContain('data-source-width="12000"');
  expect(html).toContain('动画图片 · 首帧预览');
  expect(html).not.toContain('file:');
  expect(html).not.toContain('"bytes":');
  expect(
    imageDisplayDocument({ width: 2, height: 1, sourceWidth: 2, sourceHeight: 1, animated: false }),
  ).not.toContain('首帧');
});

test('file preview chooses bounded reading tiers and four-format MIME only', () => {
  expect(imageDisplayReadingEdge({ width: 600, height: 800 }, 1)).toBe(1024);
  expect(imageDisplayReadingEdge({ width: 600, height: 800 }, 2)).toBe(2048);
  expect(imageDisplayReadingEdge({ width: 2000, height: 800 }, 3)).toBe(4096);
  for (const [name, mime] of [
    ['x.JPG', 'image/jpeg'],
    ['x.png', 'image/png'],
    ['x.webp', 'image/webp'],
    ['x.gif', 'image/gif'],
  ] as const)
    expect(imageDisplayMediaType(name, 'application/octet-stream')).toBe(mime);
  expect(imageDisplayMediaType('x.png', 'image/jpeg')).toBe('image/jpeg');
  expect(() => imageDisplayMediaType('x.svg', 'image/svg+xml')).toThrow(
    'preview_format_unavailable',
  );
});

test('compact image zoom preserves fit, original, presets and bounded relative zoom for panoramas', () => {
  const dom = new JSDOM(
    imageDisplayDocument({
      width: 4096,
      height: 205,
      sourceWidth: 40000,
      sourceHeight: 2000,
      animated: false,
    }),
    {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        Object.defineProperty(window, 'innerWidth', {
          configurable: true,
          writable: true,
          value: 320,
        });
        window.scrollTo = () => {};
      },
    },
  );
  try {
    const document = dom.window.document;
    const stage = document.getElementById('image-stage')!;
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="图片缩放"]')!;
    const label = document.getElementById('image-zoom-label')!;
    const choose = (value: string) => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event('change'));
    };
    const smaller = select.querySelector<HTMLOptionElement>('[value="out"]')!;
    const larger = select.querySelector<HTMLOptionElement>('[value="in"]')!;
    const original = select.querySelector<HTMLOptionElement>('[value="1"]')!;
    select.focus();
    expect(stage.style.width).toBe('320px');
    expect(label.textContent).toBe('适应');
    expect(select.title).toBe('适合宽度（0.8%）');
    expect(smaller.disabled).toBe(true);
    expect(original.textContent).toBe('100% 原始大小');
    choose(original.value);
    expect(stage.style.width).toBe('40000px');
    expect(label.textContent).toBe('100%');
    choose('out');
    expect(label.textContent).toBe('80%');
    expect(select.selectedOptions[0]?.textContent).toBe('80%');
    choose('out');
    expect(label.textContent).toBe('64%');
    choose('1.5');
    expect(label.textContent).toBe('150%');
    for (let i = 0; i < 30 && !larger.disabled; i++) choose('in');
    expect(larger.disabled).toBe(true);
    expect(stage.style.width).toBe('320000px');
    expect(label.textContent).toBe('800%');
    choose('fit');
    expect(stage.style.width).toBe('320px');
    Object.defineProperty(dom.window, 'innerWidth', { value: 240 });
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(stage.style.width).toBe('240px');
    expect(select.title).toBe('适合宽度（0.6%）');
    expect(document.activeElement).toBe(select);
    choose('in');
    choose('out');
    expect(smaller.disabled).toBe(true);
    Object.defineProperty(dom.window, 'innerWidth', { value: 200 });
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(stage.style.width).toBe('240px');
    expect(smaller.disabled).toBe(false);
  } finally {
    dom.window.close();
  }
});

test('delivered image has no second zoom control; the closed commands keep pixel zoom and clamp at bounds', () => {
  const item = { width: 2048, height: 1024, sourceWidth: 4000, sourceHeight: 2000, animated: true };
  const dom = new JSDOM(imageDisplayDocument(item, true), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  try {
    dom.window.scrollTo = () => {};
    const { document } = dom.window;
    expect(document.querySelector('select,script')).toBeNull();
    expect(document.querySelector('[role=note]')?.textContent).toContain('首帧');
    expect(document.querySelector('#image-region-retry')).not.toBeNull();
    dom.window.eval(imageDisplayViewportScript(item, true));
    const zoom = dom.window.kiteImageZoom;
    expect(zoom('state').fit).toBe(true);
    expect(zoom('1').scale).toBe(1);
    expect(document.querySelector<HTMLElement>('#image-stage')?.style.width).toBe('4000px');
    for (let i = 0; i < 40; i++) zoom('out');
    expect(zoom('state').scale).toBe(0.01);
    for (let i = 0; i < 45; i++) zoom('in');
    expect(zoom('state').scale).toBe(8);
    expect(zoom('fit').fit).toBe(true);
    expect(document.documentElement.style.zoom).toBe('');
    for (const value of ['1', 'fit', 'out', 'in', 'state'])
      expect(() => validateImageZoom({ kind: 'image-zoom', value } as never)).not.toThrow();
    for (const value of [0, '800', 'other', {}])
      expect(() => validateImageZoom({ kind: 'image-zoom', value } as never)).toThrow();
  } finally {
    dom.window.close();
  }
});

test('hosted viewport retries the failed ROI itself, retires late results and never exposes file controls', async () => {
  const item = { width: 500, height: 250, sourceWidth: 4000, sourceHeight: 2000, animated: false };
  const dom = new JSDOM(imageDisplayDocument(item, true), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  try {
    const w = dom.window,
      d = w.document,
      requested: HTMLImageElement[] = [];
    w.scrollTo = () => {};
    w.Image = new Proxy(w.Image, {
      construct() {
        const img = d.createElement('img');
        img.decode = async () => {};
        requested.push(img);
        return img;
      },
    });
    w.eval(imageDisplayViewportScript(item, true));
    w.kiteImageZoom('1');
    await Bun.sleep(160);
    const first = requested.at(-1)!;
    expect(first.getAttribute('src')).toMatch(/^region\/\d+\/0\/0\/1024\/768\.webp$/);
    first.dispatchEvent(new w.Event('error'));
    expect(d.querySelector<HTMLElement>('#image-region-status')?.hidden).toBe(false);
    d.querySelector<HTMLButtonElement>('#image-region-retry')?.click();
    const next = requested.at(-1)!;
    expect(next).not.toBe(first);
    next.dispatchEvent(new w.Event('load'));
    await Bun.sleep(10);
    expect(d.querySelector('[data-image-region="current"]')).toBe(next);
    expect(d.querySelector<HTMLElement>('#image-region-status')?.hidden).toBe(true);
    expect(d.querySelectorAll('button')).toHaveLength(1);
    const stale = next.onload;
    w.dispatchEvent(new w.Event('pagehide'));
    stale?.call(next, new w.Event('load'));
    await Bun.sleep(10);
    expect(d.querySelector('.image-region')).toBeNull();
  } finally {
    dom.window.close();
  }
});
