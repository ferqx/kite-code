import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';

test('PDF page loading and failure never label the previous image as the requested page', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key),
    });
  const { createRoot } = await import('react-dom/client');
  const { NativeFilePreview } = await import('../../src/native-file-preview');
  const root = createRoot(document.getElementById('root')!);
  const target = {
    storeId: 'store',
    sessionId: 'session',
    fileId: 'pdf',
    locator: { kind: 'delivery' as const, key: 'delivery/pdf' },
  };
  let fail: ((error: Error) => void) | undefined;
  let saves = 0,
    edits = 0;
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest) {
      if (request.method === 'outputs.info')
        return {
          kind: 'outputs.info',
          file: {
            ...target,
            name: 'two.pdf',
            mediaType: 'application/pdf',
            size: '10',
            publishedAt: '2026-11-11T00:00:00Z',
            ownerRunId: 'run',
          },
        };
      if (request.method === 'outputs.pdf.page') {
        if (request.page === 2)
          return await new Promise((_, reject) => {
            fail = reject;
          });
        return {
          kind: 'outputs.pdf.page',
          pdf: { page: 1, totalPages: 2, mediaType: 'image/png', data: 'first-page' },
        };
      }
      throw Error('unexpected_request');
    },
  } as NativeBridge;
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () =>
      root.render(
        <NativeFilePreview
          bridge={bridge}
          generation={1}
          target={target}
          onSave={() => saves++}
          onEdit={() => edits++}
        />,
      ),
    );
    expect(document.querySelector('img')?.alt).toBe('第 1 页');
    await act(async () => button('下一页').click());
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('正在准备预览');
    await act(async () => fail!(Error('render_failed')));
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('暂时无法预览');
    await act(() => {
      button('另存为').click();
      button('继续修改').click();
    });
    expect([saves, edits]).toEqual([1, 1]);
    await act(async () => button('上一页').click());
    expect(document.querySelector('img')?.alt).toBe('第 1 页');
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
