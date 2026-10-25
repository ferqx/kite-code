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
  const executionFacts = new Map<string, Execution>();
  const runs: Run[] = [backgroundItem().run!];
  const messages: Message[] = [];
  const listeners = new Set<(event: NativeEvent) => void>();
  const pending: (() => void)[] = [];
  const pendingHistory: (() => void)[] = [];
  let holdHistory = false;
  const requests: NativeRequest[] = [];
  let executionOwner: 'held' | 'unheld' | 'unknown' | undefined;
  let directoryUnavailable = false;
  let cachedDirectoryRun: Pick<Run, 'id' | 'status' | 'isActive'> | undefined;
  const session = () => ({ ...backgroundItem().rootSession, nextSeq: String(messages.length + 1) });
  const directory = () => ({
    unavailable: directoryUnavailable,
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
                  id: (cachedDirectoryRun ?? runs[0]!).id,
                  status: (cachedDirectoryRun ?? runs[0]!).status,
                  isActive: (cachedDirectoryRun ?? runs[0]!).isActive,
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
        case 'messages': {
          const page = {
            messages: structuredClone(messages),
            nextAfterSeq: null,
            highWaterSeq: request.upperSeq!,
          };
          if (holdHistory)
            return new Promise((resolve) => pendingHistory.push(() => resolve(page)));
          return page;
        }
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
                  const execution = executionFacts.get(receipt?.sourceIds?.[0] ?? '');
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
    async observeDirectoryUnavailable(unavailable: boolean) {
      directoryUnavailable = unavailable;
      cachedDirectoryRun = unavailable ? { ...runs[0]! } : undefined;
      await publish();
    },
    async observeRun(run: Run) {
      runs.splice(0, runs.length, run);
      await publish();
    },
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
      for (const item of items) executionFacts.set(item.id, item);
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
      for (const item of items) executionFacts.set(item.id, item);
      await publish();
    },
    async appendToolCallModel() {
      messages.push({
        id: 'tool-call-model',
        role: 'assistant',
        status: 'incomplete',
        sessionId: 'root',
        runId: 'parent-run',
        seq: String(messages.length + 1),
        sourceIds: ['tool-call-model-execution'],
        firstOutput: 'tool_calls',
        content: '',
      });
      await publish();
    },
    async finishToolCallModelAndStart(items: Execution[]) {
      const model = messages.find((message) => message.id === 'tool-call-model')!;
      model.status = 'complete';
      model.toolCalls = items.map((item) => ({
        id: item.toolCallId!,
        name: item.definitionId,
        arguments: JSON.stringify(item.toolInput ?? {}),
      }));
      holdHistory = true;
      executions = [...executions, ...items];
      for (const item of items) executionFacts.set(item.id, item);
      await publish();
      await until(() => pendingHistory.length > 0);
    },
    async releaseHistory() {
      holdHistory = false;
      await act(async () => {
        for (const release of pendingHistory.splice(0)) release();
      });
    },
    async settleWithoutReceipt(index: number) {
      const execution = executions.find((item) => item.id === `execution-${index}`)!;
      execution.status = 'succeeded';
      execution.resultRevision = '1';
      execution.result = { content: raw };
      await publish();
    },
    async complete(index: number, unknown = false, retainInView = true) {
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
      if (!retainInView) executions = executions.filter((item) => item !== execution);
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
        for (const release of pendingHistory.splice(0)) release();
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
    expect(f.host.textContent).toContain('读取文件');
    expect(f.host.textContent).not.toContain('已完成 3 项');
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

test('Native mixed tool activity keeps its first shell through receipt eviction and delayed metadata', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start([tool(1, { definitionId: 'shell.launch', definitionVersion: '1' })]);
    collapsed(f.host);
    const summary = f.host.querySelector('button.tool-activity-summary');
    await f.toggle();
    await f.start([
      tool(1, { definitionId: 'shell.launch', definitionVersion: '1' }),
      tool(2, { definitionId: 'files.write', definitionVersion: '2' }),
      tool(3, { definitionId: 'custom.remote', definitionVersion: '99' }),
    ]);
    expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
    expect(summary?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(3);
    // The bounded View can evict the original Execution before the independent
    // receipt metadata read returns. Aggregation must not depend on its label.
    for (const index of [3, 1, 2]) {
      await f.complete(index, false, false);
      expect(topActivities(f.host)).toHaveLength(1);
      expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
      expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(3);
      expect(f.host.textContent).not.toContain(raw);
      await f.flush();
      expect(topActivities(f.host)).toHaveLength(1);
      expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
      expect(summary?.getAttribute('aria-expanded')).toBe('true');
      expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(3);
      expect(f.host.textContent).not.toContain(raw);
    }
  } finally {
    await f.close();
  }
});

test('a tool-call-only Model remains inside one Native activity while its history completion trails the next View tool', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start([tool(1)]);
    await f.complete(1);
    await f.flush();
    collapsed(f.host);
    const summary = f.host.querySelector('button.tool-activity-summary');
    await f.appendToolCallModel();
    collapsed(f.host);
    expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
    expect(f.host.querySelectorAll('.model-output-message')).toHaveLength(0);
    await f.finishToolCallModelAndStart([tool(2, { status: 'running' })]);
    // The current View has admitted Tool B, while the independent history GET
    // still retains its source Model as an incomplete empty assistant message.
    collapsed(f.host);
    expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
    expect(summary?.textContent).toBe('读取文件');
    await f.releaseHistory();
    collapsed(f.host);
    expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
    await f.toggle();
    expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(2);
    await f.complete(2);
    await f.flush();
    expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
    expect(summary?.getAttribute('aria-expanded')).toBe('true');
    expect(summary?.textContent).not.toContain('执行中');
    expect(f.host.textContent).not.toContain(raw);
  } finally {
    await f.close();
  }
});

test.each([
  '3',
  '4',
])('Native search v%s and reads retain one exploration node through settling and delayed receipt facts', async (version) => {
  const f = fixture();
  try {
    await f.render();
    await f.start([
      tool(1, {
        definitionId: 'files.search',
        definitionVersion: version,
        toolInput: { path: 'src', text: 'needle' },
      }),
      tool(2),
    ]);
    collapsed(f.host);
    const summary = f.host.querySelector('button.tool-activity-summary');
    expect(summary?.textContent).toContain('搜索内容读取文件');
    expect(summary?.textContent).toBe('搜索内容读取文件');
    expect(f.host.textContent).not.toContain(`files.search · ${version}`);
    await f.toggle();
    expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(2);
    expect(f.host.textContent).toContain('搜索内容');
    for (const index of [1, 2]) {
      await f.settleWithoutReceipt(index);
      expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
      expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(2);
      await f.complete(index);
      expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
      expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(2);
      await f.flush();
      expect(f.host.querySelector('button.tool-activity-summary')).toBe(summary);
      expect(summary?.getAttribute('aria-expanded')).toBe('true');
      expect(topActivities(f.host)).toHaveLength(1);
      expect(f.host.textContent).not.toContain(raw);
    }
    expect(f.host.querySelectorAll('.response-status')).toHaveLength(1);
    expect(summary?.textContent).toContain('搜索内容读取文件');
    expect(summary?.textContent).not.toContain('已完成 2 项');
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
      expect(f.host.querySelectorAll('.tool-step-status')).toHaveLength(0);
      expect(f.host.textContent).not.toContain('执行状态待核实');
      expect(f.host.textContent).not.toContain('上次确认状态');
      expect(f.host.textContent).not.toContain('状态待核对');
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

test('Native directory read failure cannot revive unconfirmed activity and stale ownership cannot cover a terminal or new Run', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start();
    for (const owner of ['unheld', 'unknown', 'held'] as const) {
      await f.observeExecutionOwner(owner);
      await f.observeDirectoryUnavailable(true);
      expect(f.host.querySelectorAll('.response-status')).toHaveLength(0);
      expect(f.host.querySelectorAll('.tool-activity.is-running')).toHaveLength(0);
      expect(f.host.querySelectorAll('button[aria-label="停止任务"]')).toHaveLength(0);
      expect(f.host.textContent).not.toContain('执行状态待核实');
      expect(f.host.textContent).not.toContain('上次确认状态');
      expect(f.host.textContent).not.toContain('状态待核对');
      await f.observeDirectoryUnavailable(false);
    }
    expect(f.host.querySelectorAll('.response-status')).toHaveLength(1);
    expect(f.host.textContent).not.toContain('执行状态待核实');
    const original = f.facts().runs[0]!;
    await f.observeExecutionOwner('unheld');
    await f.observeDirectoryUnavailable(true);
    await f.observeRun({ ...original, isActive: false, status: 'interrupted' });
    expect(f.host.textContent).not.toContain('执行状态待核实');
    expect(f.host.querySelectorAll('.response-status')).toHaveLength(0);
    await f.observeRun({ ...original, id: 'new-run' });
    expect(f.host.textContent).not.toContain('执行状态待核实');
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

test('Native tools aggregate unknown definitions but retain Run and Store boundaries', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.start(
      [
        tool(1),
        tool(2),
        tool(5, { definitionId: 'files.search', definitionVersion: '99' }),
        tool(3, { runId: 'other-run' }),
        tool(4, { originStoreId: 'foreign-store' }),
      ],
      [{ ...backgroundItem().run!, id: 'other-run' }],
    );
    expect(topActivities(f.host)).toHaveLength(2);
    expect(f.host.textContent).not.toContain('foreign-store');
    expect(f.host.querySelectorAll('.tool-activity-steps')).toHaveLength(0);
    await f.toggle();
    expect(f.host.textContent).toContain('files.search · 99');
    expect(f.host.querySelector('.tool-activity-steps')?.children).toHaveLength(3);
    expect(f.host.querySelector('.tool-activity-steps')?.textContent).not.toContain(
      'file-execution-3.ts',
    );
    expect(f.host.querySelector('.tool-activity-steps')?.textContent).not.toContain(
      'file-execution-4.ts',
    );
    expect(f.host.querySelector('.tool-activity-steps')?.textContent).toContain('99');
    await f.toggle();
    await f.complete(5, true);
    await f.flush();
    expect(f.host.querySelector('button.tool-activity-summary')?.textContent).not.toContain(
      '结果未知',
    );
    await f.toggle();
    expect(f.host.querySelector('.tool-activity-steps')?.textContent).toContain('结果未知');
    expect(f.host.textContent).not.toContain(raw);
  } finally {
    await f.close();
  }
});
