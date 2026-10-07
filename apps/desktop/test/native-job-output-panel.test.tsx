import { expect, test } from 'bun:test';
import type { ExecutionOutputPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeJobOutputPage,
  NativeJobOutputRequest,
  NativeSelection,
} from '../src/native-bridge';
import { NativeJobOutputPanel } from '../src/native-job-output-panel';

const selected = (viewSelection = 2) =>
  ({
    storeId: 'store',
    session: { id: 's', workspaceId: 'w' },
    executions: [{ id: 'job', originStoreId: 'store' }],
    viewSelection,
  }) as unknown as NativeSelection;
const row = (
  seq: string,
  stream: 'stdout' | 'stderr' | 'progress',
  content: string,
  throughSeq = seq,
  droppedBytes: string | null = '0',
) => ({ executionId: 'job', seq, throughSeq, stream, content, droppedBytes });
function result(
  request: NativeJobOutputRequest,
  rows: ExecutionOutputPage['items'],
  patch: Partial<NativeJobOutputPage> = {},
): NativeJobOutputPage {
  return {
    kind: 'jobOutput.page',
    readId: request.readId,
    scope: {
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      storeId: 'store',
      originStoreId: 'store',
      sessionId: 's',
      workspaceId: 'w',
      executionId: 'job',
    },
    afterSeq: '0',
    upperSeq: '4',
    nextAfterSeq: '4',
    complete: true,
    page: { items: rows, highWaterSeq: '4' },
    ...patch,
  };
}
async function fixture(
  run: (
    host: HTMLElement,
    render: (
      bridge: NativeBridge,
      selection?: NativeSelection,
      historyEpoch?: number,
    ) => Promise<void>,
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
    await run(host, async (bridge, selection = selected(), historyEpoch = 0) => {
      await act(async () =>
        root.render(
          <NativeJobOutputPanel
            bridge={bridge}
            generation={1}
            selection={selection}
            historyEpoch={historyEpoch}
            executionId="job"
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
const port = (request: (request: NativeJobOutputRequest) => Promise<NativeJobOutputPage | null>) =>
  ({ request, watch: () => () => undefined }) as NativeBridge;
const click = (host: HTMLElement, name: string) =>
  act(async () => {
    [...host.querySelectorAll('button')].find((button) => button.textContent === name)!.click();
  });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('Job DOM waits for full coverage then keeps every ordinary Unicode chunk inside overlapping stream gaps and exact missing bytes', async () =>
  fixture(async (host, render) => {
    const late = deferred<NativeJobOutputPage>(),
      calls: NativeJobOutputRequest[] = [];
    let next: NativeJobOutputRequest | undefined;
    const bridge = port(async (request) => {
      calls.push(request);
      if (request.method === 'jobOutput.close') return null;
      if (request.method === 'jobOutput.open')
        return result(request, [row('1', 'stdout', '头部\n🙂')], {
          complete: false,
          nextAfterSeq: '1',
        });
      next = request;
      return late.promise;
    });
    await render(bridge);
    expect(calls).toHaveLength(0);
    await click(host, '读取完整已保存输出');
    expect(host.textContent).toContain('正在读取完整已保存输出');
    expect(host.querySelector('pre')).toBeNull();
    expect(host.textContent).not.toContain('已完整读取截至');
    await act(async () =>
      late.resolve(
        result(
          next!,
          [
            row('2', 'stdout', '', '4', null),
            row('3', 'stderr', '保留stderr中🙂\n尾'),
            row('4', 'progress', '', '4', '77'),
          ],
          {
            afterSeq: '1',
            page: {
              highWaterSeq: '8',
              items: [
                row('2', 'stdout', '', '4', null),
                row('3', 'stderr', '保留stderr中🙂\n尾'),
                row('4', 'progress', '', '4', '77'),
              ],
            },
          },
        ),
      ),
    );
    expect(host.textContent).toContain('已完整读取截至输出序号 4');
    expect([...host.querySelectorAll('pre')].map((item) => item.textContent)).toEqual([
      '头部\n🙂',
      '保留stderr中🙂\n尾',
    ]);
    expect(host.querySelectorAll('li')).toHaveLength(4);
    expect(host.textContent).toContain('此区间丢失字节数无法确定');
    expect(host.textContent).toContain('丢失 77 字节');
    expect(calls.at(-1)!.method).toBe('jobOutput.close');
    const count = calls.length;
    await render(bridge, { ...selected(), viewGeneration: 9 });
    expect(calls).toHaveLength(count);
  }));

test('same Job refresh failure preserves only prior complete facts, close hides them, and reselect discards late original reads', async () =>
  fixture(async (host, render) => {
    const late = deferred<NativeJobOutputPage>(),
      calls: NativeJobOutputRequest[] = [];
    let opens = 0;
    const bridge = port(async (request) => {
      calls.push(request);
      if (request.method === 'jobOutput.close') return null;
      opens++;
      if (opens === 1)
        return result(request, [row('1', 'stdout', 'KNOWN_COMPLETE')], {
          upperSeq: '1',
          nextAfterSeq: '1',
          page: { items: [row('1', 'stdout', 'KNOWN_COMPLETE')], highWaterSeq: '1' },
        });
      if (opens === 2) throw Error('output_unavailable');
      return late.promise;
    });
    await render(bridge);
    await click(host, '读取完整已保存输出');
    await click(host, '刷新已保存输出');
    expect(host.textContent).toContain('KNOWN_COMPLETE');
    expect(host.textContent).toContain('保留上次完整内容，尚未确认最新输出');
    await click(host, '关闭输出');
    expect(host.querySelector('pre')).toBeNull();
    await click(host, '读取完整已保存输出');
    await render(bridge, selected(3));
    expect(host.textContent).not.toContain('KNOWN_COMPLETE');
    expect(host.textContent).toContain('读取完整已保存输出');
    const request = [...calls].reverse().find((call) => call.method === 'jobOutput.open')!;
    await act(async () =>
      late.resolve(
        result(request, [row('1', 'stdout', 'LATE_BODY')], {
          upperSeq: '1',
          nextAfterSeq: '1',
          page: { items: [row('1', 'stdout', 'LATE_BODY')], highWaterSeq: '1' },
        }),
      ),
    );
    expect(host.textContent).not.toContain('LATE_BODY');
    expect(calls.every((call) => call.method.startsWith('jobOutput.'))).toBe(true);
  }));

test('actual empty output differs from early EOF failure and observation reset clears the original completed body', async () =>
  fixture(async (host, render) => {
    let opens = 0;
    const bridge = port(async (request) => {
      if (request.method === 'jobOutput.close') return null;
      opens++;
      return opens === 1
        ? result(request, [], {
            upperSeq: '0',
            nextAfterSeq: '0',
            page: { items: [], highWaterSeq: '0' },
          })
        : result(request, []);
    });
    await render(bridge);
    await click(host, '读取完整已保存输出');
    expect(host.textContent).toContain('此 Job 尚无已保存输出');
    await click(host, '关闭输出');
    await click(host, '读取完整已保存输出');
    expect(host.textContent).toContain('输出读取失败：execution_output_page_conflict');
    expect(host.textContent).not.toContain('已完整读取截至');
    await render(bridge, selected(), 1);
    expect(host.textContent).toContain('读取完整已保存输出');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  }));
