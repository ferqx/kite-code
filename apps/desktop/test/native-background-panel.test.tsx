import { expect, test } from 'bun:test';
import type { BackgroundExecutionItem, ExecutionOutputPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeBackgroundPanel } from '../src/native-background-panel';
import type { NativeBridge, NativeRequest } from '../src/native-bridge';
import { backgroundItem } from './background-item.fixture';

async function fixture(
  run: (
    host: HTMLElement,
    render: (port: NativeBridge, scope?: { generation: number; storeId: string }) => Promise<void>,
  ) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>'),
    prior = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
      IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT,
    };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  try {
    await run(host, async (bridge, scope = { generation: 1, storeId: 'store' }) => {
      await act(async () =>
        root.render(
          <NativeBackgroundPanel
            bridge={bridge}
            generation={scope.generation}
            storeId={scope.storeId}
            unavailable={false}
            onChanged={async () => undefined}
          />,
        ),
      );
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
}
const click = (host: HTMLElement, name: string) =>
  act(async () => {
    [...host.querySelectorAll('button')].find((button) => button.textContent === name)!.click();
  });
test('Native background DOM publishes only complete pages, shows original parent/child lifecycle, reads nonselected output and submits one exact stop', async () =>
  fixture(async (host, render) => {
    const items = [backgroundItem(1, true), backgroundItem(2)],
      calls: NativeRequest[] = [];
    let finish!: () => void, pending: NativeRequest | undefined;
    const page = (
      request: NativeRequest,
      entries: BackgroundExecutionItem[],
      startIndex: number,
      nextIndex: number,
    ) => ({
      kind: 'background.page' as const,
      viewGeneration: 1,
      storeId: 'store',
      readId: 'readId' in request ? (request.readId ?? '') : '',
      observationId: 1,
      startIndex,
      nextIndex,
      total: 2,
      complete: nextIndex === 2,
      entries,
    });
    const bridge: NativeBridge = {
      watch: () => () => undefined,
      request: async (request) => {
        calls.push(request);
        if (request.method === 'background.open') return page(request, [items[0]!], 0, 1);
        if (request.method === 'background.next') {
          pending = request;
          await new Promise<void>((done) => {
            finish = done;
          });
          return page(request, [items[1]!], 1, 2);
        }
        if (request.method === 'background.stop')
          return { id: request.commandId, kind: 'execution.cancel', status: 'applied' } as never;
        if (request.method === 'background.output.open') {
          const output: ExecutionOutputPage = {
            highWaterSeq: '2',
            items: [
              {
                executionId: request.executionId,
                seq: '1',
                throughSeq: '1',
                stream: 'stdout',
                content: '完整非选中原输出🙂\n',
                droppedBytes: '0',
              },
              {
                executionId: request.executionId,
                seq: '2',
                throughSeq: '2',
                stream: 'stderr',
                content: '',
                droppedBytes: null,
              },
            ],
          };
          return {
            kind: 'jobOutput.page',
            readId: request.readId,
            scope: {
              generation: 1,
              viewSelection: 1,
              historyEpoch: 0,
              storeId: 'store',
              sessionId: 'root',
              workspaceId: 'w',
              executionId: request.executionId,
            },
            afterSeq: '0',
            upperSeq: '2',
            nextAfterSeq: '2',
            complete: true,
            page: output,
          };
        }
        return null;
      },
    };
    await render(bridge);
    expect(calls).toHaveLength(0);
    await click(host, '打开后台总览');
    expect(pending).toBeDefined();
    expect(host.textContent).not.toContain('原执行 job-1');
    expect(host.textContent).not.toContain('后台目录已完整读取');
    await act(async () => {
      finish();
    });
    expect(host.textContent).toContain('后台目录已完整读取，共 2 项');
    expect(host.textContent).toContain('原父轮次 parent-run · waiting_execution');
    expect(host.textContent).toContain('本轮必需任务');
    expect(host.textContent).toContain('原子轮次 original-child-run · running');
    const second = host.querySelector<HTMLElement>('[data-execution-id="job-2"]')!;
    await click(second, '读取完整已保存输出');
    expect(second.textContent).toContain('完整非选中原输出🙂');
    expect(second.textContent).toContain('此区间丢失字节数无法确定');
    await click(second, '停止后台执行 · job-2');
    expect(calls.filter((call) => call.method === 'background.stop')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'background.stop')).toMatchObject({
      generation: 1,
      observationId: 1,
      executionId: 'job-2',
    });
    expect(host.textContent).toContain('停止请求已受理：job-2');
    expect(items[0]!.execution.status).toBe('running');
    await click(host, '关闭后台总览');
    expect(host.textContent).not.toContain('原执行 job-2');
    expect(
      calls.filter((call) => call.method === 'background.output.close').length,
    ).toBeGreaterThanOrEqual(1);
  }));

test('Native background attach replacement clears the old complete facts and refuses late reads', async () =>
  fixture(async (host, render) => {
    const item = backgroundItem(1),
      calls: NativeRequest[] = [];
    let release!: () => void;
    let wait = false;
    const bridge: NativeBridge = {
      watch: () => () => undefined,
      request: async (request) => {
        calls.push(request);
        if (request.method !== 'background.open') return null;
        if (request.generation === 2) throw Error('background_unavailable');
        if (wait)
          await new Promise<void>((done) => {
            release = done;
          });
        return {
          kind: 'background.page',
          viewGeneration: 1,
          storeId: 'store',
          readId: request.readId,
          observationId: 1,
          startIndex: 0,
          nextIndex: 1,
          total: 1,
          complete: true,
          entries: [item],
        };
      },
    };
    await render(bridge);
    await click(host, '打开后台总览');
    expect(host.textContent).toContain('原执行 job-1');
    wait = true;
    await click(host, '刷新后台总览');
    await render(bridge, { generation: 2, storeId: 'other-store' });
    expect(host.textContent).not.toContain('原执行 job-1');
    expect(host.textContent).not.toContain('后台目录已完整读取');
    expect(host.textContent).toContain('打开后台总览');
    await act(async () => {
      release();
    });
    expect(host.textContent).not.toContain('原执行 job-1');
    await click(host, '打开后台总览');
    expect(host.textContent).toContain('background_unavailable');
    expect(host.textContent).not.toContain('原执行 job-1');
    expect(calls.filter((call) => call.method === 'background.stop')).toHaveLength(0);
    expect(
      calls.filter((call) => call.method === 'background.close' && call.generation === 1).length,
    ).toBeGreaterThan(0);
  }));
