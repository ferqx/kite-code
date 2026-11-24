import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import type { NativePreviewLayoutRequest } from '../../src/native-preview-layout-bridge';
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
  expect(names.length).toBeGreaterThan(0);
  for (const name of new Set(names)) expect(theme).toMatch(new RegExp(`${name}:`));
  expect(css).not.toMatch(/var\(--muted[,)]/);
  expect(css).not.toMatch(/var\([^)]*,\s*#/);
});

test('Office toolbar renders shared compact controls with neutral actions and accessible states', async () => {
  const { NativeOfficeToolbar, NativePreviewToolbar } = await import(
    '../../src/native-office-toolbar'
  );
  const dom = new JSDOM(
    renderToStaticMarkup(
      <>
        <NativeOfficeToolbar
          name="review.pptx"
          source="已交付文件"
          powerpoint
          ready={false}
          zoom={1.12}
          presentation
          onZoom={() => {}}
          onPresentation={() => {}}
          onSave={() => {}}
        />
        <NativePreviewToolbar name="readme.txt" editLabel="继续修改" onEdit={() => {}} />
      </>,
    ),
  );
  try {
    const { document } = dom.window;
    const zoom = document.querySelector<HTMLButtonElement>('[aria-label="预览缩放"]')!;
    expect(zoom.dataset.slot).toBe('select-trigger');
    expect(zoom.textContent).toBe('112%');
    expect(zoom.disabled).toBe(true);
    expect(zoom.className).toContain('h-8');
    const presentation = document.querySelector<HTMLButtonElement>('[aria-label="退出放映"]')!;
    expect(presentation.dataset.variant).toBe('secondary');
    expect(presentation.getAttribute('aria-pressed')).toBe('true');
    expect(presentation.disabled).toBe(true);
    for (const label of ['另存为', '继续修改']) {
      const action = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
      expect(action.dataset.slot).toBe('button');
      expect(action.dataset.variant).toBe('outline');
      expect(action.dataset.size).toBe('icon');
      expect(action.className).toContain('rounded-full');
      expect(action.className).toContain('hover:bg-accent');
      expect(action.className).toContain('focus-visible:border-ring');
    }
  } finally {
    dom.window.close();
  }
});

test('Read-only Office keeps source selections, viewport movement and late-result guards without local edit IPC', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLFormElement',
    'DocumentFragment',
    'NodeFilter',
    'HTMLInputElement',
    'Element',
    'Node',
    'CustomEvent',
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
  const layouts: NativePreviewLayoutRequest[] = [];
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
  let hold = false;
  let resolveRead: ((result: NativeResult) => void) | undefined;
  let resolveHeldPoll: (() => void) | undefined;
  let selection: OfficeSelection = {
    kind: 'powerpoint',
    slide: 2,
    objectPath: '/slide[2]/shape[1]',
    text: 'Selected title',
  };
  const interaction = (): OfficePreviewInteraction => ({
    previewId: nextId,
    generation: 1,
    target: { ...target, fileId: currentFile },
    sourceHash: 'a'.repeat(64),
    currentSlide: actualSlide,
    slideCount: 3,
    selection,
    ...(inlineRequest ? { inlineRequest, requestOpen: true } : {}),
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
  const present = (layout: NativePreviewLayoutRequest) => {
    layouts.push(layout);
    return { previewId: layout.previewId, generation: layout.generation };
  };
  const bridge = {
    watch: () => () => {},
    presentPreviewLayout: present,
    presentPreviewLayoutAsync: async (layout: NativePreviewLayoutRequest) => present(layout),
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
        if (hold)
          return new Promise((resolve) => {
            hold = false;
            resolveRead = resolve;
            resolveHeldPoll?.();
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
    [...document.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent) === text,
    )!;
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
    expect(document.querySelector('[aria-label="修改 Skill"]')).toBeNull();
    expect(requests.some((r) => r.method === 'settings.skills.open')).toBe(false);
    expect(document.querySelector('[aria-label="预览缩放"]')?.getAttribute('data-slot')).toBe(
      'select-trigger',
    );
    for (const label of ['放映', '另存为'])
      expect(button(label)?.getAttribute('data-slot')).toBe('button');
    expect(document.body.textContent).not.toContain('来源：Run run');
    expect(document.querySelector('.native-office-toolbar')?.getAttribute('title')).toBe(
      '来源：Run run。只读预览，排版可能与 Office 不同；复杂 3D 与动画不受支持。',
    );
    for (const removed of ['＋ 新增页', 'T 文本', '▧ 图片', '插入 ▾', '应用', '请求修改'])
      expect(button(removed)).toBeUndefined();
    expect(document.querySelector('form,textarea,input')).toBeNull();
    expect(document.body.textContent).not.toContain('演讲者备注');
    expect(requests.find((r) => r.method === 'outputs.preview.open')).toMatchObject({
      bounds: { x: 10 },
    });
    expect(layouts.at(-1)).toMatchObject({
      bounds: { x: 120 },
    });
    const count = layouts.length;
    viewportX = 160;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(layouts.at(-1)).toMatchObject({
      bounds: { x: 160 },
    });
    expect(layouts).toHaveLength(count + 1);
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
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
    await expectControl({ kind: 'zoom', value: 1.25 }, async () => {
      await act(async () => {
        button('预览缩放').dispatchEvent(
          new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
          }),
        );
      });
      await act(async () => {
        [...document.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((option) => option.textContent === '125%')!
          .click();
      });
    });
    hold = true;
    await act(
      async () =>
        new Promise<void>((resolve) => {
          resolveHeldPoll = resolve;
        }),
    );
    const heldRead = resolveRead;
    expect(heldRead).toBeFunction();
    const stale = {
      ...interaction(),
      requestOpen: true,
      inlineRequest: {
        requestId: 'retired-preview',
        prompt: '旧文件请求',
        context: { sourceHash: 'a'.repeat(64), selection },
      },
    };
    await render('other.pptx');
    const body = document.body.textContent;
    await act(async () => heldRead!({ kind: 'outputs.preview.interaction', interaction: stale }));
    expect(edits).toHaveLength(1);
    expect(document.body.textContent).toBe(body);
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
    // The host closed the preceding inline request; wait for its next interaction snapshot.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(button('请求修改')).toBeUndefined();
    expect(edits).toHaveLength(3);
    expect(requests.some((r) => r.method.startsWith('outputs.office.'))).toBe(false);
    expect(requests.some((r) => r.method === 'conversation.send')).toBe(false);
    holdSend = true;
    inlineRequest = {
      requestId: 'slow-request',
      prompt: '慢请求仍可关闭',
      context: { sourceHash: 'a'.repeat(64), selection },
    };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(document.querySelector<HTMLButtonElement>('[aria-label="预览缩放"]')!.disabled).toBe(
      true,
    );
    expect(document.querySelector<HTMLButtonElement>('[aria-label="另存为"]')!.disabled).toBe(
      false,
    );
    expect(button('请求修改')).toBeUndefined();
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
    'HTMLFormElement',
    'DocumentFragment',
    'Node',
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
  const { NativeOfficeToolbar } = await import('../../src/native-office-toolbar');
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
  const render = async (ready: boolean, serial = 7, selected: OfficeSelection | null = selection) =>
    act(async () =>
      root.render(
        <NativeOfficeToolbar
          name="budget.xlsx"
          source="交付文件"
          powerpoint={false}
          presentation={false}
          zoom="fit"
          onZoom={() => {}}
          onPresentation={() => {}}
          ready={ready}
          excel={{
            selection: selected,
            view: { selectionSerial: serial, activeAddress: 'C2' },
            onLocate: (id) => calls.push(id),
          }}
        />,
      ),
    );
  const click = async (label: string) =>
    act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  try {
    await render(true, 1, null);
    expect(document.querySelector('.native-excel-readonly,textarea')).toBeNull();
    await render(true);
    expect(document.querySelector('.native-office-toolbar .native-excel-readonly')).toBeNull();
    expect(
      document.querySelector('.native-office-toolbar + .native-excel-readonly'),
    ).not.toBeNull();
    const area = document.querySelector<HTMLTextAreaElement>('.native-excel-readonly textarea')!;
    expect(area.rows).toBe(1);
    expect(area.readOnly).toBe(true);
    expect(area.value).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(area.getAttribute('aria-description')).toContain('起选格 C2');
    expect(area.getAttribute('aria-description')).toContain('1 行 × 2 列');
    expect(document.querySelector('.native-excel-range')?.textContent).toBe('C2');
    area.select();
    expect(area.selectionEnd - area.selectionStart).toBe(area.value.length);
    await click('展开单元格内容');
    const details = document.querySelector<HTMLTextAreaElement>('.native-excel-details textarea')!;
    expect(details.rows).toBe(5);
    expect(details.readOnly).toBe(true);
    expect(details.value).toBe(area.value);
    expect(document.querySelector('img')).toBeNull();
    expect(calls).toEqual([]);
    const toggle = document.querySelector<HTMLButtonElement>('.native-excel-expand')!;
    const escapeEvent = () =>
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
    details.focus();
    const nested = escapeEvent();
    await act(() => {
      details.dispatchEvent(nested);
    });
    expect(nested.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.native-excel-details')).toBeNull();
    const outer = escapeEvent();
    await act(() => {
      toggle.dispatchEvent(outer);
    });
    expect(outer.defaultPrevented).toBe(false);
    expect(area.value).toBe('<img src=x onerror=alert(1)>');
    await click('展开单元格内容');
    await click('定位当前选区');
    expect(calls).toEqual([7]);
    await render(false, 8);
    expect(document.querySelector('.native-excel-details')).toBeNull();
    await click('定位当前选区');
    expect(calls).toEqual([7]);
    await render(true, 8);
    await click('定位当前选区');
    expect(calls).toEqual([7, 8]);
    await click('展开单元格内容');
    await render(true, 9, { kind: 'excel', scope: 'sheet', sheet: 'Sheet1' });
    expect(
      document.querySelector('.native-excel-details,.native-excel-readonly,textarea'),
    ).toBeNull();
    // A new native preview can restart its selection serial after the previous one disappeared.
    await render(true, 8);
    expect(document.querySelector('.native-excel-details')).toBeNull();
    await render(true, 10, {
      kind: 'excel',
      sheet: 'Sheet1',
      range: 'C2',
      cells: [{ address: 'C2', path: '/Sheet1/C2', value: '' }],
    });
    expect(document.querySelector('.native-excel-range')?.textContent).toBe('C2');
    expect(document.querySelectorAll('textarea,.native-excel-expand')).toHaveLength(0);
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
