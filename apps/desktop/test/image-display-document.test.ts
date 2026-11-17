import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  imageDisplayDocument,
  imageDisplayMediaType,
  imageDisplayReadingEdge,
} from '../electron/image-display-document';

test('image document references only derivative resource and labels animation first frame', () => {
  const html = imageDisplayDocument({
    width: 2048,
    height: 1024,
    sourceWidth: 12000,
    sourceHeight: 6000,
    animated: true,
  });
  expect(html).toContain('src="image"');
  expect(html).toContain('width="2048"');
  expect(html).toContain('data-source-width="12000"');
  expect(html).toContain('动画图片 · 首帧预览');
  expect(html).not.toContain('file:');
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

test('fit width permits sub-one-percent panoramas and minus never zooms inward', () => {
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
    expect(stage.style.width).toBe('320px');
    expect(document.getElementById('image-zoom-label')!.textContent).toBe('0.8%');
    document.getElementById('image-out')!.click();
    expect(stage.style.width).toBe('320px');
    document.getElementById('image-original')!.click();
    expect(stage.style.width).toBe('40000px');
    expect(document.getElementById('image-zoom-label')!.textContent).toBe('100%');
    document.getElementById('image-fit')!.click();
    expect(stage.style.width).toBe('320px');
    Object.defineProperty(dom.window, 'innerWidth', { value: 240 });
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(stage.style.width).toBe('240px');
    expect(document.getElementById('image-zoom-label')!.textContent).toBe('0.6%');
  } finally {
    dom.window.close();
  }
});
