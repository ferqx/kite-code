import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BackgroundExecutionItem, ExecutionOutputPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeBackgroundPanel } from '../src/native-background-panel';
import type { NativeBridge, NativeRequest, NativeSelection } from '../src/native-bridge';
import { environmentDisplay, useNativeEnvironment } from '../src/native-environment';
import { backgroundItem } from './background-item.fixture';

async function fixture(
  run: (
    host: HTMLElement,
    render: (port: NativeBridge, scope?: { generation: number; storeId: string }) => Promise<void>,
  ) => Promise<void>,
  surface?: (bridge: NativeBridge, scope: { generation: number; storeId: string }) => ReactNode,
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
          surface ? (
            surface(bridge, scope)
          ) : (
            <NativeBackgroundPanel
              bridge={bridge}
              generation={scope.generation}
              storeId={scope.storeId}
              unavailable={false}
              onChanged={async () => undefined}
            />
          ),
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

test('retained environment card separates Shell and named children, exact stop, read-only child return and stale presentation', async () => {
  const shell = backgroundItem(1),
    child = backgroundItem(2, true),
    other = backgroundItem(3);
  shell.execution.definitionId = 'shell.command';
  other.execution.definitionId = 'mcp.job';
  child.childSession!.title = '原子智能体';
  child.execution.status = 'succeeded';
  const items = [shell, child, other],
    calls: NativeRequest[] = [];
  const selection: NativeSelection = {
    viewGeneration: 1,
    viewSelection: 1,
    storeId: 'store',
    session: shell.rootSession,
    runs: [],
    executions: [],
    interactions: [],
    interactionsAfterId: null,
    canReadModelOutput: false,
    permissions: undefined,
  };
  const message = {
    id: 'child-message',
    sessionId: child.childSession!.id,
    seq: '1',
    role: 'assistant',
    content: '原子会话全文🙂',
    contentFormat: 'plain',
    complete: true,
    runId: child.childRun?.id ?? null,
  };
  const body = Buffer.from(
    JSON.stringify({
      item: child,
      session: child.childSession,
      upperSeq: '1',
      messages: [message],
      modelOutputs: [],
    }),
  );
  let failed = false;
  let finishChildRead!: () => void;
  const childReadFinished = new Promise<void>((resolve) => {
    finishChildRead = resolve;
  });
  const port: NativeBridge = {
    watch: () => () => undefined,
    request: async (request) => {
      calls.push(request);
      if (request.method.startsWith('background.'))
        expect('surface' in request && request.surface).toBe('environment');
      if (request.method === 'background.open') {
        if (failed) throw Error('directory_changed');
        return {
          kind: 'background.page',
          viewGeneration: 1,
          viewSelection: 1,
          rootSessionId: 'root',
          storeId: 'store',
          readId: request.readId,
          observationId: 1,
          startIndex: 0,
          nextIndex: items.length,
          total: items.length,
          complete: true,
          entries: structuredClone(items),
        };
      }
      if (request.method === 'background.stop') {
        expect(request.executionId).toBe(shell.execution.id);
        shell.execution.cancelRequested = true;
        return { id: request.commandId, status: 'accepted' } as never;
      }
      if (request.method === 'background.child.open')
        return {
          kind: 'background.child.opened',
          viewGeneration: 1,
          viewSelection: 1,
          rootSessionId: 'root',
          storeId: 'store',
          readId: request.readId,
          observationId: 1,
          executionId: child.execution.id,
          childSessionId: child.childSession!.id,
          childRunId: child.childRun?.id ?? null,
          wireBytes: String(body.length),
          wireHash: createHash('sha256').update(body).digest('hex'),
        };
      if (request.method === 'background.child.read')
        return {
          kind: 'background.child.chunk',
          readId: request.readId,
          offset: 0,
          nextOffset: body.length,
          eof: true,
          data: body.toString('base64'),
        };
      if (request.method === 'background.child.close') {
        finishChildRead();
        return null;
      }
      if (request.method === 'background.close') return null;
      throw Error('unexpected_operation');
    },
  };
  function Surface() {
    const [draft, setDraft] = useState('原父会话草稿');
    const environment = useNativeEnvironment({
      bridge: port,
      generation: 1,
      selection,
      revision: 0,
      unavailable: false,
      onChanged: async () => undefined,
    });
    return environment.child ? (
      <section aria-label="只读子详情">
        <p>子 Agent 会话仅供查看。</p>
        {environment.child.facts?.messages.map((entry) => (
          <p key={entry.id}>{entry.content}</p>
        ))}
        {environment.child.error && <p>{environment.child.error}</p>}
        <button type="button" onClick={environment.closeChild}>
          返回主会话
        </button>
      </section>
    ) : (
      <>
        {environment.card}
        <input
          aria-label="父草稿"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </>
    );
  }
  await fixture(
    async (host, render) => {
      // The shared fixture mounts the real hook and retained card; no effect is created by navigation.
      await render(port);
      const region = host.querySelector('[aria-label="环境信息"]')!;
      expect(region.textContent).toContain('当前运行的 Shell');
      expect(region.textContent).toContain(shell.execution.id);
      expect(region.textContent).toContain('原子智能体');
      expect(region.textContent).not.toContain(other.execution.id);
      await act(async () => {
        (
          region.querySelector('[aria-label="查看子 Agent 详情：原子智能体"]') as HTMLElement
        ).click();
        await childReadFinished;
      });
      expect(host.textContent).toContain('原子会话全文🙂');
      expect(host.querySelector('input')).toBeNull();
      expect(calls.filter((request) => request.method === 'background.stop')).toHaveLength(0);
      await click(host, '返回主会话');
      expect((host.querySelector('[aria-label="父草稿"]') as HTMLInputElement).value).toBe(
        '原父会话草稿',
      );
      await act(async () => {
        const stop = [...host.querySelectorAll('button')].find(
          (button) => button.textContent === '停止',
        )!;
        stop.click();
        stop.click();
      });
      expect(calls.filter((request) => request.method === 'background.stop')).toHaveLength(1);
      expect(host.textContent).toContain('正在停止');
      failed = true;
      await act(async () =>
        (host.querySelector('[aria-label="刷新子 Agent"]') as HTMLElement).click(),
      );
      expect(host.textContent).toContain('上次状态 · 正在核对');
      expect(host.textContent).toContain('原子智能体');
      expect(host.textContent).toContain('directory_changed');
      expect(
        [...host.querySelectorAll('button')].some((button) => button.textContent === '停止'),
      ).toBe(false);
    },
    () => <Surface />,
  );
});

test('environment adapter keeps unknown and restored child facts distinct and never infers cleanup', () => {
  const child = backgroundItem(1, true);
  child.execution.status = 'outcome_unknown';
  expect(environmentDisplay([child], 'store').rows[0]).toMatchObject({
    status: 'unknown',
    cleanupConfirmed: false,
    canStop: false,
  });
  child.execution.status = 'running';
  child.execution.originStoreId = 'original';
  expect(environmentDisplay([child], 'store').rows[0]).toMatchObject({
    status: 'restored',
    cleanupConfirmed: false,
    canStop: false,
  });
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
              originStoreId: 'store',
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

test('restored background DOM retains original Store and read-only history while current work remains stoppable', async () =>
  fixture(async (host, render) => {
    const old = backgroundItem(1),
      current = backgroundItem(2);
    old.execution.originStoreId = 'original-store';
    old.run!.originStoreId = 'original-store';
    const calls: NativeRequest[] = [];
    const bridge: NativeBridge = {
      watch: () => () => undefined,
      request: async (request) => {
        calls.push(request);
        if (request.method !== 'background.open') return null;
        return {
          kind: 'background.page',
          viewGeneration: 1,
          storeId: 'store',
          readId: request.readId,
          observationId: 1,
          startIndex: 0,
          nextIndex: 2,
          total: 2,
          complete: true,
          entries: [old, current],
        };
      },
    };
    await render(bridge);
    await click(host, '打开后台总览');
    const oldCard = host.querySelector<HTMLElement>('[data-execution-id="job-1"]')!;
    expect(oldCard.textContent).toContain('原 Store original-store');
    expect(oldCard.textContent).toContain('恢复历史，只读');
    expect(oldCard.textContent).toContain('读取完整已保存输出');
    expect(
      [...oldCard.querySelectorAll('button')].some((button) =>
        button.textContent?.startsWith('停止后台执行'),
      ),
    ).toBe(false);
    expect(host.querySelector('[data-execution-id="job-2"]')!.textContent).toContain(
      '停止后台执行 · job-2',
    );
    expect(calls.some((request) => request.method === 'background.stop')).toBe(false);
  }));

test('reopening a complete child waits for the in-flight directory token and guards only Main admission, then directory polls resume before body EOF', async () => {
  const originalTimeout = globalThis.setTimeout;
  let poll!: () => void;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 1000) {
      poll = () => callback(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  try {
    await fixture(async (host, render) => {
      const item = backgroundItem(1, true),
        calls: NativeRequest[] = [];
      item.execution.status = 'succeeded';
      const body = Buffer.from(
        JSON.stringify({
          item,
          session: item.childSession,
          upperSeq: '1',
          messages: [
            {
              id: 'child-message',
              sessionId: item.childSession!.id,
              seq: '1',
              role: 'assistant',
              content: '完整重新读取🙂',
              runId: item.childRun!.id,
            },
          ],
          modelOutputs: [],
        }),
      );
      let observation = 0,
        childOpens = 0,
        bodyReads = 0;
      let releaseDirectory!: () => void, releaseAdmission!: () => void, releaseBody!: () => void;
      const directory = new Promise<void>((resolve) => {
        releaseDirectory = resolve;
      });
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const transmission = new Promise<void>((resolve) => {
        releaseBody = resolve;
      });
      const finished: (() => void)[] = [];
      const readsFinished = [0, 1].map(
        () => new Promise<void>((resolve) => finished.push(resolve)),
      );
      let closes = 0;
      const bridge: NativeBridge = {
        watch: () => () => {},
        request: async (request) => {
          calls.push(request);
          if (request.method === 'background.open') {
            const token = ++observation;
            if (token === 2) await directory;
            return {
              kind: 'background.page',
              viewGeneration: 1,
              storeId: 'store',
              readId: request.readId,
              observationId: token,
              startIndex: 0,
              nextIndex: 1,
              total: 1,
              complete: true,
              entries: [structuredClone(item)],
            };
          }
          if (request.method === 'background.child.open') {
            if (request.observationId !== observation)
              throw Error('background_observation_changed');
            if (++childOpens === 1) await admission;
            return {
              kind: 'background.child.opened',
              viewGeneration: 1,
              storeId: 'store',
              readId: request.readId,
              observationId: request.observationId,
              executionId: item.execution.id,
              childSessionId: item.childSession!.id,
              childRunId: item.childRun!.id,
              wireBytes: String(body.length),
              wireHash: createHash('sha256').update(body).digest('hex'),
            };
          }
          if (request.method === 'background.child.read') {
            if (++bodyReads === 1) await transmission;
            return {
              kind: 'background.child.chunk',
              readId: request.readId,
              offset: 0,
              nextOffset: body.length,
              eof: true,
              data: body.toString('base64'),
            };
          }
          if (request.method === 'background.child.close') finished[closes++]?.();
          return null;
        },
      };
      await render(bridge);
      await click(host, '打开后台总览');
      await act(async () => poll());
      expect(observation).toBe(2);
      await click(host, '读取完整子日志');
      expect(calls.filter((call) => call.method === 'background.child.open')).toHaveLength(0);
      await act(async () => releaseDirectory());
      expect(calls.find((call) => call.method === 'background.child.open')).toMatchObject({
        observationId: 2,
        executionId: item.execution.id,
      });
      await act(async () => poll());
      expect(observation).toBe(2);
      await act(async () => releaseAdmission());
      expect(bodyReads).toBe(1);
      await act(async () => poll());
      expect(observation).toBe(3);
      await act(async () => {
        releaseBody();
        await readsFinished[0];
      });
      expect(host.textContent).toContain('已完整读取子会话');
      expect(host.textContent).toContain('完整重新读取🙂');
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
      expect(calls.filter((call) => call.method === 'background.child.close')).toHaveLength(1);
      await click(host, '关闭子日志');
      expect(host.querySelectorAll('article > pre')).toHaveLength(0);
      await act(async () => {
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === '读取完整子日志')!
          .click();
        await readsFinished[1];
      });
      expect(
        calls.flatMap((call) =>
          call.method === 'background.child.open' ? [call.observationId] : [],
        ),
      ).toEqual([2, 3]);
      expect(host.textContent).toContain('完整重新读取🙂');
      expect(calls.filter((call) => call.method === 'background.child.close')).toHaveLength(2);
      expect(calls.some((call) => call.method === 'background.stop')).toBe(false);
    });
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});
