import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';

test.each([
  ['two.pdf', 'application/pdf'],
  ['plan.docx', 'application/octet-stream'],
  ['report.xlsx', 'application/octet-stream'],
  ['brief.pptx', 'application/octet-stream'],
  ['notes.md', 'text/markdown'],
  ['brief.txt', 'text/plain'],
  ['map.png', 'image/png'],
])('output %s keeps only its own actions during loading, failure and retry', async (name, mediaType) => {
  const isImage = mediaType.startsWith('image/');
  const paged = /\.(pdf|docx|xlsx|pptx)$/.test(name);
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
  const saves: string[] = [];
  const edits: unknown[][] = [];
  const requests: NativeRequest[] = [];
  let sends = 0;
  const info = {
    kind: 'outputs.info' as const,
    file: {
      ...target,
      name,
      mediaType,
      size: '10',
      publishedAt: '2026-11-11T00:00:00Z',
      ownerRunId: 'run',
    },
  };
  const bridge = {
    async request(request: NativeRequest): Promise<NativeResult> {
      requests.push(request);
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
      if (request.method === 'outputs.preview.control' && request.control.kind === 'image-zoom')
        return {
          kind: 'outputs.preview.imageZoom',
          zoom:
            request.control.value === '1'
              ? { fit: false, scale: 1, minimum: 0.01 }
              : { fit: true, scale: 0.75, minimum: 0.01 },
        };
      if (request.method === 'outputs.preview.interaction')
        return {
          kind: 'outputs.preview.interaction',
          interaction: {
            generation: 1,
            previewId: request.previewId,
            target,
            sourceHash: 'a'.repeat(64),
            selection: name.endsWith('.xlsx')
              ? {
                  kind: 'excel',
                  sheet: 'Sheet1',
                  range: 'A1',
                  cells: [{ path: '/Sheet1/A1', address: 'A1', value: '42', formula: '=6*7' }],
                }
              : name.endsWith('.pptx')
                ? { kind: 'powerpoint', slide: 1 }
                : name.endsWith('.pdf')
                  ? { kind: 'pdf', page: 1, pageBasis: 'pdf-rendered', scope: 'page', rects: [] }
                  : {
                      kind: 'word',
                      text: 'a',
                      start: { path: '/p', offset: 0 },
                      end: { path: '/p', offset: 1 },
                    },
            ...(name.endsWith('.xlsx')
              ? { excelSelection: { selectionSerial: 1, activeAddress: 'A1' } }
              : {}),
          },
        };
      return null;
    },
  } as NativeBridge;
  const loader = () => document.querySelectorAll('svg[role="status"][aria-label="文件预览加载中"]');
  const zoom = () => document.querySelector<HTMLSelectElement>('select[aria-label="预览缩放"]')!;
  const imageZoom = () =>
    document.querySelector<HTMLSelectElement>('select[aria-label="图片缩放"]')!;
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
      (item) => (item.getAttribute('aria-label') ?? item.textContent) === name,
    );
  try {
    await act(async () =>
      root.render(
        <NativeFilePreview
          bridge={bridge}
          generation={1}
          target={target}
          onSave={(file) => saves.push(file.name)}
          onEdit={(...args) => edits.push(args)}
          onRequestEdit={async () => {
            sends++;
            return { status: 'accepted' };
          }}
        />,
      ),
    );
    expect(loader()).toHaveLength(1);
    expect(document.body.textContent).not.toContain('正在准备预览');
    await act(async () => finishInfo!(info));
    expect(loader()).toHaveLength(1);
    expect(opens).toBe(1);
    expect(document.body.textContent).not.toContain(name);
    expect(document.querySelector('fieldset')?.getAttribute('aria-label')).toBe(
      `${name} 预览工具栏`,
    );
    if (paged) {
      expect(zoom().disabled).toBe(true);
      expect(button('请求修改')!.disabled).toBe(true);
      const count = requests.length;
      await act(() => button('请求修改')!.click());
      expect(requests).toHaveLength(count);
      expect(document.body.textContent).not.toContain('请先选择');
      expect(button('继续修改整个文件')).toBeUndefined();
    } else {
      expect(zoom()).toBeNull();
      if (isImage) expect(imageZoom().disabled).toBe(true);
      else expect(imageZoom()).toBeNull();
      expect(
        [...document.querySelectorAll('fieldset button')].map((item) =>
          item.getAttribute('aria-label'),
        ),
      ).toEqual(['继续修改', '另存为']);
    }
    await act(async () => failPreview!(Error('render_failed')));
    expect(loader()).toHaveLength(0);
    expect(document.querySelector('.native-file-preview-error p')?.textContent).toBe('预览失败');
    await act(() => button('另存为')!.click());
    expect(saves).toEqual([name]);
    if (!paged) {
      await act(() => button('继续修改')!.click());
      expect(edits).toEqual([[info.file]]);
    } else {
      expect(button('请求修改')).toBeUndefined();
      expect(document.querySelectorAll('.native-file-preview-error button')).toHaveLength(2);
      const count = requests.length;
      await act(() => button('继续修改整个文件')!.click());
      expect(edits).toEqual([[info.file]]);
      expect(requests).toHaveLength(count);
    }
    await act(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === '重试')!
        .click(),
    );
    expect(loader()).toHaveLength(1);
    expect(opens).toBe(1);
    expect(button('继续修改整个文件')).toBeUndefined();
    if (paged) {
      await act(async () => finishInfo!(null));
      expect(document.body.textContent).toContain('无法读取文件信息');
      expect(button('继续修改整个文件')).toBeUndefined();
      expect(opens).toBe(1);
      await act(() => button('重试')!.click());
      await act(async () => finishInfo!(info));
      await act(async () => failPreview!(Error('output_source_unavailable')));
      expect(button('继续修改整个文件')).toBeUndefined();
      expect(document.body.textContent).toContain('无法读取文件信息');
      await act(() => button('重试')!.click());
    }
    await act(async () => finishInfo!(info));
    await act(async () => finishPreview!({ kind: 'outputs.preview', status: 'ready' }));
    expect(loader()).toHaveLength(0);
    expect(opens).toBe(paged ? 3 : 2);
    expect(document.querySelector('.native-file-preview-error')).toBeNull();
    if (paged) {
      expect(zoom().disabled).toBe(false);
      expect(button('请求修改')!.disabled).toBe(false);
      expect(button('继续修改整个文件')).toBeUndefined();
      expect(document.body.textContent).not.toContain('请先选择');
      await act(() => button('请求修改')!.click());
      expect(
        requests.filter(
          (r) => r.method === 'outputs.preview.control' && r.control.kind === 'request-edit',
        ),
      ).toHaveLength(1);
      if (name.endsWith('.xlsx')) {
        const field = document.querySelector<HTMLTextAreaElement>(
          '[aria-label="单元格公式（只读）"]',
        )!;
        expect(field.readOnly).toBe(true);
        expect(field.value).toBe('=6*7');
      }
    } else {
      expect(button('继续修改')).toBeDefined();
      if (isImage) {
        const select = imageZoom();
        expect(select.disabled).toBe(false);
        const toolbar = select.closest('.native-preview-toolbar');
        expect(toolbar?.contains(button('另存为')!)).toBe(true);
        expect(select.value).toBe('fit');
        await act(async () => {
          select.value = '1';
          select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        });
        expect(select.value).toBe('1');
        expect(select.title).toContain('100%');
        expect(
          requests.flatMap((r) =>
            r.method === 'outputs.preview.control' && r.control.kind === 'image-zoom'
              ? [r.control]
              : [],
          ),
        ).toEqual([
          { kind: 'image-zoom', value: 'state' },
          { kind: 'image-zoom', value: '1' },
        ]);
      }
    }
    expect(edits).toEqual([[info.file]]);
    expect(sends).toBe(0);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
