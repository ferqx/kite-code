import { expect, test } from 'bun:test';
import type { Execution, Run, SelectedContextPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeContextFacts,
  NativeRequest,
  NativeSelection,
} from '../src/native-bridge';
import { NativeContextView } from '../src/native-context';
import { NativeDiagnosticsProvider } from '../src/native-diagnostics';

test('Native Context DOM drops late old body, closes only original read and forwards the exact active Include scope', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
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
  const element = dom.window.document.getElementById('root')!,
    root = createRoot(element);
  const calls: NativeRequest[] = [];
  let finish!: (value: NativeContextFacts) => void;
  const waiting = new Promise<NativeContextFacts>((resolve) => {
    finish = resolve;
  });
  const facts = (sessionId: string, content: string): NativeContextFacts => ({
    observationId: 9,
    historicalResults: {
      startIndex: 0,
      nextIndex: null,
      total: 1,
      executions: selection(sessionId).executions,
    },
    page: {
      selection: {
        id: `selected-${sessionId}`,
        sessionId,
        previousSelectionId: null,
        boundaryMessageId: null,
        boundarySeq: '0',
        tailFromSeq: '0',
        ranges: [],
      },
      highWaterSeq: '0',
      snapshotCursor: '0',
      messages: [],
      resultSources: [
        {
          id: 'source',
          seq: '0',
          sessionId,
          createdSelectionId: `selected-${sessionId}`,
          executionId: 'job',
          resultRevision: '7',
          originStoreId: 'store',
          inclusion: 'explicit',
          result: { content },
        },
      ],
      nextAfterSeq: null,
      nextAfterSourceId: null,
    } as SelectedContextPage,
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(input);
      if (input.method === 'context.read')
        return input.sessionId === 'old' ? waiting : facts('new', 'CURRENT BODY');
      return null;
    },
  };
  const selection = (id: string): NativeSelection => ({
    viewGeneration: 1,
    viewSelection: id === 'old' ? 1 : 2,
    storeId: 'store',
    canReadContext: true,
    canReadModelOutput: false,
    session: { id, workspaceId: 'w', parentSessionId: null } as NativeSelection['session'],
    runs: [{ id: 'original-active', sessionId: id, isActive: true } as Run],
    executions: [
      {
        id: 'job',
        sessionId: id,
        originStoreId: 'store',
        kind: 'job',
        status: 'succeeded',
        delivery: 'suppressed',
        deliveryReason: 'context_rewound',
        resultRevision: '7',
        result: { content: 'HISTORICAL' },
        runId: 'old-run',
        definitionId: 'fixture.job',
        definitionVersion: '1',
        cancelRequestedAt: null,
      } as Execution,
    ],
    interactions: [],
    interactionsAfterId: null,
  });
  const render = (id: string) =>
    root.render(
      <NativeDiagnosticsProvider enabled>
        <NativeContextView
          bridge={bridge}
          generation={1}
          selection={selection(id)}
          onRefresh={async () => {}}
        />
      </NativeDiagnosticsProvider>,
    );
  const button = (text: string) =>
    [...element.querySelectorAll('button')].find((value) => value.textContent === text)!;
  try {
    await act(async () => render('old'));
    await act(async () => button('读取当前所选上下文').click());
    const original = calls.find((value) => value.method === 'context.read') as NativeRequest & {
      readId: string;
    };
    await act(async () => render('new'));
    expect(calls).toContainEqual({
      method: 'context.close',
      generation: 1,
      readId: original.readId,
    });
    await act(async () => {
      finish(facts('old', 'LATE ORIGINAL BODY'));
    });
    expect(element.textContent).not.toContain('LATE ORIGINAL BODY');
    await act(async () => button('读取当前所选上下文').click());
    expect(element.textContent).toContain('CURRENT BODY');
    await act(async () => button('Include this exact historical result').click());
    expect(calls.find((value) => value.method === 'context.include')).toEqual({
      method: 'context.include',
      generation: 1,
      observationId: 9,
      executionId: 'job',
      resultRevision: '7',
      scope: {
        storeId: 'store',
        sessionId: 'new',
        contextSelectionId: 'selected-new',
        targetRunId: 'original-active',
      },
    });
    expect(calls.some((value) => value.method === 'cancelInput')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});

test('restored same-Session compression exposes its exact Model input shortcut without reading or mutating, while another Session preserves only the card', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
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
  const element = dom.window.document.getElementById('root')!,
    root = createRoot(element),
    calls: NativeRequest[] = [],
    inspected: string[] = [];
  let refreshed = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(input);
      if (input.method !== 'context.read') return null;
      const sessionId = input.sessionId;
      return {
        observationId: 11,
        historicalResults: { startIndex: 0, nextIndex: null, total: 0, executions: [] },
        page: {
          selection: {
            id: `selection-${sessionId}`,
            sessionId,
            previousSelectionId: null,
            boundaryMessageId: null,
            boundarySeq: '0',
            tailFromSeq: '0',
            ranges: [],
          },
          highWaterSeq: '9',
          snapshotCursor: '12',
          messages: [],
          resultSources: [],
          nextAfterSeq: null,
          nextAfterSourceId: null,
          compression: {
            id: 'original-compression',
            originSessionId: 'same-session',
            originCompressionId: 'original-compression',
            sessionId,
            contextSelectionId: `selection-${sessionId}`,
            originStoreId: 'store-A',
            modelExecutionId: 'original-compression-model',
            runId: 'original-compression-run',
            coveredThroughSeq: '7',
            publishedSeq: '9',
            previousCompressionId: null,
            compressor: { id: 'fixture.compressor', version: '1', snapshot: {} },
            trigger: 'manual',
          },
        },
      } satisfies NativeContextFacts;
    },
  };
  const render = (sessionId: string) => {
    const selection: NativeSelection = {
      viewGeneration: 1,
      viewSelection: sessionId === 'same-session' ? 1 : 2,
      storeId: 'store-B',
      canReadModelOutput: false,
      canReadContext: true,
      session: {
        id: sessionId,
        workspaceId: 'w',
        parentSessionId: null,
      } as NativeSelection['session'],
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    };
    root.render(
      <NativeDiagnosticsProvider enabled>
        <NativeContextView
          bridge={bridge}
          generation={1}
          selection={selection}
          onInspectModel={(executionId) => inspected.push(executionId)}
          onRefresh={async () => {
            refreshed++;
          }}
        />
      </NativeDiagnosticsProvider>,
    );
  };
  const button = (text: string) =>
    [...element.querySelectorAll('button')].find((value) => value.textContent === text);
  try {
    await act(async () => render('same-session'));
    await act(async () => button('读取当前所选上下文')!.click());
    expect(element.textContent).toContain('原存储 store-A');
    expect(button('查看此压缩的原模型输入')).toBeDefined();
    expect(inspected).toEqual([]);
    const originalCalls = [...calls];
    await act(async () => button('查看此压缩的原模型输入')!.click());
    expect(inspected).toEqual(['original-compression-model']);
    expect(calls).toEqual(originalCalls);
    expect(refreshed).toBe(0);
    await act(async () => render('other-session'));
    await act(async () => button('读取当前所选上下文')!.click());
    expect(element.textContent).toContain('活动压缩记录 original-compression');
    expect(element.textContent).toContain('原会话 same-session');
    expect(button('查看此压缩的原模型输入')).toBeUndefined();
    expect(inspected).toEqual(['original-compression-model']);
    expect(calls.every((input) => ['context.read', 'context.close'].includes(input.method))).toBe(
      true,
    );
    expect(refreshed).toBe(0);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});

test('Native Context next history button preserves its Context page and retires a late window on Session switch', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
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
  const element = dom.window.document.getElementById('root')!,
    root = createRoot(element);
  const calls: NativeRequest[] = [];
  const execution = (id: string, content: string) =>
    ({
      id,
      sessionId: 's',
      originStoreId: 'store',
      kind: 'job',
      status: 'succeeded',
      delivery: 'suppressed',
      deliveryReason: 'context_rewound',
      resultRevision: '1',
      result: { outcome: 'succeeded', content },
      runId: null,
      definitionId: 'fixture.job',
      definitionVersion: '1',
      cancelRequestedAt: null,
    }) as Execution;
  const context: SelectedContextPage = {
    selection: {
      id: 'selected-s',
      sessionId: 's',
      previousSelectionId: null,
      boundaryMessageId: null,
      boundarySeq: '0',
      tailFromSeq: '0',
      ranges: [],
    },
    highWaterSeq: '0',
    snapshotCursor: '0',
    messages: [],
    resultSources: [
      {
        id: 'original-source',
        seq: '0',
        sessionId: 's',
        createdSelectionId: 'selected-s',
        executionId: 'source-job',
        resultRevision: '1',
        originStoreId: 'store',
        inclusion: 'explicit',
        result: { content: 'PINNED CONTEXT BODY' },
      },
    ],
    nextAfterSeq: null,
    nextAfterSourceId: null,
  };
  let nextCalls = 0;
  let finish!: (value: import('../src/native-bridge').NativeContextResultFacts) => void;
  const waiting = new Promise<import('../src/native-bridge').NativeContextResultFacts>(
    (resolve) => {
      finish = resolve;
    },
  );
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(input);
      if (input.method === 'context.read')
        return {
          observationId: 17,
          page: context,
          historicalResults: {
            startIndex: 0,
            nextIndex: 1,
            total: 3,
            executions: [execution('first', 'FIRST HISTORY BODY')],
          },
        };
      if (input.method === 'context.results.next') {
        if (++nextCalls === 2) return waiting;
        return {
          observationId: 17,
          historicalResults: {
            startIndex: 1,
            nextIndex: 2,
            total: 3,
            executions: [execution('second', 'SECOND HISTORY BODY')],
          },
        };
      }
      return null;
    },
  };
  const selection = (sessionId: string): NativeSelection => ({
    viewGeneration: 1,
    viewSelection: sessionId === 's' ? 1 : 2,
    storeId: 'store',
    canReadContext: true,
    canReadModelOutput: false,
    session: {
      id: sessionId,
      workspaceId: 'w',
      parentSessionId: null,
    } as NativeSelection['session'],
    runs: [],
    executions: [],
    interactions: [],
    interactionsAfterId: null,
  });
  const render = (sessionId: string) =>
    root.render(
      <NativeDiagnosticsProvider enabled>
        <NativeContextView
          bridge={bridge}
          generation={1}
          selection={selection(sessionId)}
          onRefresh={async () => {}}
        />
      </NativeDiagnosticsProvider>,
    );
  const button = (text: string) =>
    [...element.querySelectorAll('button')].find((value) => value.textContent === text)!;
  try {
    await act(async () => render('s'));
    await act(async () => button('读取当前所选上下文').click());
    expect(element.textContent).toContain('PINNED CONTEXT BODY');
    expect(element.textContent).toContain('FIRST HISTORY BODY');
    await act(async () => button('读取下一页历史任务结果').click());
    expect(calls.find((call) => call.method === 'context.results.next')).toEqual({
      method: 'context.results.next',
      generation: 1,
      observationId: 17,
    });
    expect(element.textContent).toContain('SECOND HISTORY BODY');
    expect(element.textContent).toContain('PINNED CONTEXT BODY');
    await act(async () => button('读取下一页历史任务结果').click());
    await act(async () => render('other'));
    await act(async () =>
      finish({
        observationId: 17,
        historicalResults: {
          startIndex: 2,
          nextIndex: null,
          total: 3,
          executions: [execution('late', 'LATE HISTORY BODY')],
        },
      }),
    );
    expect(element.textContent).not.toContain('LATE HISTORY BODY');
    expect(calls.filter((call) => call.method === 'context.results.next')).toHaveLength(2);
    expect(
      calls.every((call) =>
        ['context.read', 'context.results.next', 'context.close'].includes(call.method),
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
