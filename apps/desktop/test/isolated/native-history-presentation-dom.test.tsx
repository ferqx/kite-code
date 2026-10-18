import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
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

const final = '项目包含 Core、Desktop 与共享 UI。';
const summary = 'PRIVATE_COMPRESSION_SUMMARY';
const raw = 'ORIGINAL_TOOL_RECEIPT';
type Reader = 'runs' | 'tools';
function fixture(failTools = false, failRuns = false) {
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
  const session = { ...backgroundItem().rootSession, nextSeq: '6' };
  let selected = 'root',
    revision = 1,
    historyEpoch = 0,
    holdSelection = false;
  let releaseSelection: (() => void) | undefined;
  const requests: NativeRequest[] = [];
  const pending: Record<Reader, (() => void)[]> = { runs: [], tools: [] };
  const listeners = new Set<(event: NativeEvent) => void>();
  const state = (): NativeState => ({
    generation: 1,
    historyEpoch,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: revision,
      viewSelection: revision,
      canReadModelOutput: false,
      session: {
        ...session,
        id: selected,
        rootSessionId: selected,
        nextSeq: selected === 'root' ? '6' : '2',
      },
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    },
  });
  const message = (id: string, role: Message['role'], seq: string, content: string): Message => ({
    id,
    role,
    seq,
    content,
    status: 'complete',
    runId: 'old-run',
    sessionId: 'root',
  });
  const messages: Message[] = [
    message('user', 'user', '1', '了解当前项目'),
    {
      ...message('compression', 'assistant', '2', summary),
      sourceIds: ['compression-model'],
      compression: { id: 'compression', trigger: 'automatic', status: 'completed' },
    },
    ...[1, 2].map((number) => ({
      ...message(
        `tool-${number}`,
        'tool',
        String(number + 2),
        JSON.stringify({ path: `file-${number}.ts`, content: raw }),
      ),
      sourceIds: [`execution-${number}`],
    })),
    message('final', 'assistant', '5', final),
  ];
  const bridge: NativeBridge = {
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(request): Promise<NativeResult> {
      requests.push(request);
      switch (request.method) {
        case 'attach':
        case 'state':
          return state();
        case 'select': {
          selected = request.sessionId;
          revision++;
          if (holdSelection) {
            holdSelection = false;
            const value = state();
            return new Promise((resolve) => {
              releaseSelection = () => resolve(value);
            });
          }
          return state();
        }
        case 'directory':
          return {
            storeId: 'store',
            sessions: [
              session,
              {
                ...session,
                id: 'other',
                rootSessionId: 'other',
                title: 'Other session',
                nextSeq: '2',
              },
            ],
            workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
          };
        case 'messages':
          return {
            messages:
              selected === 'root'
                ? messages
                : [
                    {
                      ...message('other-message', 'assistant', '1', 'Other ready'),
                      sessionId: 'other',
                      runId: null,
                    },
                  ],
            nextAfterSeq: null,
            highWaterSeq: request.upperSeq!,
          };
        case 'draft.read':
          return {
            id: selected,
            storeId: 'store',
            workspaceId: 'w',
            rootSessionId: selected,
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
        case 'fileTargets.list':
        case 'fileChanges.list':
          return {
            kind: request.method === 'fileTargets.list' ? 'fileTargets.page' : 'fileChanges.page',
            readId: request.readId,
            scope: {
              generation: 1,
              storeId: 'store',
              sessionId: selected,
              workspaceId: 'w',
              viewSelection: request.viewSelection,
              historyEpoch: request.historyEpoch,
            },
            entries: [],
          };
        case 'toolMessages.runs':
        case 'toolMessages.list': {
          const captured = selected,
            reader = request.method === 'toolMessages.runs' ? 'runs' : 'tools';
          return new Promise<NativeResult>((resolve, reject) =>
            pending[reader].push(() => {
              if ((reader === 'tools' && failTools) || (reader === 'runs' && failRuns)) {
                reject(Error('history_tool_metadata_unavailable'));
                return;
              }
              const scope = {
                generation: 1,
                storeId: 'store',
                sessionId: captured,
                workspaceId: 'w',
                viewSelection: request.viewSelection,
                historyEpoch: request.historyEpoch,
              };
              resolve(
                reader === 'runs'
                  ? {
                      kind: 'toolMessages.runs',
                      readId: request.readId,
                      scope,
                      runs: [
                        {
                          id: 'old-run',
                          originStoreId: 'store',
                          sessionId: captured,
                          status: 'completed',
                          isActive: false,
                          createdAt: 1000,
                          finishedAt: 3000,
                          reason: null,
                        },
                      ],
                    }
                  : {
                      kind: 'toolMessages.page',
                      readId: request.readId,
                      scope,
                      entries: [1, 2].map((number) => ({
                        messageId: `tool-${number}`,
                        executionId: `execution-${number}`,
                        definitionId: 'files.read',
                        definitionVersion: '4',
                        status: 'succeeded' as const,
                        resultRevision: '1',
                        target: `file-${number}.ts`,
                      })),
                    },
              );
            }),
          );
        }
        default:
          return null;
      }
    },
  };
  Object.assign(dom.window, { kiteNative: bridge });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 80 && !ready(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(ready()).toBe(true);
  };
  const release = (reader: Reader) =>
    act(async () => {
      for (const resolve of pending[reader].splice(0)) resolve();
    });
  return {
    host,
    requests,
    until,
    release,
    async select(title: string) {
      await act(async () => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent === title,
        );
        expect(button).toBeDefined();
        button!.click();
      });
    },
    pending: (reader: Reader) => pending[reader].length,
    holdNextSelection() {
      holdSelection = true;
    },
    releaseSelection: () => act(async () => releaseSelection?.()),
    async recalibrateHistory() {
      await act(async () => {
        historyEpoch++;
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
      await until(() => pending.runs.length > 0 && pending.tools.length > 0);
    },
    async render() {
      await act(async () => root.render(<NativeDesktop />));
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === 'Original')
          ?.click();
      });
      await until(() => pending.runs.length > 0 && pending.tools.length > 0);
    },
    async close() {
      await act(async () => root.unmount());
      releaseSelection?.();
      for (const reader of ['runs', 'tools'] as const)
        for (const resolve of pending[reader].splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      restore();
      Object.assign(globalThis, prior);
    },
  };
}

function expectLoading(host: HTMLElement) {
  expect(host.querySelector('.conversation-loading')).not.toBeNull();
  expect(host.querySelector('.context-compacted')).toBeNull();
  expect(host.querySelector('.tool-activity')).toBeNull();
  expect(host.textContent).not.toContain('状态待核对');
  expect(host.textContent).not.toContain(final);
  expect(host.textContent).not.toContain(summary);
  expect(host.textContent).not.toContain(raw);
}

for (const first of ['runs', 'tools'] as const) {
  test(`historical Native transcript waits for both readers with ${first} facts arriving first, then mounts the completed collapsed Turn once`, async () => {
    const f = fixture();
    try {
      await f.render();
      expectLoading(f.host);
      await f.release(first);
      expectLoading(f.host);
      await f.release(first === 'runs' ? 'tools' : 'runs');
      await f.until(() => !!f.host.querySelector('[data-turn-status="completed"]'));
      expect(f.host.querySelector('.conversation-loading')).toBeNull();
      expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(1);
      expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(f.host.textContent).toContain(final);
      expect(f.host.querySelector('.context-compacted')).toBeNull();
      expect(f.host.textContent).not.toContain('状态待核对');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click(),
      );
      expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
      expect(f.host.querySelectorAll('.tool-activity-summary')).toHaveLength(1);
      expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(f.host.querySelector('.tool-activity')?.textContent).toContain('读取');
      expect(f.host.querySelector('.tool-activity')?.textContent).toContain('2');
      expect(f.host.textContent).not.toContain(summary);
      expect(f.host.textContent).not.toContain(raw);
    } finally {
      await f.close();
    }
  });
}

test('a failed historical tool check finishes initial loading and preserves explicit original receipt access and retry', async () => {
  const f = fixture(true);
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.textContent?.includes('重新核对工具状态'));
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.textContent).toContain('部分工具状态尚无法核实');
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
    expect(f.host.textContent).not.toContain(raw);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!.click(),
    );
    expect(f.host.textContent).toContain(raw);
    const reads = f.requests.filter((request) => request.method === 'toolMessages.list').length;
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '重新核对工具状态')!
        .click(),
    );
    await f.until(
      () => f.requests.filter((request) => request.method === 'toolMessages.list').length > reads,
    );
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    await f.release('tools');
  } finally {
    await f.close();
  }
});

test('a failed historical Run check releases the initial loading boundary and retains compression, original messages and retry', async () => {
  const f = fixture(false, true);
  try {
    await f.render();
    await f.release('tools');
    expectLoading(f.host);
    await f.release('runs');
    await f.until(() => !!f.host.textContent?.includes('重新核对本轮状态'));
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
    expect(f.host.textContent).toContain('无法核对本轮状态，已保留原消息');
    expect(f.host.textContent).not.toContain(summary);
    expect(f.host.textContent).not.toContain(raw);
    const reads = f.requests.filter((request) => request.method === 'toolMessages.runs').length;
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '重新核对本轮状态')!
        .click(),
    );
    await f.until(
      () => f.requests.filter((request) => request.method === 'toolMessages.runs').length > reads,
    );
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    await f.release('runs');
  } finally {
    await f.close();
  }
});

test('reentering cached history waits for fresh ownership and tool checks while preserving explicit process and aggregate reading state', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!.click(),
    );
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    await f.select('Other session');
    await f.until(
      () => !!f.host.querySelector('.conversation-viewport')?.textContent?.includes('Other ready'),
    );
    await f.select('Original');
    await f.until(() => f.pending('runs') > 0 && f.pending('tools') > 0);
    expectLoading(f.host);
    await f.release('tools');
    expectLoading(f.host);
    await f.release('runs');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain(summary);
    expect(f.host.textContent).not.toContain(raw);
    expect(f.host.textContent).toContain(final);
  } finally {
    await f.close();
  }
});

test('same-session history epoch recalibration keeps admitted readable content visible while fresh metadata is held', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    expect(f.host.textContent).toContain(final);
    await f.recalibrateHistory();
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    await f.release('tools');
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    await f.release('runs');
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  } finally {
    await f.close();
  }
});

test('repeatedly opening the current conversation preserves its nodes and reading state without selecting or reading again', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!.click(),
    );
    const viewport = f.host.querySelector<HTMLElement>('.conversation-viewport')!,
      reply = f.host.querySelector('.message.assistant[data-final-reply="true"]'),
      compression = f.host.querySelector('.context-compacted'),
      input = f.host.querySelector('textarea');
    viewport.scrollTop = 23;
    const requests = f.requests.length;
    for (let index = 0; index < 3; index++) await f.select('Original');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.session-row[aria-current="page"]')!.dispatchEvent(
        new f.host.ownerDocument.defaultView!.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
        }),
      ),
    );
    expect(f.requests.slice(requests)).toEqual([]);
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.querySelector('.conversation-viewport')).toBe(viewport);
    expect(f.host.querySelector('.message.assistant[data-final-reply="true"]')).toBe(reply);
    expect(f.host.querySelector('.context-compacted')).toBe(compression);
    expect(f.host.querySelector('textarea')).toBe(input);
    expect(viewport.scrollTop).toBe(23);
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  } finally {
    await f.close();
  }
});

test('reopening the same history while metadata loads does not restart its pending readers', async () => {
  const f = fixture();
  try {
    await f.render();
    const requests = f.requests.length;
    await f.select('Original');
    await f.select('Original');
    expect(f.requests.slice(requests)).toEqual([]);
    expect(f.pending('runs')).toBe(1);
    expect(f.pending('tools')).toBe(1);
    expectLoading(f.host);
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    expect(f.host.textContent).toContain(final);
  } finally {
    await f.close();
  }
});

test('repeatedly selecting an in-flight target reuses the original selection request', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    f.holdNextSelection();
    await f.select('Other session');
    const requests = f.requests.filter((request) => request.method === 'select').length;
    await f.select('Other session');
    await f.select('Other session');
    expect(f.requests.filter((request) => request.method === 'select')).toHaveLength(requests);
    await f.releaseSelection();
    await f.until(
      () => !!f.host.querySelector('.conversation-viewport')?.textContent?.includes('Other ready'),
    );
  } finally {
    await f.close();
  }
});
