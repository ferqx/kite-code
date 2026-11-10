import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TrajectoryAttachments,
  TrajectoryMessageImages,
} from '../src/desktop/trajectory/TrajectoryAttachments';

function documentOf(markup: string) {
  return new JSDOM(markup);
}

test('public attachment descriptions preserve original order, duplicate names, exact large sizes and zero without recovering images', () => {
  const data = {
    attachments: [
      { name: 'same.png', mediaType: 'image/png', size: '0', uri: 'file:///PRIVATE_PATH' },
      { name: 'same.png', mediaType: 'image/png', size: '9007199254740993' },
      { name: '', size: 0 },
    ],
  };
  const original = structuredClone(data);
  const markup = renderToStaticMarkup(<TrajectoryAttachments data={data} />);
  const dom = documentOf(markup),
    body = dom.window.document.body;
  expect(
    [...body.querySelectorAll('.trajectory-attachment-name')].map((item) => item.textContent),
  ).toEqual(['same.png', 'same.png', '未命名附件']);
  expect(body.querySelector('.trajectory-attachment-name')?.getAttribute('title')).toBe('same.png');
  expect(body.textContent).toContain('image/png · 0 字节');
  expect(body.textContent).toContain('9007199254740993 字节');
  expect(body.querySelectorAll('img')).toHaveLength(0);
  expect(markup).not.toContain('PRIVATE_PATH');
  expect(data).toEqual(original);
  dom.window.close();
});

test('canonical descriptions are authoritative and legacy image/file descriptions remain inert and ordered', () => {
  const canonical = renderToStaticMarkup(
    <TrajectoryAttachments
      data={{ attachments: [{ name: 'canonical' }], images: [{ name: 'duplicate' }] }}
    />,
  );
  expect(canonical).toContain('canonical');
  expect(canonical).not.toContain('duplicate');
  const dom = documentOf(
    renderToStaticMarkup(
      <TrajectoryAttachments
        data={{
          images: [{ name: 'picture', mediaType: 'image/gif' }],
          files: [{ name: 'file', size: '3' }],
        }}
      />,
    ),
  );
  expect(
    [...dom.window.document.querySelectorAll('.trajectory-attachment-name')].map(
      (item) => item.textContent,
    ),
  ).toEqual(['picture', 'file']);
  expect(dom.window.document.querySelectorAll('img')).toHaveLength(0);
  dom.window.close();
});

test('absent and empty descriptions stay absent while malformed metadata is explained without guessing or private field reads', () => {
  for (const data of [undefined, {}, { attachments: [] }])
    expect(renderToStaticMarkup(<TrajectoryAttachments data={data} />)).toBe('');
  const body = {
    attachments: [{ name: 'original', size: null }, null, { name: 'bad-size', size: '01' }],
  };
  const item = body.attachments[0]!;
  Object.defineProperty(item, 'uri', {
    enumerable: true,
    get() {
      throw Error('private URI must not be inspected');
    },
  });
  const markup = renderToStaticMarkup(<TrajectoryAttachments data={body} />);
  expect(markup).toContain('大小格式无法识别');
  expect(markup).toContain('附件 2 的已保存描述无法识别');
  expect(renderToStaticMarkup(<TrajectoryAttachments data={{ attachments: null }} />)).toContain(
    '描述格式无法识别',
  );
});

test('all four exact request image formats render only their sealed inline bytes in the original order', () => {
  const images = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].map((mediaType) => ({
    mediaType,
    data: 'AA==',
  }));
  const original = structuredClone(images);
  const dom = documentOf(renderToStaticMarkup(<TrajectoryMessageImages images={images} />));
  const elements = [...dom.window.document.querySelectorAll('img')];
  expect(elements.map((element) => element.getAttribute('src'))).toEqual(
    images.map((item) => `data:${item.mediaType};base64,AA==`),
  );
  expect(elements.map((element) => element.getAttribute('alt'))).toEqual(
    [1, 2, 3, 4].map((index) => `已保存的请求图片 ${index}`),
  );
  expect(
    elements.every(
      (element) =>
        element.getAttribute('loading') === 'lazy' && element.getAttribute('decoding') === 'async',
    ),
  ).toBe(true);
  expect(images).toEqual(original);
  dom.window.close();
});

test('malformed, unsupported and noncanonical images are never interpreted as a URL or replaced by attachment descriptions', () => {
  const images: unknown[] = [
    { mediaType: 'image/svg+xml', data: 'AA==' },
    { mediaType: 'image/png', data: '' },
    { mediaType: 'image/png', data: 'AA' },
    { mediaType: 'image/png', data: 'A A=' },
    { mediaType: 'image/png', data: 'AB==' },
    { mediaType: 'image/png', data: 'AAB=' },
    { mediaType: 'image/png', data: 'data:image/png;base64,AA==' },
    { mediaType: 'image/png', data: 'AA==', url: 'https://PRIVATE_HOST/image' },
    { name: 'only-a-description.png', mediaType: 'image/png', size: '1' },
    null,
  ];
  Object.defineProperty(images[7], 'url', {
    enumerable: true,
    get() {
      throw Error('arbitrary URL must not be read');
    },
  });
  const dom = documentOf(renderToStaticMarkup(<TrajectoryMessageImages images={images} />));
  expect(dom.window.document.querySelectorAll('img')).toHaveLength(0);
  expect(dom.window.document.querySelectorAll('[role="status"]')).toHaveLength(images.length);
  expect(dom.window.document.body.textContent).toContain('图片 10 未展示');
  expect(dom.window.document.body.textContent).not.toContain('PRIVATE_HOST');
  expect(
    renderToStaticMarkup(
      <TrajectoryMessageImages images={{ url: 'https://PRIVATE_HOST/image' }} />,
    ),
  ).toContain('列表格式无法识别');
  for (const value of [undefined, []])
    expect(renderToStaticMarkup(<TrajectoryMessageImages images={value} />)).toBe('');
  dom.window.close();
});

test('mixed request images preserve valid images and the exact position of an unrenderable item', () => {
  const dom = documentOf(
    renderToStaticMarkup(
      <TrajectoryMessageImages
        images={[
          { mediaType: 'image/png', data: 'AAA=' },
          { url: 'https://not-loaded.test/' },
          { mediaType: 'image/gif', data: 'AAAA' },
        ]}
      />,
    ),
  );
  expect(dom.window.document.querySelectorAll('img')).toHaveLength(2);
  expect(dom.window.document.body.textContent).toContain('图片 2 未展示');
  expect(dom.window.document.body.textContent).toContain('图片 3 · image/gif');
  dom.window.close();
});

test('browser decoding failure is explicit and replacing the exact saved image does not retain an old failure', async () => {
  const dom = new JSDOM('<main id="root"></main>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  try {
    await act(() =>
      root.render(<TrajectoryMessageImages images={[{ mediaType: 'image/png', data: 'AA==' }]} />),
    );
    await act(() => host.querySelector('img')!.dispatchEvent(new dom.window.Event('error')));
    expect(host.querySelector('img') === null).toBe(true);
    expect(host.textContent).toContain('已保存字节无法解码');
    await act(() =>
      root.render(<TrajectoryMessageImages images={[{ mediaType: 'image/png', data: 'AAA=' }]} />),
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA=');
    expect(host.textContent).not.toContain('已保存字节无法解码');
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
