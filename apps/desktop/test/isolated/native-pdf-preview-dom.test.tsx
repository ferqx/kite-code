import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';

test('the output preview shows one loading icon, then an error or the ready toolbar', async () => {
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
  let finishInfo: ((result: NativeResult) => void) | undefined;
  let finishPreview: ((result: NativeResult) => void) | undefined;
  let failPreview: ((error: Error) => void) | undefined;
  let opens = 0;
  let saves = 0;
  const info = {
    kind: 'outputs.info' as const,
    file: {
      ...target,
      name: 'two.pdf',
      mediaType: 'application/pdf',
      size: '10',
      publishedAt: '2026-11-11T00:00:00Z',
      ownerRunId: 'run',
    },
  };
  const bridge = {
    async request(request: NativeRequest): Promise<NativeResult> {
      if (request.method === 'outputs.info')
        return new Promise((resolve) => {
          finishInfo = resolve;
        });
      if (request.method === 'outputs.preview.open') {
        opens++;
        return new Promise((resolve, reject) => {
          finishPreview = resolve;
          failPreview = reject;
        });
      }
      return null;
    },
  } as NativeBridge;
  const loader = () => document.querySelectorAll('svg[role="status"][aria-label="文件预览加载中"]');
  const zoom = () => document.querySelector<HTMLSelectElement>('select[aria-label="预览缩放"]')!;
  const save = () => document.querySelector<HTMLButtonElement>('button[aria-label="另存为"]')!;
  try {
    await act(async () =>
      root.render(
        <NativeFilePreview
          bridge={bridge}
          generation={1}
          target={target}
          onSave={() => saves++}
          onEdit={() => {}}
        />,
      ),
    );
    expect(loader()).toHaveLength(1);
    expect(document.body.textContent).not.toContain('正在准备预览');
    await act(async () => finishInfo!(info));
    expect(loader()).toHaveLength(1);
    expect(opens).toBe(1);
    expect(zoom().disabled).toBe(true);
    await act(async () => failPreview!(Error('render_failed')));
    expect(loader()).toHaveLength(0);
    expect(document.querySelector('.native-file-preview-error p')?.textContent).toBe('预览失败');
    await act(() => save().click());
    expect(saves).toBe(1);
    await act(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === '重试')!
        .click(),
    );
    expect(loader()).toHaveLength(1);
    expect(opens).toBe(1);
    await act(async () => finishInfo!(info));
    await act(async () => finishPreview!({ kind: 'outputs.preview', status: 'ready' }));
    expect(loader()).toHaveLength(0);
    expect(opens).toBe(2);
    expect(document.querySelector('.native-file-preview-error')).toBeNull();
    expect(zoom().disabled).toBe(false);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
