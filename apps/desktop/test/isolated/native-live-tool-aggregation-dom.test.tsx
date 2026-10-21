import { expect, test } from 'bun:test';
import type { Execution, Message, Run } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const globals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, globals);
bootstrap.window.close();

const raw = 'PRIVATE_RAW_RECEIPT_SENTINEL';
function tool(index: number, overrides: Partial<Execution> = {}): Execution {
  return {
    id: `execution-${index}`,
    originStoreId: 'store',
    sessionId: 'root',
    kind: 'tool',
    runId: 'parent-run',
    definitionId: 'files.read',
    definitionVersion: '4',
    status: index === 1 ? 'running' : 'planned',
    toolCallId: `call-${index}`,
    toolInput: { path: `file-execution-${index}.ts` },
    result: null,
    resultRevision: '0',
    cancelRequestedAt: null,
    ...overrides,
  };
}

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let revision = 1;
  let executions: Execution[] = [];
  const runs: Run[] = [backgroundItem().run!];
  const messages: Message[] = [];
  const listeners = new Set<(event: NativeEvent) => void>();
  const pending: (() => void)[] = [];
  const requests: NativeRequest[] = [];
  let executionOwner: 'held' | 'unheld' | 'unknown' | undefined;
  const session = () => ({ ...backgroundItem().rootSession, nextSeq: String(messages.length + 1) });
  const directory = () => ({
    storeId: 'store',
    sessions: [
      {
        ...session(),
        ...(executionOwner
          ? {
              activity: {
                executionOwner,
                queued: false,
                pendingInteractions: 0,
                updatedAt: null,
                run: {
                  id: runs[0]!.id,
                  status: runs[0]!.status,
                  isActive: runs[0]!.isActive,
                  waitingForResults: false,
                },
              },
            }
          : {}),
      },
    ],
    workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
  });
  const state = (): NativeState => ({
    generation: 1,
    historyEpoch: 0,
    directory: directory(),
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: revision,
      viewSelection: 1,
      canReadModelOutput: false,
      session: session(),
      runs: structuredClone(runs),
      executions: structuredClone(executions),
      interactions: [],
      interactionsAfterId: null,
    },
  });
  const bridge: NativeBridge = {
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(request): Promise<NativeResult> {
      requests.push(request);
      const scope =
        'readId' in request && 'viewSelection' in request && 'historyEpoch' in request
          ? {
              generation: 1,
              storeId: 'store',
              sessionId: 'root',
              workspaceId: 'w',
              viewSelection: request.viewSelection,
              historyEpoch: request.historyEpoch,
            }
          : undefined;
      switch (request.method) {
        case 'attach':
        case 'state':
        case 'select':
          return state();
        case 'directory':
          return directory();
        case 'messages':
          return { messages: [...messages], nextAfterSeq: null, highWaterSeq: request.upperSeq! };
        case 'draft.read':
          return {
            id: 'root',
            storeId: 'store',
            workspaceId: 'w',
            rootSessionId: 'root',
            revision: 1,
            content: '',
          };
        case 'conversation.branch':
          return {
            kind: 'conversation.branch',
            storeId: 'store',
            workspaceId: 'w',
            repository: false,
            branches: [],
            label: '本地目录',
          };
        case 'conversation.models.read':
        case 'input.models.read':
          return {
            kind: 'settings.models',
            observationId: 1,
            scope: 'user',
            storeId: 'store',
            canWrite: false,
            defaultModelId: null,
            errors: [],
            models: [],
          };
        case 'toolMessages.runs':
          return {
            kind: 'toolMessages.runs',
            readId: request.readId,
            scope: scope!,
            runs: [...runs],
          };
        case 'toolMessages.list':
          return new Promise((resolve) =>
            pending.push(() =>
              resolve({
                kind: 'toolMessages.page',
                readId: request.readId,
                scope: scope!,
                entries: request.messageIds.flatMap((messageId) => {
                  const receipt = messages.find((message) => message.id === messageId);
                  const execution = executions.find((item) => item.id === receipt?.sourceIds?.[0]);
                  return execution
                    ? [
                        {
                          messageId,
                          executionId: execution.id,
                          definitionId: execution.definitionId,
                          definitionVersion: execution.definitionVersion,
                          status: execution.status,
                          resultRevision: execution.resultRevision,
                          target: `file-${execution.id}.ts`,
                        },
                      ]
                    : [];
                }),
              }),
            ),
          );
        case 'fileTargets.list':
        case 'fileChanges.list':
          return {
            kind: request.method === 'fileTargets.list' ? 'fileTargets.page' : 'fileChanges.page',
            readId: request.readId,
            scope: scope!,
            entries: [],
          };
        default:
          return null;
      }
    },
  };
  Object.assign(dom.window, { kiteNative: bridge });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 60 && !ready(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(ready()).toBe(true);
  };
  const publish = async () => {
    const previousReads = requests.filter((request) => request.method === 'state').length;
    await act(async () => {
      revision++;
      for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
    });
    await until(
      () => requests.filter((request) => request.method === 'state').length > previousReads,
    );
  };
  return {
    host,
    requests,
    facts: () => structuredClone({ runs, executions, messages }),
    async observeExecutionOwner(owner: NonNullable<typeof executionOwner>) {
      executionOwner = owner;
      await publish();
    },
    async render() {
      await act(async () => root.render(<NativeDesktop />));
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === 'Original')!
          .click();
      });
      await until(
        () =>
          !!host.querySelector('.conversation-viewport') &&
          !host.querySelector('.conversation-loading'),
      );
    },
    async start(items = [tool(1), tool(2), tool(3)], extraRuns: Run[] = []) {
      executions = items;
      runs.push(...extraRuns);
      await publish();
    },
    async appendStage(items: Execution[]) {
      messages.push({
        id: 'stage-prose',
        role: 'assistant',
        status: 'complete',
        sessionId: 'root',
        runId: 'parent-run',
        seq: String(messages.length + 1),
        content: '目录已了解，接着查看应用入口。',
      });
      executions = [...executions, ...items];
      await publish();
    },
    async settleWithoutReceipt(index: number) {
      const execution = executions.find((item) => item.id === `execution-${index}`)!;
      execution.status = 'succeeded';
      execution.resultRevision = '1';
      execution.result = { content: raw };
      await publish();
    },
    async complete(index: number, unknown = false) {
      const execution = executions.find((item) => item.id === `execution-${index}`)!;
      execution.status = unknown ? 'outcome_unknown' : 'succeeded';
      execution.resultRevision = '1';
      messages.push({
        id: `receipt-${index}`,
        role: 'tool',
        status: 'complete',
        sessionId: 'root',
        runId: execution.runId,
        seq: String(messages.length + 1),
        sourceIds: [execution.id],
        toolCallId: execution.toolCallId,
        content: JSON.stringify({ result: raw, execution: execution.id }),
      });
      await publish();
      await until(() => pending.length > 0);
    },
    async flush() {
      await act(async () => {
        for (const release of pending.splice(0)) release();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async toggle() {
      const button = host.querySelector<HTMLButtonElement>('button.tool-activity-summary');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
    },
    async close() {
      await act(async () => {
        for (const release of pending.splice(0)) release();
        root.unmount();
      });
      dom.window.close();
      restore();
      Object.assign(globalThis, prior);
    },
  };
}

function topActivities(host: HTMLElement) {
  return [...host.querySelectorAll('.conversation .tool-activity')].filter(
    (activity) => !activity.parentElement?.closest('.tool-activity'),
  );
}

function collapsed(host: HTMLElement) {
  expect(topActivities(host)).toHaveLength(1);
  expect(host.querySelector('button.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
    'false',
  );
  expect(host.querySelector('.tool-activity-steps')).toBeNull();
  expect(host.textContent).not.toContain(raw);
}

test('Native exploration starts as one collapsed activity and retains it across partial receipts and delayed facts', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start([tool(1), tool(2, { cancelRequestedAt: 1000 }), tool(3)]);
    collapsed(f.host);
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    await f.settleWithoutReceipt(1);
    collapsed(f.host);
    await f.complete(1);
    collapsed(f.host);
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    await f.flush();
    collapsed(f.host);
    await f.complete(2);
    collapsed(f.host);
    await f.flush();
    collapsed(f.host);
    await f.complete(3);
    collapsed(f.host);
    await f.flush();
    collapsed(f.host);
    expect(f.host.textContent).toContain('读取 3 次');
    // Each tool now has a complete receipt; the accurate parent Run is still active.
    expect(f.host.querySelectorAll('.response-status')).toHaveLength(1);
    const response = f.host.querySelector('.response-status')!;
    expect(response.textContent).toBe('正在回复…');
    expect(response.closest('.agent-turn')?.lastElementChild).toBe(response);
    expect(f.host.querySelectorAll('.message.assistant')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('Native owner reconciliation stops live tool activity while retaining confirmed receipts and original execution facts', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start([
      tool(1),
      tool(2, { cancelRequestedAt: 1000 }),
      tool(3),
      tool(4, { definitionId: 'task.events', definitionVersion: '1' }),
    ]);
    await f.complete(3);
    await f.flush();
    await f.observeExecutionOwner('held');
    await f.toggle();
    expect(f.host.querySelectorAll('.response-status')).toHaveLength(1);
    expect(f.host.textContent).toContain('等待执行');
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    const original = f.facts();
    for (const owner of ['unheld', 'unknown'] as const) {
      await f.observeExecutionOwner(owner);
      expect(f.host.querySelectorAll('.response-status')).toHaveLength(0);
      expect(f.host.querySelectorAll('button[aria-label="停止任务"]')).toHaveLength(0);
      expect(f.host.querySelectorAll('.tool-activity .shimmer')).toHaveLength(0);
      expect(f.host.querySelectorAll('.tool-activity [data-status="running"]')).toHaveLength(0);
      expect(f.host.querySelectorAll('.tool-activity [data-status="pending"]')).toHaveLength(0);
      expect(f.host.querySelectorAll('.tool-step-status')?.length).toBeGreaterThan(0);
      expect(f.host.textContent).toContain('执行状态待核实');
      expect(f.host.textContent).not.toContain('等待执行');
      expect(f.host.textContent).not.toContain('已请求停止，等待执行结果。');
      expect(f.host.querySelector('.tool-activity-step.completed') !== null).toBe(true);
      expect(f.facts()).toEqual(original);
    }
    await f.observeExecutionOwner('held');
    expect(f.host.querySelectorAll('.response-status')).toHaveLength(1);
    expect(f.host.textContent).toContain('等待执行');
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    expect(f.host.textContent).not.toContain('执行状态待核实');
    expect(f.facts()).toEqual(original);
    expect(
      f.requests.filter((request) => /submit|prepare|recover|cancel/.test(request.method)),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const order of [
  [1, 2, 3],
  [2, 1, 3],
]) {
  test(`Native manual aggregate expansion survives live to receipt handoff in completion order ${order.join(',')}`, async () => {
    const f = fixture();
    try {
      await f.render();
      await f.start();
      collapsed(f.host);
      await f.toggle();
      for (const index of order) {
        await f.settleWithoutReceipt(index);
        expect(topActivities(f.host)).toHaveLength(1);
        expect(
          f.host.querySelector('button.tool-activity-summary')?.getAttribute('aria-expanded'),
        ).toBe('true');
        expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(3);
        expect(f.host.textContent).not.toContain(raw);
        await f.complete(index);
        expect(topActivities(f.host)).toHaveLength(1);
        expect(
          f.host.querySelector('button.tool-activity-summary')?.getAttribute('aria-expanded'),
        ).toBe('true');
        expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(3);
        expect(f.host.textContent).not.toContain(raw);
        await f.flush();
        expect(
          f.host.querySelector('button.tool-activity-summary')?.getAttribute('aria-expanded'),
        ).toBe('true');
        expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(3);
      }
    } finally {
      await f.close();
    }
  });
}

test('Native readable stage prose separates exploration activities without sharing manual expansion', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start([tool(1), tool(2)]);
    await f.complete(1);
    await f.flush();
    await f.complete(2);
    await f.flush();
    collapsed(f.host);
    await f.toggle();
    const first = f.host.querySelector('button.tool-activity-summary');
    expect(first).not.toBeNull();
    expect(first?.getAttribute('aria-expanded')).toBe('true');
    await f.appendStage([tool(3, { status: 'running' }), tool(4)]);
    const summaries = f.host.querySelectorAll('button.tool-activity-summary');
    expect(topActivities(f.host)).toHaveLength(2);
    expect(summaries).toHaveLength(2);
    expect(summaries[0] ?? null).toBe(first);
    expect(summaries[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(summaries[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(f.host.querySelectorAll('.tool-activity-steps')).toHaveLength(1);
    expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(2);
    expect(f.host.textContent).toContain('目录已了解，接着查看应用入口。');
    expect(f.host.textContent).not.toContain(raw);
  } finally {
    await f.close();
  }
});

test('Native exploration does not aggregate another Run, foreign Store, or unknown definition version into the current activity', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start(
      [
        tool(1),
        tool(2),
        tool(3, { runId: 'other-run' }),
        tool(4, { originStoreId: 'foreign-store' }),
        tool(5, { definitionVersion: '99' }),
      ],
      [{ ...backgroundItem().run!, id: 'other-run' }],
    );
    expect(f.host.querySelectorAll('.conversation .tool-activity')).toHaveLength(3);
    expect(f.host.textContent).not.toContain('foreign-store');
    expect(f.host.textContent).toContain('files.read · 99');
    expect(f.host.querySelectorAll('.tool-activity-steps')).toHaveLength(0);
    await f.toggle();
    expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(2);
    expect(f.host.querySelector('.tool-activity-steps')?.textContent).not.toContain(
      'file-execution-3.ts',
    );
    expect(f.host.querySelector('.tool-activity-steps')?.textContent).not.toContain(
      'file-execution-4.ts',
    );
    expect(f.host.querySelector('.tool-activity-steps')?.textContent).not.toContain('99');
    await f.toggle();
    await f.complete(5, true);
    await f.flush();
    expect(f.host.textContent).toContain('结果未知');
    expect(f.host.textContent).not.toContain(raw);
  } finally {
    await f.close();
  }
});
