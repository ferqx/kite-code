import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';

test('local preview owns no write action; hide closes view, late reads cannot replace current state', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'MutationObserver',
    'ResizeObserver',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        key === 'IS_REACT_ACT_ENVIRONMENT'
          ? true
          : key === 'ResizeObserver'
            ? class {
                observe() {}
                disconnect() {}
              }
            : Reflect.get(dom.window, key),
    });
  const { createRoot } = await import('react-dom/client');
  const { NativeLocalFilePreview } = await import('../../src/native-local-file-preview');
  const root = createRoot(document.getElementById('root')!);
  const requests: NativeRequest[] = [];
  let failure: string | undefined;
  let hold = false;
  let checkFailed = false;
  let resolve: ((value: NativeResult) => void) | undefined;
  const bridge = {
    request: async (request: NativeRequest): Promise<NativeResult> => {
      requests.push(request);
      if (request.method === 'localPreview.check' && checkFailed)
        throw Error('local_preview_changed');
      if (request.method === 'localPreview.open') {
        if (hold)
          return new Promise((done) => {
            resolve = done;
          });
        if (failure) throw Object.assign(Error(failure), { code: failure });
        return { kind: 'outputs.preview', status: 'ready' };
      }
      return null;
    },
  } as NativeBridge;
  const target = {
    kind: 'local-preview' as const,
    storeId: 'store',
    sessionId: 'session',
    handleId: 'handle',
    name: 'document.pdf',
    mediaType: 'application/pdf',
  };
  const show = async () =>
    act(async () =>
      root.render(<NativeLocalFilePreview bridge={bridge} generation={1} target={target} />),
    );
  try {
    await show();
    expect(document.querySelector('[aria-label="预览缩放"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('请求修改');
    expect(document.querySelector('[aria-label="另存为"]')).toBeNull();
    expect(requests.filter((r) => r.method === 'localPreview.open')).toHaveLength(1);
    await act(async () => root.render(null));
    expect(requests.filter((r) => r.method === 'outputs.preview.close')).toHaveLength(1);
    expect(requests.some((r) => r.method === 'localPreview.release')).toBe(false);
    checkFailed = true;
    await show();
    const opens = requests.filter((r) => r.method === 'localPreview.open').length;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 1100));
    });
    expect(document.body.textContent).toContain('请关闭后重新打开');
    expect(requests.filter((r) => r.method === 'localPreview.open')).toHaveLength(opens);
    await act(async () => root.render(null));
    checkFailed = false;
    failure = 'preview_format_unavailable';
    await show();
    expect(document.body.textContent).toContain('二进制文件无法打开');
    await act(async () => root.render(null));
    failure = 'preview_text_encoding_unavailable';
    await show();
    expect(document.body.textContent).toContain('暂不支持此文本编码');
    expect(document.body.textContent).not.toContain('二进制');
    await act(async () => root.render(null));
    failure = 'file_read_failed';
    await show();
    expect(document.body.textContent).toContain('文件读取或预览失败');
    await act(async () => root.render(null));
    failure = undefined;
    hold = true;
    await show();
    await act(async () => root.render(null));
    await act(async () => resolve?.({ kind: 'outputs.preview', status: 'ready' }));
    expect(document.body.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
