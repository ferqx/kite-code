import { expect, test } from 'bun:test';
import type { OutputFilesPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';

test('file references show only files across reads, pagination, and scope changes', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'Node',
    'Element',
    'NodeFilter',
    'CustomEvent',
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
  const { useNativeOutputFiles } = await import('../../src/native-output-files');
  const { useNativeErrorFeedback } = await import('../../src/native-error-feedback');
  const { NativeToast } = await import('../../src/native-message');
  const root = createRoot(document.getElementById('root')!);
  const calls: NativeRequest[] = [];
  const file = (index: number, sessionId = 'session') => ({
    storeId: 'store',
    sessionId,
    fileId: `file-${index}`,
    locator: { kind: 'delivery' as const, key: `delivery/00000000000000000001/job/file-${index}` },
    ownerRunId: 'run',
    name: `report-${index}.docx`,
    mediaType: 'application/octet-stream',
    size: '10',
    publishedAt: '2026-11-11T00:00:00Z',
  });
  const page: OutputFilesPage = {
    scope: { storeId: 'store', sessionId: 'session' },
    revision: '999',
    items: Array.from({ length: 7 }, (_, i) => file(i)),
    collections: [
      {
        collectionId: 'collection',
        revision: '7',
        ownerRunId: 'run',
        state: 'failed',
        expectedCount: 8,
        publishedCount: 7,
        errorCode: 'archive_failed',
        retryUntil: '2099-01-01T00:00:00Z',
      },
    ],
  };
  let late: ((value: NativeResult) => void) | undefined;
  let hold = false;
  let queryPage:
    | ((request: Extract<NativeRequest, { method: 'outputs.query' }>) => OutputFilesPage)
    | undefined;
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest) {
      calls.push(request);
      if (request.method === 'outputs.sources')
        return { kind: 'outputs.sources', scope: request.scope, sources: [] };
      if (request.method === 'outputs.save') throw Error('output_save_failed');
      if (request.method === 'outputs.reveal') throw Error('output_reveal_failed');
      if (request.method === 'outputs.openInApp') throw Error('output_open_in_app_failed');
      if (request.method === 'outputs.query') {
        if (queryPage) return { kind: 'outputs.page', page: queryPage(request) };
        if (hold && request.scope.sessionId === 'old')
          return await new Promise((resolve) => {
            late = resolve;
          });
        return {
          kind: 'outputs.page',
          page: {
            ...page,
            scope: request.scope,
            items: page.items.map((item) => ({
              ...item,
              sessionId: request.scope.sessionId,
              name: `${request.scope.sessionId}-${item.name}`,
            })),
          },
        };
      }
      return null;
    },
  } as NativeBridge;
  function Harness({
    sessionId = 'session',
    revision = 1,
  }: {
    sessionId?: string;
    revision?: number;
  }) {
    const feedback = useNativeErrorFeedback(sessionId);
    const output = useNativeOutputFiles({
      bridge,
      generation: 1,
      storeId: 'store',
      sessionId,
      revision,
      onError: feedback.report,
      turnLabel: () => '第 1 轮',
      async onEdit() {},
    });
    return (
      <>
        <NativeToast message={feedback.message} onDismiss={feedback.dismiss} />
        <output data-testid="opened-file">
          {output.request && 'fileId' in output.request.target ? output.request.target.fileId : ''}
        </output>
        {output.references}
        <div data-testid="turn-outputs">
          {output.renderTurnOutputs({
            turnId: JSON.stringify(['native-run', 'store', sessionId, 'run']),
          })}
        </div>
      </>
    );
  }
  try {
    await act(async () => {
      root.render(<Harness />);
    });
    expect(calls.some((call) => call.method === 'outputs.query' && call.runId === 'run')).toBe(
      true,
    );
    await act(async () => {
      await Bun.sleep(130);
    });
    const references = () => document.querySelector('[aria-label="输出"]');
    expect(references()?.querySelectorAll('li')).toHaveLength(7);
    const link = references()!.querySelector<HTMLButtonElement>(
      '[aria-label="打开 session-report-0.docx"]',
    )!;
    await act(() => link.click());
    expect(document.querySelector('[data-testid="opened-file"]')?.textContent).toBe('file-0');
    const preview = document.querySelector<HTMLButtonElement>(
      '.output-file-card [aria-label="预览 session-report-1.docx"]',
    )!;
    await act(() => preview.click());
    expect(document.querySelector('[data-testid="opened-file"]')?.textContent).toBe('file-1');
    const openInApp = document.querySelector<HTMLButtonElement>(
      '.output-file-card [aria-label="打开 session-report-0.docx"]',
    )!;
    await act(async () => openInApp.click());
    expect(calls.at(-1)).toEqual({
      method: 'outputs.openInApp',
      generation: 1,
      target: {
        storeId: 'store',
        sessionId: 'session',
        fileId: 'file-0',
        locator: file(0).locator,
      },
    });
    expect(document.querySelector('.native-toast-card')?.textContent).toContain('检查系统默认应用');
    expect(document.querySelector('[data-testid="opened-file"]')?.textContent).toBe('file-1');
    await act(() => document.querySelector<HTMLButtonElement>('.native-toast-close')!.click());
    await act(() => link.click());
    const moreLabel = '[aria-label="session-report-0.docx 的更多操作"]';
    const openFileActions = (moreAction: HTMLButtonElement) =>
      act(() => {
        moreAction.focus();
        moreAction.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
    await openFileActions(
      document.querySelector<HTMLButtonElement>(`.output-file-card ${moreLabel}`)!,
    );
    const menu = document.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(
      ['另存为', '在资源管理器中显示'],
    );
    expect(calls.every((call) => call.method.startsWith('outputs.'))).toBe(true);
    const save = menu.querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => save.click());
    expect(document.querySelector('.native-toast-card')?.textContent).toContain('另存失败');
    expect(references()?.textContent).not.toContain('另存失败');
    const outputs = document.querySelector('[data-testid="turn-outputs"]');
    expect(outputs?.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(outputs?.textContent).not.toContain('重试整理');
    expect(references()?.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(document.querySelector('[aria-label="文件整理"]')).toBeNull();
    await act(() => document.querySelector<HTMLButtonElement>('.native-toast-close')!.click());
    await openFileActions(references()!.querySelector<HTMLButtonElement>(moreLabel)!);
    const reveal = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(reveal.textContent).toBe('在资源管理器中显示');
    await act(async () => reveal.click());
    expect(calls.at(-1)).toEqual({
      method: 'outputs.reveal',
      generation: 1,
      target: {
        storeId: 'store',
        sessionId: 'session',
        fileId: 'file-0',
        locator: file(0).locator,
      },
    });
    expect(document.querySelector('.native-toast-card')?.textContent).toContain(
      '无法在资源管理器中显示文件',
    );
    expect(document.querySelector('[data-testid="opened-file"]')?.textContent).toBe('file-0');
    await act(() => document.querySelector<HTMLButtonElement>('.native-toast-close')!.click());
    const settle = async () => {
      await act(async () => {
        await Bun.sleep(130);
      });
    };
    const click = async (label: string) => {
      const button = [...document.querySelectorAll('button')].find(
        (item) => item.textContent === label,
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
      await settle();
    };
    const turnOutputs = () => document.querySelector('[data-testid="turn-outputs"]')!;
    queryPage = () => {
      throw Error('output_query_failed');
    };
    await act(async () => root.render(<Harness sessionId="no-outputs" />));
    expect(turnOutputs().childNodes).toHaveLength(0);
    expect(references()).toBeNull();
    await settle();
    expect(turnOutputs().childNodes).toHaveLength(0);
    expect(references()).toBeNull();
    expect(document.querySelector('.native-toast-card')).toBeNull();

    let lateBatch = false;
    queryPage = (request) => {
      const all = Array.from({ length: lateBatch ? 200 : 100 }, (_, i) =>
        file((lateBatch ? 199 : 99) - i, request.scope.sessionId),
      );
      const offset = Number(request.beforeKey ?? 0);
      return {
        ...page,
        scope: request.scope,
        items: all.slice(offset, offset + 50),
        collections: [],
        nextCursor: offset + 50 < all.length ? String(offset + 50) : undefined,
      };
    };
    await act(async () => root.render(<Harness sessionId="pages" revision={2} />));
    await settle();
    await click('加载更多');
    expect(references()?.querySelectorAll('li')).toHaveLength(100);
    await click('加载更多文件');
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      100,
    );
    // A status-only head refresh must allow the same cursor to be requested again.
    await act(async () => root.render(<Harness sessionId="pages" revision={3} />));
    await settle();
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      100,
    );
    // A burst larger than one page must bridge the new head to retained old files.
    lateBatch = true;
    await act(async () => root.render(<Harness sessionId="pages" revision={4} />));
    await settle();
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      100,
    );
    await click('加载更多文件');
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      150,
    );
    queryPage = (request) => ({
      ...page,
      scope: request.scope,
      revision: request.beforeKey ? '1001' : '1000',
      items: Array.from({ length: 50 }, (_, i) => file(500 + i, request.scope.sessionId)),
      collections: [],
      nextCursor: request.beforeKey ? undefined : 'mixed',
    });
    await act(async () => root.render(<Harness sessionId="pages" revision={40} />));
    await settle();
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      150,
    );
    expect(turnOutputs().querySelector('[role="alert"]')).toBeNull();
    expect(turnOutputs().textContent).not.toContain('读取文件失败');
    queryPage = (request) => ({
      ...page,
      scope: request.scope,
      revision: '1001',
      items: [{ ...file(999, request.scope.sessionId), name: '替换后的文件.xlsx' }],
      collections: [],
    });
    await act(async () => root.render(<Harness sessionId="pages" revision={41} />));
    await settle();
    const output = document.querySelector('[aria-label="本次产出"]')!;
    expect(output.querySelectorAll('li')).toHaveLength(1);
    expect(output.textContent).toContain('替换后的文件.xlsx');
    expect(output.textContent).not.toContain('report-199');
    const newPreview = output.querySelector<HTMLButtonElement>(
      '[aria-label="预览 替换后的文件.xlsx"]',
    )!;
    await act(() => newPreview.click());
    expect(document.querySelector('[data-testid="opened-file"]')?.textContent).toBe('file-999');
    queryPage = (request) => ({
      ...page,
      scope: request.scope,
      revision: '1002',
      items: [
        { ...file(1000, request.scope.sessionId), name: '并发.xlsx' },
        { ...file(1001, request.scope.sessionId), name: '并发.xlsx' },
      ],
      collections: [],
    });
    await act(async () => root.render(<Harness sessionId="pages" revision={42} />));
    await settle();
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      2,
    );
    queryPage = (request) => ({
      ...page,
      scope: request.scope,
      items: [],
      collections: [
        ...page.collections,
        {
          ...page.collections[0]!,
          collectionId: 'pending',
          state: 'pending',
          errorCode: undefined,
        },
        {
          ...page.collections[0]!,
          collectionId: 'expired',
          retryUntil: '2000-01-01T00:00:00Z',
        },
      ],
      nextCollectionCursor: '50',
    });
    await act(async () => root.render(<Harness sessionId="statuses" revision={5} />));
    await settle();
    expect(turnOutputs().childNodes).toHaveLength(0);
    expect(references()).toBeNull();
    expect(document.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/文件整理|重试|暂存文件/);
    queryPage = undefined;
    hold = true;
    await act(async () => root.render(<Harness sessionId="old" />));
    await act(async () => {
      await Bun.sleep(130);
    });
    expect(late).toBeDefined();
    await act(async () => root.render(<Harness sessionId="new" />));
    await act(async () => {
      await Bun.sleep(130);
    });
    await act(async () =>
      late!({
        kind: 'outputs.page',
        page: { ...page, scope: { storeId: 'store', sessionId: 'old' }, items: [file(99, 'old')] },
      }),
    );
    expect(document.body.textContent).toContain('new-report-0.docx');
    expect(document.body.textContent).not.toContain('report-99.docx');
    expect(
      calls.some(
        (call) =>
          call.method === 'outputs.retry' ||
          (call.method === 'outputs.query' && call.collectionBeforeKey !== undefined),
      ),
    ).toBe(false);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15_000);
