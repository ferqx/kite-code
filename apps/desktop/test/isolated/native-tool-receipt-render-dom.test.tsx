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

const sentinel = 'RAW_TOOL_RECEIPT_SENTINEL';
const original = JSON.stringify({
  path: sentinel,
  input: { path: sentinel },
  outcome: 'succeeded',
  nested: { preserved: true },
});
type Mode = 'known' | 'empty' | 'failed' | 'future' | 'future-unknown' | 'unsupported';
function fixture(mode: Mode) {
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
  const session = { ...backgroundItem().rootSession, nextSeq: '3' };
  let selected = 'root',
    revision = 1,
    published = false;
  const listeners = new Set<(event: NativeEvent) => void>();
  const requests: NativeRequest[] = [];
  const pending: (() => void)[] = [];
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: revision,
      viewSelection: 1,
      canReadModelOutput: false,
      session: {
        ...session,
        id: selected,
        rootSessionId: selected,
        nextSeq: selected === 'root' && !published ? '1' : session.nextSeq,
      },
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    },
  });
  const messages = (): Message[] =>
    selected !== 'root'
      ? [
          {
            id: 'other',
            sessionId: selected,
            seq: '1',
            role: 'assistant',
            status: 'complete',
            runId: null,
            content: 'Other session',
          },
        ]
      : [
          {
            id: 'model',
            sessionId: 'root',
            seq: '1',
            role: 'assistant',
            status: 'complete',
            runId: null,
            content: '',
            firstOutput: 'tool_calls',
            toolCalls: [
              {
                id: 'call',
                name: 'files.read',
                arguments: JSON.stringify({ path: 'MODEL_ARGS_SENTINEL' }),
              },
            ],
          },
          {
            id: 'receipt',
            sessionId: 'root',
            seq: '2',
            role: 'tool',
            status: 'complete',
            runId: null,
            sourceIds: ['execution'],
            toolCallId: 'call',
            content: original,
            ...(mode === 'unsupported' ? { contentFormat: 'unsupported' as const } : {}),
          },
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
        case 'select':
          selected = request.sessionId;
          revision++;
          return state();
        case 'directory':
          return {
            storeId: 'store',
            sessions: [
              session,
              { ...session, id: 'other', rootSessionId: 'other', title: 'Other session' },
            ],
            workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
          };
        case 'messages':
          if (!request.upperSeq) throw Error('fixture_requires_history_upper_bound');
          return {
            messages: selected === 'root' && !published ? [] : messages(),
            nextAfterSeq: null,
            highWaterSeq: request.upperSeq,
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
        case 'toolMessages.list':
        case 'fileTargets.list':
        case 'fileChanges.list': {
          const captured = selected;
          return new Promise<NativeResult>((resolve, reject) =>
            pending.push(() => {
              if (request.method === 'toolMessages.list' && mode === 'failed') {
                reject(Error('tool_metadata_unavailable'));
                return;
              }
              const entries =
                request.method === 'toolMessages.list' &&
                ['known', 'future', 'future-unknown'].includes(mode)
                  ? [
                      {
                        messageId: 'receipt',
                        executionId: 'execution',
                        definitionId: mode === 'known' ? 'files.read' : 'future.tool',
                        definitionVersion: mode === 'known' ? '4' : '99',
                        status:
                          mode === 'future-unknown'
                            ? ('outcome_unknown' as const)
                            : ('succeeded' as const),
                        resultRevision: '1',
                        target: 'README.md',
                      },
                    ]
                  : [];
              resolve({
                kind:
                  request.method === 'toolMessages.list'
                    ? 'toolMessages.page'
                    : request.method === 'fileTargets.list'
                      ? 'fileTargets.page'
                      : 'fileChanges.page',
                readId: request.readId,
                scope: {
                  generation: 1,
                  storeId: 'store',
                  sessionId: captured,
                  workspaceId: 'w',
                  viewSelection: request.viewSelection,
                  historyEpoch: request.historyEpoch,
                },
                entries,
              } as NativeResult);
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
    for (let attempt = 0; attempt < 60 && !ready(); attempt++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(ready()).toBe(true);
  };
  return {
    host,
    requests,
    render: async () => {
      await act(async () => root.render(<NativeDesktop />));
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === 'Original')
          ?.click();
      });
      // Establish the empty selected conversation before publishing an active
      // receipt. Initial historical recovery has its own presentation barrier;
      // this fixture exercises later receipts that must retain their reader.
      await until(
        () =>
          requests.some((request) => request.method === 'messages') &&
          !!host.querySelector('.conversation-viewport') &&
          !host.querySelector('.conversation-loading'),
      );
      await act(async () => {
        published = true;
        revision++;
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
      await until(() =>
        mode === 'unsupported'
          ? !!host.querySelector('.tool-activity-summary')
          : requests.some((request) => request.method === 'toolMessages.list'),
      );
    },
    flush: () =>
      act(async () => {
        for (const release of pending.splice(0)) release();
      }),
    toggle: () =>
      act(async () => {
        const button = host.querySelector<HTMLButtonElement>('.tool-activity-summary');
        expect(!!button).toBe(true);
        button!.click();
      }),
    selectOther: async () => {
      await act(async () => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent === 'Other session',
        );
        expect(!!button).toBe(true);
        button!.click();
      });
      await until(
        () =>
          !!host.querySelector('.conversation-viewport')?.textContent?.includes('Other session'),
      );
    },
    async close() {
      for (const release of pending.splice(0)) release();
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      restore();
      Object.assign(globalThis, prior);
    },
  };
}

test('actual NativeDesktop keeps a raw tool receipt hidden while metadata readers are held, then displays the known concise tool', async () => {
  const f = fixture('known');
  try {
    await f.render();
    expect(f.requests.some((request) => request.method === 'toolMessages.list')).toBe(true);
    expect(f.requests.some((request) => request.method === 'fileTargets.list')).toBe(true);
    expect(f.host.textContent).not.toContain(sentinel);
    expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
    expect(f.host.textContent).toContain('状态待核对');
    expect(f.host.textContent).not.toContain('结果未知');
    await f.flush();
    expect(f.host.textContent).toContain('读取');
    expect(f.host.textContent).toContain('README.md');
    expect(f.host.textContent).not.toContain(sentinel);
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain('结果未知');
    expect(f.host.querySelector('.tool-activity')?.getAttribute('aria-label')).toBe('读取 · 成功');
  } finally {
    await f.close();
  }
});

for (const mode of ['empty', 'failed', 'future', 'unsupported'] as const) {
  test(`actual NativeDesktop ${mode} metadata keeps original receipt available only after explicit expansion and scoped to its session`, async () => {
    const f = fixture(mode);
    try {
      await f.render();
      await f.flush();
      expect(f.host.textContent).not.toContain(sentinel);
      expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
      if (mode === 'future') expect(f.host.textContent).not.toContain('状态待核对');
      else expect(f.host.textContent).toContain('状态待核对');
      expect(f.host.textContent).not.toContain('结果未知');
      await f.toggle();
      expect(f.host.textContent).toContain(original);
      await f.toggle();
      expect(f.host.textContent).not.toContain(sentinel);
      await f.toggle();
      expect(f.host.textContent).toContain(sentinel);
      await f.selectOther();
      expect(f.host.textContent).toContain('Other session');
      expect(f.host.textContent).not.toContain(sentinel);
    } finally {
      await f.close();
    }
  });
}

test('actual NativeDesktop preserves a verified future tool outcome_unknown instead of the unverified metadata hint', async () => {
  const f = fixture('future-unknown');
  try {
    await f.render();
    expect(f.host.textContent).toContain('状态待核对');
    expect(f.host.textContent).not.toContain('结果未知');
    expect(f.host.textContent).not.toContain(sentinel);
    await f.flush();
    expect(f.host.textContent).toContain('future.tool · 99');
    expect(f.host.textContent).toContain('结果未知');
    expect(f.host.textContent).not.toContain('状态待核对');
  } finally {
    await f.close();
  }
});
