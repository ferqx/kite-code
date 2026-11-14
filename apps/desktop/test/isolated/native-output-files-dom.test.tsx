import { expect, test } from 'bun:test';
import type { OutputFilesPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';

test('file references are bounded, retries use collection revision, and stale scope responses cannot replace the selected reader', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
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
  let edits = 0;
  let queryPage:
    | ((request: Extract<NativeRequest, { method: 'outputs.query' }>) => OutputFilesPage)
    | undefined;
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest) {
      calls.push(request);
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
    const output = useNativeOutputFiles({
      bridge,
      generation: 1,
      storeId: 'store',
      sessionId,
      revision,
      turnLabel: () => '第 1 轮',
      async onEdit() {
        edits++;
      },
    });
    return (
      <>
        <output data-testid="opened-file">
          {output.request && 'fileId' in output.request.target ? output.request.target.fileId : ''}
        </output>
        {output.references}
        {output.renderTurnOutputs({
          turnId: JSON.stringify(['native-run', 'store', sessionId, 'run']),
        })}
      </>
    );
  }
  try {
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await Bun.sleep(130);
    });
    expect(document.querySelector('[aria-label="参考"]')?.querySelectorAll('li')).toHaveLength(5);
    const more = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '展开更多',
    )!;
    await act(() => more.click());
    expect(document.querySelector('[aria-label="参考"]')?.querySelectorAll('li')).toHaveLength(7);
    const moreAction = document.querySelector<HTMLButtonElement>(
      '[aria-label="session-report-0.docx 的更多操作"]',
    )!;
    await act(() => {
      moreAction.focus();
      moreAction.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (button) => button.textContent === '继续修改',
    )!;
    await act(() => edit.click());
    expect(edits).toBe(1);
    expect(calls.every((call) => call.method.startsWith('outputs.'))).toBe(true);
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '重试整理',
    )!;
    await act(async () => retry.click());
    expect(calls.some((call) => call.method === 'outputs.query' && call.runId === 'run')).toBe(
      true,
    );
    expect(calls.find((call) => call.method === 'outputs.retry')).toMatchObject({
      collectionId: 'collection',
      expectedRevision: '7',
      scope: { storeId: 'store', sessionId: 'session' },
      generation: 1,
    });
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
      await act(() => button!.click());
      await settle();
    };
    let lateBatch = false;
    queryPage = (request) => {
      const all = Array.from({ length: lateBatch ? 200 : 100 }, (_, i) =>
        file((lateBatch ? 199 : 99) - i),
      );
      const offset = Number(request.beforeKey ?? 0);
      return {
        ...page,
        items: all.slice(offset, offset + 50),
        collections: [],
        nextCursor: offset + 50 < all.length ? String(offset + 50) : undefined,
      };
    };
    await act(() => root.render(<Harness sessionId="pages" revision={2} />));
    // Return the exact selected scope, as the host does.
    const filePages = queryPage;
    queryPage = (request) => ({ ...filePages(request), scope: request.scope });
    await settle();
    await click('加载更多文件');
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      100,
    );
    // A status-only head refresh must allow the same cursor to be requested again.
    await act(() => root.render(<Harness sessionId="pages" revision={3} />));
    await settle();
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      100,
    );
    // A burst larger than one page must bridge the new head to retained old files.
    lateBatch = true;
    await act(() => root.render(<Harness sessionId="pages" revision={4} />));
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
      items: Array.from({ length: 50 }, (_, i) => file(500 + i)),
      collections: [],
      nextCursor: request.beforeKey ? undefined : 'mixed',
    });
    await act(() => root.render(<Harness sessionId="pages" revision={40} />));
    await settle();
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      150,
    );
    expect(document.body.textContent).toContain('读取文件失败');
    queryPage = (request) => ({
      ...page,
      scope: request.scope,
      revision: '1001',
      items: [{ ...file(999, request.scope.sessionId), name: '替换后的文件.xlsx' }],
      collections: [],
    });
    await act(() => root.render(<Harness sessionId="pages" revision={41} />));
    await settle();
    const output = document.querySelector('[aria-label="本次产出"]')!;
    expect(output.querySelectorAll('li')).toHaveLength(1);
    expect(output.textContent).toContain('替换后的文件.xlsx');
    expect(output.textContent).not.toContain('report-199');
    const newOpen = output.querySelector<HTMLButtonElement>(
      '[aria-label="打开 替换后的文件.xlsx"]',
    )!;
    await act(() => newOpen.click());
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
    await act(() => root.render(<Harness sessionId="pages" revision={42} />));
    await settle();
    expect(document.querySelector('[aria-label="本次产出"]')?.querySelectorAll('li')).toHaveLength(
      2,
    );
    queryPage = (request) => {
      const offset = Number(request.collectionBeforeKey ?? 0);
      return {
        ...page,
        scope: request.scope,
        items: [],
        collections: Array.from({ length: offset ? 12 : 50 }, (_, i) => ({
          ...page.collections[0]!,
          collectionId: `collection-${offset ? offset + i - 1 : i}`,
          revision: offset && i === 0 ? '7' : '8',
        })),
        nextCollectionCursor: offset ? undefined : '50',
      };
    };
    await act(() => root.render(<Harness sessionId="statuses" revision={5} />));
    await settle();
    expect(document.querySelectorAll('[aria-label="本次产出"] [role="alert"]')).toHaveLength(50);
    await click('更多整理状态');
    expect(document.querySelectorAll('[aria-label="本次产出"] [role="alert"]')).toHaveLength(61);
    expect(
      calls.some((call) => call.method === 'outputs.query' && call.collectionBeforeKey === '50'),
    ).toBe(true);
    const duplicateRetry = [...document.querySelectorAll('button')].filter(
      (button) => button.textContent === '重试整理',
    )[49]!;
    await act(async () => duplicateRetry.click());
    expect(
      calls.find(
        (call) => call.method === 'outputs.retry' && call.collectionId === 'collection-49',
      ),
    ).toMatchObject({ expectedRevision: '8' });
    queryPage = (request) => ({ ...page, scope: request.scope, items: [], collections: [] });
    await settle();
    expect(document.querySelectorAll('[aria-label="本次产出"] [role="alert"]')).toHaveLength(0);
    queryPage = (request) => ({
      ...page,
      scope: request.scope,
      items: [],
      collections: [{ ...page.collections[0]!, retryUntil: '2000-01-01T00:00:00Z' }],
    });
    await act(() => root.render(<Harness sessionId="expired" revision={6} />));
    await settle();
    expect(document.body.textContent).toContain('暂存文件已过期，请重新生成');
    expect(
      [...document.querySelectorAll('button')].some((button) => button.textContent === '重试整理'),
    ).toBe(false);
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
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
