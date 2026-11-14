import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import type {
  OfficeEditContext,
  OfficePreviewControl,
  OfficePreviewInteraction,
  OfficeSelection,
} from '../../src/output-files-bridge';

test('Office surfaces use application tokens without dark-only fallback colors', async () => {
  const css = await Bun.file(
    new URL('../../src/native-office-toolbar.css', import.meta.url),
  ).text();
  const theme = await Bun.file(
    new URL('../../../../packages/ui/src/desktop/style.css', import.meta.url),
  ).text();
  const names = [...css.matchAll(/var\((--[a-z-]+)\)/g)].map((match) => match[1]!);
  expect(names.length).toBeGreaterThan(5);
  for (const name of new Set(names)) expect(theme).toMatch(new RegExp(`${name}:`));
  expect(css).not.toMatch(/var\(--muted[,)]/);
  expect(css).not.toMatch(/var\([^)]*,\s*#/);
});

test('Read-only Office keeps source selections, viewport movement and late-result guards without local edit IPC', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'MutationObserver',
    'getComputedStyle',
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
  const { NativeFilePreview } = await import('../../src/native-file-preview');
  const root = createRoot(document.getElementById('root')!);
  const target = {
    storeId: 'store',
    sessionId: 'session',
    fileId: 'deck.pptx',
    locator: { kind: 'delivery' as const, key: 'delivery/ppt' },
  };
  const requests: NativeRequest[] = [];
  const edits: Array<OfficeEditContext | undefined> = [];
  const saves: string[] = [];
  let inlineRequest: OfficePreviewInteraction['inlineRequest'];
  const prompts: string[] = [];
  let holdSend = false;
  let failReceipt = true;
  let resolveSend: ((outcome: { status: 'accepted' }) => void) | undefined;
  let currentFile = target.fileId;
  let viewportX = 10,
    actualSlide = 2,
    nextId = '';
  let hold = false,
    fail = false;
  let resolveRead: ((result: NativeResult) => void) | undefined;
  let resolveHeldPoll: (() => void) | undefined;
  let selection: OfficeSelection = {
    kind: 'powerpoint',
    slide: 2,
    objectPath: '/slide[2]/shape[1]',
    text: 'Selected title',
  };
  let notes = 'Read-only notes';
  const interaction = (): OfficePreviewInteraction => ({
    previewId: nextId,
    generation: 1,
    target: { ...target, fileId: currentFile },
    sourceHash: 'a'.repeat(64),
    currentSlide: actualSlide,
    slideCount: 3,
    notes,
    selection,
    ...(inlineRequest ? { inlineRequest } : {}),
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: viewportX,
    y: 40,
    width: 800,
    height: 600,
    top: 40,
    left: viewportX,
    right: viewportX + 800,
    bottom: 640,
    toJSON() {
      return {};
    },
  });
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest) {
      requests.push(request);
      if (request.method.startsWith('outputs.office.')) throw Error('removed_local_edit_IPC');
      if (request.method === 'outputs.info') {
        currentFile = request.target.fileId;
        return {
          kind: 'outputs.info',
          file: {
            ...target,
            fileId: request.target.fileId,
            name: request.target.fileId,
            mediaType: 'application/octet-stream',
            size: '10',
            publishedAt: '2026-11-11T00:00:00Z',
            ownerRunId: 'run',
          },
        };
      }
      if (request.method === 'outputs.preview.open') {
        nextId = request.previewId;
        viewportX = 120;
        return { kind: 'outputs.preview', status: 'ready' };
      }
      if (request.method === 'outputs.preview.request.result') {
        if (failReceipt) {
          failReceipt = false;
          throw Error('receipt_unavailable');
        }
        inlineRequest = undefined;
        return null;
      }
      if (request.method === 'outputs.preview.interaction') {
        if (hold && request.consumeRequest !== false) resolveHeldPoll?.();
        if (request.consumeRequest === false && fail) throw Error('selection_unavailable');
        if (request.consumeRequest === false && hold)
          return new Promise((resolve) => {
            resolveRead = resolve;
          });
        return { kind: 'outputs.preview.interaction', interaction: interaction() };
      }
      return null;
    },
  } as NativeBridge;
  const render = async (fileId = 'deck.pptx') =>
    act(async () =>
      root.render(
        <NativeFilePreview
          bridge={bridge}
          generation={1}
          target={{ ...target, fileId }}
          onSave={(file) => saves.push(file.fileId)}
          onEdit={(_, context) => edits.push(context)}
          onRequestEdit={async (_, context, prompt) => {
            edits.push(context);
            prompts.push(prompt);
            if (holdSend)
              return new Promise((resolve) => {
                resolveSend = resolve;
              });
            return { status: 'accepted' };
          }}
        />,
      ),
    );
  const button = (text: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const click = async (text: string) => act(async () => button(text).click());
  const expectControl = async (
    control: OfficePreviewControl,
    action: () => PromiseLike<unknown>,
  ) => {
    const before = requests.length;
    await action();
    expect(requests.slice(before).filter((r) => r.method === 'outputs.preview.control')).toEqual([
      expect.objectContaining({ method: 'outputs.preview.control', control }),
    ]);
  };
  try {
    await render();
    expect(document.body.textContent).not.toContain('来源：Run run');
    expect(document.querySelector('.native-office-toolbar')?.getAttribute('title')).toBe(
      '来源：Run run。只读预览，排版可能与 Office 不同；复杂 3D 与动画不受支持。',
    );
    for (const removed of ['＋ 新增页', 'T 文本', '▧ 图片', '插入 ▾', '应用'])
      expect(button(removed)).toBeUndefined();
    expect(document.querySelector('form,textarea,input')).toBeNull();
    expect(document.querySelector('.native-office-notes')?.textContent).toContain(
      'Read-only notes',
    );
    notes = '   ';
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(document.querySelector('.native-office-notes')).toBeNull();
    notes = 'Read-only notes';
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(document.querySelector('.native-office-notes')?.textContent).toContain(notes);
    expect(requests.find((r) => r.method === 'outputs.preview.open')).toMatchObject({
      bounds: { x: 10 },
    });
    expect(requests.filter((r) => r.method === 'outputs.preview.bounds').at(-1)).toMatchObject({
      bounds: { x: 120 },
    });
    const count = requests.filter((r) => r.method === 'outputs.preview.bounds').length;
    viewportX = 160;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(requests.filter((r) => r.method === 'outputs.preview.bounds').at(-1)).toMatchObject({
      bounds: { x: 160 },
    });
    expect(requests.filter((r) => r.method === 'outputs.preview.bounds')).toHaveLength(count + 1);
    await expectControl({ kind: 'request-edit' }, () => click('请求修改'));
    expect(edits).toHaveLength(0);
    inlineRequest = {
      requestId: 'request-one',
      prompt: '精简选中标题',
      context: { sourceHash: 'a'.repeat(64), selection },
    };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(prompts).toEqual(['精简选中标题']);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(requests.filter((r) => r.method === 'outputs.preview.request.result')).toHaveLength(2);
    expect(prompts).toHaveLength(1);
    expect(document.body.textContent).not.toContain('预览回执暂时不可用');
    expect(edits[0]).toEqual({ sourceHash: 'a'.repeat(64), selection });
    expect(edits[0]).not.toHaveProperty('editor');
    await act(async () =>
      (document.querySelector('[aria-label="另存为"]') as HTMLButtonElement).click(),
    );
    expect(saves).toEqual(['deck.pptx']);
    expect(document.querySelector('.native-office-footer')).toBeNull();
    expect(document.body.textContent).not.toContain('下一页');
    expect(document.body.textContent).not.toContain('此页暂无备注');
    expect(document.body.textContent).not.toContain('预览说明');
    await expectControl({ kind: 'presentation', value: true }, () =>
      act(async () => (document.querySelector('[aria-label="放映"]') as HTMLButtonElement).click()),
    );
    await expectControl({ kind: 'zoom', value: 1.25 }, () =>
      act(async () => {
        const zoom = document.querySelector<HTMLSelectElement>('select[aria-label="预览缩放"]')!;
        zoom.value = '1.25';
        zoom.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }),
    );
    hold = true;
    const toolbarReads = () =>
      requests.filter(
        (r) => r.method === 'outputs.preview.interaction' && r.consumeRequest === false,
      );
    const editControls = () =>
      requests.filter(
        (r) => r.method === 'outputs.preview.control' && r.control.kind === 'request-edit',
      );
    const reads = toolbarReads().length;
    const controlsBeforeHeldRead = editControls().length;
    const pollWhileHeld = new Promise<void>((resolve) => {
      resolveHeldPoll = resolve;
    });
    await click('请求修改');
    const heldRead = resolveRead;
    expect(heldRead).toBeFunction();
    // Deliberately cross a background poll while the toolbar promise is held.
    // Polls must stay live; only the explicit non-consuming toolbar read is deduped.
    await act(async () => pollWhileHeld);
    resolveHeldPoll = undefined;
    await click('请求修改');
    expect(toolbarReads()).toHaveLength(reads + 1);
    expect(resolveRead).toBe(heldRead);
    expect(editControls()).toHaveLength(controlsBeforeHeldRead);
    const held = interaction();
    await render('other.pptx');
    const body = document.body.textContent;
    await act(async () => heldRead!({ kind: 'outputs.preview.interaction', interaction: held }));
    expect(editControls()).toHaveLength(controlsBeforeHeldRead);
    expect(edits).toHaveLength(1);
    expect(document.body.textContent).toBe(body);
    hold = false;
    expect(requests.some((r) => r.method === 'outputs.preview.close')).toBe(true);
    for (const [name, value] of [
      [
        'report.docx',
        {
          kind: 'word',
          start: { path: '/body/p[1]', offset: 0 },
          end: { path: '/body/p[1]', offset: 5 },
          text: 'Hello',
        },
      ],
      [
        'budget.xlsx',
        {
          kind: 'excel',
          sheet: 'Sheet1',
          range: 'A1:B1',
          cells: [{ path: '/Sheet1/A1', address: 'A1', value: '42' }],
        },
      ],
    ] as const) {
      selection = value as OfficeSelection;
      actualSlide = 1;
      await render(name);
      await click('请求修改');
      inlineRequest = {
        requestId: name,
        prompt: '修改所选内容',
        context: { sourceHash: 'a'.repeat(64), selection },
      };
      await act(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });
      expect(edits.at(-1)).toEqual({ sourceHash: 'a'.repeat(64), selection });
      expect(document.querySelector('[aria-label="放映"]')).toBeNull();
    }
    fail = true;
    await click('请求修改');
    expect(edits).toHaveLength(3);
    expect(document.body.textContent).toContain('无法读取当前选区');
    expect(requests.some((r) => r.method.startsWith('outputs.office.'))).toBe(false);
    expect(requests.some((r) => r.method === 'conversation.send')).toBe(false);
    fail = false;
    holdSend = true;
    inlineRequest = {
      requestId: 'slow-request',
      prompt: '慢请求仍可关闭',
      context: { sourceHash: 'a'.repeat(64), selection },
    };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    const readsDuringSend = requests.filter(
      (r) => r.method === 'outputs.preview.interaction',
    ).length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(
      requests.filter((r) => r.method === 'outputs.preview.interaction').length,
    ).toBeGreaterThan(readsDuringSend);
    expect(prompts.filter((p) => p === '慢请求仍可关闭')).toHaveLength(1);
    inlineRequest = undefined;
    await render('later.pptx');
    const outcomesBefore = requests.filter(
      (r) => r.method === 'outputs.preview.request.result',
    ).length;
    await act(async () => resolveSend!({ status: 'accepted' }));
    expect(requests.filter((r) => r.method === 'outputs.preview.request.result')).toHaveLength(
      outcomesBefore,
    );
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15000);

test('trusted Excel bar preserves drag anchor, text-only formula and local expansion', async () => {
  const dom = new JSDOM('<!doctype html><div id="bar"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key),
    });
  const { createRoot } = await import('react-dom/client');
  const { NativeExcelReadonlyBar } = await import('../../src/native-office-toolbar');
  const root = createRoot(document.getElementById('bar')!);
  const calls: number[] = [];
  const selection: OfficeSelection = {
    kind: 'excel',
    sheet: 'Sheet1',
    range: 'B2:C2',
    cells: [
      { path: '/Sheet1/B2', address: 'B2', value: 'left' },
      {
        path: '/Sheet1/C2',
        address: 'C2',
        value: 'right',
        formula: '<img src=x onerror=alert(1)>',
      },
    ],
  };
  const render = async (ready: boolean, serial = 7) =>
    act(async () =>
      root.render(
        <NativeExcelReadonlyBar
          selection={selection}
          view={{ selectionSerial: serial, activeAddress: 'C2' }}
          ready={ready}
          onLocate={(id) => calls.push(id)}
        />,
      ),
    );
  try {
    await render(true);
    const area = document.querySelector('textarea')!;
    expect(area.readOnly).toBe(true);
    expect(area.value).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('C2 · fx');
    expect(document.body.textContent).toContain('1 行 × 2 列');
    area.select();
    expect(area.selectionEnd - area.selectionStart).toBe(area.value.length);
    await act(async () =>
      (document.querySelector('[aria-label="展开单元格内容"]') as HTMLButtonElement).click(),
    );
    expect(area.rows).toBe(5);
    expect(calls).toEqual([]);
    await act(async () =>
      (document.querySelector('[aria-label="定位当前选区"]') as HTMLButtonElement).click(),
    );
    expect(calls).toEqual([7]);
    await render(false, 8);
    await act(async () =>
      (document.querySelector('[aria-label="定位当前选区"]') as HTMLButtonElement).click(),
    );
    expect(calls).toEqual([7]);
    await render(true, 8);
    await act(async () =>
      (document.querySelector('[aria-label="定位当前选区"]') as HTMLButtonElement).click(),
    );
    expect(calls).toEqual([7, 8]);
    expect(document.querySelector('.native-excel-help')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
