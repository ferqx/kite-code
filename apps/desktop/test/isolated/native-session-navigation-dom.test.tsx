import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import type { NativeBackgroundChild } from '../../src/background-bridge';
import type {
  NativeBridge,
  NativeDirectory,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
import { useNativeEnvironment, waitForNativeDirectory } from '../../src/native-environment';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom, promptValue, setPromptText } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const initialGlobals = {
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
Object.assign(globalThis, initialGlobals);
bootstrap.window.close();

function fixture(activeParent = false, pendingToolMetadata = false) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayout = prepareDesktopDom(dom);
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
  const item = backgroundItem(1, true);
  item.rootSession.nextSeq = pendingToolMetadata ? '3' : '1';
  item.childSession!.title = 'Live child';
  item.childSession!.nextSeq = '1';
  const parentMessage: Message = {
    id: 'parent-message',
    sessionId: 'root',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    runId: null,
    content: 'Parent transcript',
  };
  const parentHistory: Message[] = pendingToolMetadata
    ? [
        { ...parentMessage, role: 'user', content: 'Original parent delegation request' },
        { ...parentMessage, id: 'parent-explanation', seq: '2' },
        {
          id: 'parent-spawn-receipt',
          sessionId: 'root',
          runId: item.run!.id,
          seq: '3',
          role: 'tool',
          status: 'complete',
          sourceIds: ['parent-spawn-tool'],
          content: 'Original accepted child receipt',
        },
      ]
    : [parentMessage];
  const metadataReleases = new Set<() => void>();
  let metadataPending = pendingToolMetadata;
  let childBody:
    | Pick<NativeBackgroundChild, 'messages' | 'modelOutputs' | 'presentation' | 'upperSeq'>
    | undefined;
  const copied: string[] = [];
  let childText = 'Child prefix',
    revision = 1,
    holdNext = false,
    holdParent = false,
    failParent = false,
    backgroundUnavailable = false,
    viewLoading = false,
    permissionUnavailable = false;
  let directoryObservation: NativeDirectory | undefined;
  let requiredParent = false;
  let holdDirectory = false;
  let releaseDirectory: (() => void) | undefined;
  let executions: NonNullable<NativeState['selection']>['executions'] = [];
  let releaseHeld: (() => void) | undefined;
  let selectedEnvironmentRevision: number | undefined;
  let environmentReadUnavailable: boolean | undefined;
  let heldReadId: string | undefined;
  let releaseParent: (() => void) | undefined;
  const bytes = new Map<string, Buffer>();
  const requests: NativeRequest[] = [];
  const listeners = new Set<(event: NativeEvent) => void>();
  const state = (): NativeState => ({
    generation: 1,
    backgroundUnavailable,
    environmentRevision: revision,
    selectedEnvironmentRevision,
    environmentReadUnavailable,
    ...(directoryObservation ? { directory: directoryObservation } : {}),
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: revision,
      viewSelection: 1,
      canReadModelOutput: false,
      session: item.rootSession,
      viewLoading,
      permissionUnavailable,
      ...(activeParent && !viewLoading && !permissionUnavailable
        ? {
            permissions: {
              observationId: 1,
              mode: {
                storeId: 'store',
                sessionId: 'root',
                scopeSessionId: 'root',
                mode: 'auto' as const,
                revision: '1',
                defaultMode: 'auto' as const,
                defaultRevision: '1',
              },
              trust: {
                storeId: 'store',
                workspaceId: 'w',
                status: 'trusted' as const,
                trusted: true,
                revision: '1',
                canonicalIdentity: 'a'.repeat(64),
                externalReadScopeDigest: 'b'.repeat(64),
                readScopes: [{ kind: 'workspace' as const, description: 'Workspace' }],
              },
            },
          }
        : {}),
      runs: activeParent ? [item.run!] : [],
      executions: requiredParent ? [{ ...item.execution, result: null }] : executions,
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
      switch (request.method) {
        case 'attach':
        case 'state':
        case 'select':
          return state();
        case 'directory':
          return (
            directoryObservation ?? {
              storeId: 'store',
              sessions: [item.rootSession],
              workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
            }
          );
        case 'messages': {
          if (failParent) {
            throw Error('history_read_failed');
          }
          const result = {
            messages: parentHistory.map((message) => ({ ...message })),
            nextAfterSeq: null,
            highWaterSeq: item.rootSession.nextSeq,
          };
          if (holdParent) {
            holdParent = false;
            return new Promise<NativeResult>((resolve) => {
              releaseParent = () => resolve(result);
            });
          }
          return result;
        }
        case 'toolMessages.list': {
          const result = {
            kind: 'toolMessages.page' as const,
            readId: request.readId,
            scope: {
              generation: request.generation,
              viewSelection: request.viewSelection,
              historyEpoch: request.historyEpoch,
              storeId: 'store',
              sessionId: 'root',
              workspaceId: 'w',
            },
            entries: request.messageIds.map((messageId) => ({
              messageId,
              executionId: 'parent-spawn-tool',
              definitionId: 'task.spawn',
              definitionVersion: '1',
              status: 'succeeded' as const,
              resultRevision: '1',
            })),
          };
          if (!metadataPending) return result;
          return new Promise<NativeResult>((resolve) => {
            metadataReleases.add(() => resolve(result));
          });
        }
        case 'draft.read':
          return {
            id: 'root',
            storeId: 'store',
            workspaceId: 'w',
            rootSessionId: 'root',
            revision: 1,
            content: 'Original private draft',
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
            errors: [],
            defaultModelId: 'model',
            models: [
              {
                id: 'model',
                provider: 'compatible',
                model: 'Model',
                enabled: true,
                configured: true,
                diagnostics: [],
                reasoningEffortChoices: [],
              },
            ],
          };
        case 'background.open': {
          const page = {
            kind: 'background.page' as const,
            viewGeneration: 1,
            viewSelection: 1,
            rootSessionId: 'root',
            storeId: 'store',
            readId: request.readId,
            observationId: revision,
            startIndex: 0,
            nextIndex: 1,
            total: 1,
            complete: true,
            entries: [structuredClone(item)],
          };
          if (holdDirectory) {
            holdDirectory = false;
            return new Promise<NativeResult>((resolve) => {
              releaseDirectory = () => resolve(page);
            });
          }
          return page;
        }
        case 'background.child.open': {
          const body = Buffer.from(
            JSON.stringify({
              item,
              session: item.childSession,
              upperSeq: '1',
              ...(request.cursor ? { afterSeq: '0' } : {}),
              messages: [
                {
                  id: 'child-message',
                  sessionId: 'child',
                  seq: '1',
                  role: 'assistant',
                  status: 'incomplete',
                  runId: item.childRun!.id,
                  content: childText,
                },
              ],
              modelOutputs: [],
              ...childBody,
            }),
          );
          bytes.set(request.readId, body);
          return {
            kind: 'background.child.opened',
            viewGeneration: 1,
            viewSelection: 1,
            rootSessionId: 'root',
            storeId: 'store',
            readId: request.readId,
            observationId: request.observationId,
            executionId: item.execution.id,
            childSessionId: 'child',
            childRunId: item.childRun!.id,
            wireBytes: String(body.length),
            wireHash: createHash('sha256').update(body).digest('hex'),
          };
        }
        case 'background.child.read': {
          const body = bytes.get(request.readId)!;
          const result = {
            kind: 'background.child.chunk' as const,
            readId: request.readId,
            offset: request.offset,
            nextOffset: body.length,
            eof: true,
            data: body.subarray(request.offset).toString('base64'),
          };
          if (holdNext) {
            holdNext = false;
            heldReadId = request.readId;
            return new Promise<NativeResult>((resolve) => {
              releaseHeld = () => resolve(result);
            });
          }
          return result;
        }
        case 'background.child.close':
          bytes.delete(request.readId);
          return null;
        default:
          return null;
      }
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', {
    value: {
      ...bridge,
      writeClipboardText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  // WebCrypto completes on a later event-loop turn; wait for the actual committed text.
  const waitForText = async (text: string) => {
    for (let attempt = 0; attempt < 50 && !host.textContent?.includes(text); attempt++)
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
  };
  const click = (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === label || button.getAttribute('aria-label') === label,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  return {
    host,
    copied,
    childBody: (body: NonNullable<typeof childBody>) => {
      childBody = body;
      item.childSession!.nextSeq = body.upperSeq;
    },
    waitForText,
    requests,
    listeners,
    click,
    observedRun: () => structuredClone(item.run),
    observeExecutionOwner: async (
      executionOwner: 'held' | 'unheld' | 'unknown',
      unavailable = false,
    ) => {
      directoryObservation = {
        storeId: 'store',
        unavailable,
        sessions: [
          {
            ...item.rootSession,
            activity: {
              executionOwner,
              queued: false,
              pendingInteractions: 0,
              updatedAt: null,
              run: {
                id: item.run!.id,
                status: item.run!.status,
                isActive: item.run!.isActive,
                waitingForResults: !!item.run!.waitingForResults?.length,
              },
            },
          },
        ],
        workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
      };
      await act(async () => {
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
    },
    waitingParent: () => {
      requiredParent = true;
      item.run!.status = 'waiting_execution';
    },
    runningParent: () => {
      item.run!.status = 'running';
      item.run!.createdAt = Date.now() - 10000;
      parentMessage.runId = item.run!.id;
    },
    render: (testDiagnostics = false) =>
      act(async () => root.render(<NativeDesktop testDiagnostics={testDiagnostics} />)),
    unmount: () => act(async () => root.render(null)),
    open: () => click('查看子 Agent 详情：Live child'),
    hold: () => {
      holdNext = true;
    },
    heldId: () => heldReadId,
    scopedEnvironment: () => {
      selectedEnvironmentRevision = revision;
      environmentReadUnavailable = false;
    },
    holdParent: () => {
      holdParent = true;
    },
    holdDirectory: () => {
      holdDirectory = true;
    },
    releaseDirectory: () => act(async () => releaseDirectory?.()),
    failParent: (value = true) => {
      failParent = value;
    },
    executions: (values: typeof executions) => {
      executions = values;
    },
    backgroundUnavailable: async (value: boolean) => {
      backgroundUnavailable = value;
      await act(async () => {
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
    },
    releaseParent: () => act(async () => releaseParent?.()),
    releaseMetadata: () =>
      act(async () => {
        metadataPending = false;
        for (const release of metadataReleases) release();
        metadataReleases.clear();
      }),
    edit: (text: string) =>
      act(async () => {
        const input = host.querySelector('[role="textbox"][contenteditable]')!;
        await setPromptText(input, text);
      }),
    unavailable: async (value: boolean) => {
      viewLoading = false;
      permissionUnavailable = value;
      revision++;
      await act(async () => {
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
    },
    refreshing: async (value: boolean) => {
      viewLoading = value;
      permissionUnavailable = value;
      await act(async () => {
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
    },
    update: async (text: string) => {
      childText = text;
      revision++;
      if (selectedEnvironmentRevision !== undefined) selectedEnvironmentRevision++;
      await act(async () => {
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
    },
    updateParent: async (text: string) => {
      parentMessage.content = text;
      revision++;
      await act(async () => {
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
    },
    release: () => act(async () => releaseHeld?.()),
    async close() {
      await act(async () => root.unmount());
      for (const release of metadataReleases) release();
      releaseDirectory?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      restoreLayout();
      Object.assign(globalThis, prior);
    },
  };
}

test('first exact child visit uses its verified carrier before a pending directory refresh completes', async () => {
  const f = fixture(true);
  try {
    await f.render();
    await f.click('Original');
    const before = f.requests.filter((request) => request.method === 'background.open').length;
    f.holdDirectory();
    await f.update('First child record');
    expect(f.requests.filter((request) => request.method === 'background.open')).toHaveLength(
      before + 1,
    );
    f.hold();
    await f.open();
    expect(f.requests.filter((request) => request.method === 'background.child.open')).toHaveLength(
      1,
    );
    expect(f.host.querySelector('.session-header')!.textContent).toContain('Live child');
    await f.release();
    await f.waitForText('First child record');
    expect(f.host.textContent).toContain('First child record');
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    await f.click('返回主会话');
    expect(f.host.textContent).toContain('Parent transcript');
    await f.releaseDirectory();
    expect(f.host.textContent).not.toContain('First child record');
    expect(f.requests.some((request) => request.method === 'background.stop')).toBe(false);
  } finally {
    await f.close();
  }
});

test('ordinary sessions hide background aggregates for live, unknown and unavailable observations', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click('Original');
    for (const status of ['planned', 'dispatching', 'running', 'outcome_unknown'] as const) {
      f.executions([{ ...backgroundItem(2).execution, result: null, status }]);
      await f.update('Child prefix');
      expect(f.host.querySelector('[aria-label="当前会话后台状态"]') === null).toBe(true);
      expect(f.host.textContent).not.toContain('后台状态：');
      expect(f.host.textContent).not.toContain('历史已完整读取至固定高水位');
      expect(f.host.textContent).toContain('Parent transcript');
      expect(f.host.querySelector('[aria-label="环境信息"]')).not.toBeNull();
    }
    await f.backgroundUnavailable(true);
    expect(f.host.querySelector('[aria-label="当前会话后台状态"]') === null).toBe(true);
    await f.backgroundUnavailable(false);
    await f.unavailable(true);
    expect(f.host.querySelector('[aria-label="当前会话后台状态"]') === null).toBe(true);
    expect(f.host.textContent).toContain('Parent transcript');
    expect(f.requests.some((request) => request.method === 'caller.submit')).toBe(false);
  } finally {
    await f.close();
  }
});

test('returning from a running child renders saved parent messages before pending Tool metadata completes', async () => {
  for (const target of ['返回主会话', 'Original']) {
    const f = fixture(true, true);
    f.runningParent();
    try {
      await f.render();
      await f.click('Original');
      expect(f.requests.some((request) => request.method === 'toolMessages.list')).toBe(true);
      await f.open();
      await f.waitForText('Child prefix');
      expect(f.host.textContent).toContain('Child prefix');
      f.holdParent();
      await f.click(target);
      await f.waitForText('Original parent delegation request');
      // Neither the metadata response nor the running child has been released.
      expect(f.host.textContent).toContain('Original parent delegation request');
      expect(f.host.textContent).toContain('Parent transcript');
      expect(f.host.textContent).not.toContain('Child prefix');
      expect(f.host.textContent).not.toContain('Original accepted child receipt');
      expect(f.host.querySelector('.conversation-loading')).toBeNull();
      expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
        true,
      );
      expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
        'Original private draft',
      );
      await f.edit('Draft while child and metadata remain pending');
      expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
        'Draft while child and metadata remain pending',
      );
      await f.releaseParent();
      expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
        false,
      );
      await f.open();
      await f.waitForText('Child prefix');
      expect(f.host.textContent).toContain('Child prefix');
      await f.click('返回主会话');
      await f.releaseMetadata();
      expect(f.host.textContent).toContain('Original parent delegation request');
      expect(f.host.querySelector('.conversation-loading')).toBeNull();
      expect(
        f.requests.some((request) =>
          ['submit', 'caller.prepare', 'caller.submit', 'background.cancel'].includes(
            request.method,
          ),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  }
});

test('explicit test diagnostics retain scoped background counts and child read identities', async () => {
  const f = fixture();
  const job = { ...backgroundItem(2).execution, result: null };
  f.executions([
    job,
    { ...job, id: 'stopping', status: 'dispatching', cancelRequestedAt: 1 },
    { ...job, id: 'unknown', status: 'outcome_unknown' },
    { ...job, id: 'ended', status: 'succeeded' },
    { ...job, id: 'other-session', sessionId: 'other' },
    { ...job, id: 'old-store', originStoreId: 'old' },
    { ...job, id: 'tool', kind: 'tool' },
  ]);
  try {
    await f.render(true);
    await f.click('Original');
    const aggregate = () => f.host.querySelector('[aria-label="当前会话后台状态"]');
    expect(aggregate()?.textContent).toBe('后台状态：2 项未结束，1 项未知');
    await f.backgroundUnavailable(true);
    expect(aggregate()?.textContent).toBe('后台状态：2 项未结束，1 项未知 · 上次确认状态');
    await f.backgroundUnavailable(false);
    await f.open();
    await f.waitForText('Child prefix');
    expect(f.host.textContent).toContain('已完整读取子日志至固定序号');
    expect(f.host.textContent).toContain('original-child-run');
    expect(f.host.textContent).toContain('Child prefix');
  } finally {
    await f.close();
  }
});

test('a renderer compiled without diagnostics cannot expose aggregates or child identities through component opt-in', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__');
  Object.defineProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__', {
    configurable: true,
    value: false,
  });
  const f = fixture();
  f.executions([{ ...backgroundItem(2).execution, result: null }]);
  try {
    await f.render(true);
    await f.click('Original');
    expect(f.host.querySelector('[aria-label="当前会话后台状态"]') === null).toBe(true);
    expect(f.host.textContent).not.toContain('会话工具');
    await f.open();
    await f.waitForText('Child prefix');
    expect(f.host.textContent).toContain('Child prefix');
    expect(f.host.textContent).not.toContain('已完整读取子日志至固定序号');
    expect(f.host.textContent).not.toContain('original-child-run');
  } finally {
    await f.close();
    if (previous) Object.defineProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__', previous);
    else Reflect.deleteProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__');
  }
});

test('live child navigation pauses parent history, updates the active child and restores the original draft', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click('Original');
    expect(f.listeners.size).toBe(1);
    expect(f.host.textContent).toContain('Parent transcript');
    expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
      'Original private draft',
    );
    await f.open();
    await f.waitForText('Child prefix');
    expect(f.host.textContent).toContain('Child prefix');
    expect(f.host.textContent).not.toContain('已完整读取子日志至固定序号');
    expect(f.host.textContent).not.toContain('original-child-run');
    expect(f.host.textContent).not.toContain('Parent transcript');
    const parentReads = f.requests.filter((request) => request.method === 'messages').length;
    await f.update('Child prefix with live tail 雪🙂');
    await f.waitForText('Child prefix with live tail 雪🙂');
    expect(f.host.textContent).toContain('Child prefix with live tail 雪🙂');
    expect(f.requests.filter((request) => request.method === 'messages')).toHaveLength(parentReads);
    expect(f.requests.filter((request) => request.method === 'state').length).toBeGreaterThan(0);
    await f.click('返回主会话');
    expect(f.host.textContent).toContain('Parent transcript');
    expect(f.host.textContent).not.toContain('Child prefix with live tail');
    expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
      'Original private draft',
    );
    expect(f.requests.filter((request) => request.method === 'messages').length).toBeGreaterThan(
      parentReads,
    );
  } finally {
    await f.close();
  }
});

test('opening the selected parent from child details returns without selecting again', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click('Original');
    await f.open();
    await f.waitForText('Child prefix');
    expect(f.host.textContent).toContain('Child prefix');
    const selections = f.requests.filter((request) => request.method === 'select').length;
    await f.click('Original');
    await f.waitForText('Parent transcript');
    expect(f.host.textContent).toContain('Parent transcript');
    expect(f.host.textContent).not.toContain('Child prefix');
    expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
      'Original private draft',
    );
    expect(f.requests.filter((request) => request.method === 'select')).toHaveLength(selections);
  } finally {
    await f.close();
  }
});

test('repeated reply calibrations retain the footer controls and transcript DOM while real history failures remain visible', async () => {
  const f = fixture(true);
  try {
    await f.render();
    await f.click('Original');
    const viewport = f.host.querySelector('.conversation-viewport'),
      message = f.host.querySelector('.message.assistant'),
      input = f.host.querySelector('[role="textbox"][contenteditable]'),
      permission = f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]');
    expect(permission).not.toBeNull();
    expect(permission!.disabled).toBe(false);
    const footerText = f.host.querySelector('.conversation-footer')!.textContent;
    for (let index = 0; index < 8; index++) {
      f.holdParent();
      const text = `Parent transcript reply update ${index}`;
      await f.updateParent(text);
      expect(f.host.querySelector('.conversation-viewport') === viewport).toBe(true);
      expect(f.host.querySelector('.message.assistant') === message).toBe(true);
      expect(f.host.querySelector('[role="textbox"][contenteditable]') === input).toBe(true);
      expect(f.host.querySelector('[data-permission-trigger]') === permission).toBe(true);
      expect(permission!.disabled).toBe(true);
      expect(message!.textContent).not.toContain(text);
      expect(f.host.querySelector('.conversation-footer')!.textContent).toBe(footerText);
      await f.releaseParent();
      expect(f.host.querySelector('[data-permission-trigger]') === permission).toBe(true);
      expect(permission!.disabled).toBe(false);
      expect(f.host.querySelector('.message.assistant') === message).toBe(true);
      expect(message!.textContent).toContain(text);
      expect(f.host.querySelector('.conversation-footer')!.textContent).toBe(footerText);
    }
    f.failParent();
    await f.update('failed read');
    expect(f.host.textContent).toContain('历史尚未完整校准');
    expect(f.host.textContent).toContain('Parent transcript');
    expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
      true,
    );
    f.failParent(false);
    await f.click('重新加载会话');
    expect(f.host.textContent).not.toContain('历史尚未完整校准');
    expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
      false,
    );
    await f.unavailable(true);
    expect(f.host.querySelector('[aria-label="当前会话后台状态"]') === null).toBe(true);
    expect(
      f.requests.some((request) =>
        ['submit', 'caller.prepare', 'caller.submit', 'permission.mode'].includes(request.method),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('ordinary history and View refreshes retain the processed status and timer; actual observation and history failures revoke them', async () => {
  const f = fixture(true);
  f.runningParent();
  try {
    await f.render();
    await f.click('Original');
    const status = f.host.querySelector('.agent-turn-status-label')!,
      timer = status.querySelector('span'),
      permission = f.host.querySelector('[data-permission-trigger]')!,
      input = f.host.querySelector('.composer [role="textbox"][contenteditable]');
    expect(status.textContent).toMatch(/^已处理 .*秒/);
    expect(timer).not.toBeNull();
    for (let index = 0; index < 8; index++) {
      f.holdParent();
      await f.updateParent(`running reply ${index}`);
      expect(f.host.querySelector('.agent-turn-status-label') === status).toBe(true);
      expect(status.textContent).toMatch(/^已处理 .*秒/);
      expect(status.querySelector('span') === timer).toBe(true);
      await f.releaseParent();
      await f.refreshing(true);
      expect(status.textContent).toMatch(/^已处理 .*秒/);
      expect(status.querySelector('span') === timer).toBe(true);
      expect(f.host.querySelector('[aria-label="当前会话后台状态"]') === null).toBe(true);
      expect(f.host.querySelector('[data-permission-trigger]')).toBe(permission);
      expect((permission as HTMLButtonElement).disabled).toBe(true);
      expect(f.host.querySelector('.composer [role="textbox"][contenteditable]')).toBe(input);
      await f.refreshing(false);
      expect(status.textContent).toMatch(/^已处理 .*秒/);
      expect(f.host.querySelector('[data-permission-trigger]')).toBe(permission);
    }
    await f.unavailable(true);
    expect(status.textContent).toBe('上次确认状态');
    expect(f.host.querySelector('[aria-label="当前会话后台状态"]') === null).toBe(true);
    expect(f.host.querySelector('[data-permission-trigger]')).toBeNull();
    await f.unavailable(false);
    expect(status.textContent).toMatch(/^已处理 .*秒/);
    f.failParent();
    await f.updateParent('held after failure');
    expect(status.textContent).toBe('上次确认状态');
    expect(f.host.textContent).toContain('历史尚未完整校准');
    f.failParent(false);
    await f.click('重新加载会话');
    expect(status.textContent).toMatch(/^已处理 .*秒/);
  } finally {
    await f.close();
  }
});

test('returning during a held child read closes its own reader and ignores late EOF; remounts release the single observer', async () => {
  const f = fixture();
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      await f.render();
      await f.click('Original');
      expect(f.listeners.size).toBe(1);
      f.hold();
      await f.open();
      const readId = f.heldId();
      expect(readId).toBeDefined();
      await f.click('返回主会话');
      expect(
        f.requests.some(
          (request) => request.method === 'background.child.close' && request.readId === readId,
        ),
      ).toBe(true);
      await f.release();
      expect(f.host.textContent).toContain('Parent transcript');
      expect(f.host.textContent).not.toContain('Child prefix');
      expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
        'Original private draft',
      );
      await f.unmount();
      expect(f.listeners.size).toBe(0);
    }
  } finally {
    await f.close();
  }
});

test('returning keeps the cached parent readable but gates send, stop and permission until fresh history EOF', async () => {
  const f = fixture(true);
  const action = (label: string) =>
    f.host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    await f.render();
    await f.click('Original');
    expect(action('引导当前轮次').disabled).toBe(false);
    expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
      false,
    );
    await f.open();
    await f.waitForText('Child prefix');
    f.holdParent();
    await f.click('返回主会话');
    expect(f.host.textContent).toContain('Parent transcript');
    expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
      'Original private draft',
    );
    expect(
      f.host.querySelector('[role="textbox"][contenteditable]')!.getAttribute('contenteditable') !==
        'true',
    ).toBe(false);
    expect(action('引导当前轮次').disabled).toBe(true);
    await f.click('引导当前轮次');
    const permission = f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]');
    expect(permission === null || permission.disabled).toBe(true);
    await f.edit('');
    expect(action('停止任务').disabled).toBe(true);
    // Disabled controls cannot submit a mutation while only cached display is available.
    await f.click('停止任务');
    expect(
      f.requests.some((request) =>
        ['conversation.send', 'caller.prepare', 'caller.submit', 'permission.mode'].includes(
          request.method,
        ),
      ),
    ).toBe(false);
    await f.releaseParent();
    expect(action('停止任务').disabled).toBe(false);
    expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
      false,
    );
    await f.edit('Original private draft');
    expect(action('引导当前轮次').disabled).toBe(false);
  } finally {
    await f.close();
  }
});

test('same-scope permission loss closes a held child read, preserves stale text and resumes with a full fresh calibration', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click('Original');
    await f.open();
    await f.waitForText('Child prefix');
    f.hold();
    await f.update('Unverified held child tail');
    // Directory publication queues its child reader after the React commit.
    for (let attempt = 0; attempt < 50 && !f.heldId(); attempt++)
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    const readId = f.heldId();
    expect(readId).toBeDefined();
    await f.unavailable(true);
    expect(
      f.requests.some(
        (request) => request.method === 'background.child.close' && request.readId === readId,
      ),
    ).toBe(true);
    expect(f.host.textContent).toContain('Child prefix');
    await f.release();
    expect(f.host.textContent).not.toContain('Unverified held child tail');
    const opensBeforeRecovery = f.requests.filter(
      (request) => request.method === 'background.child.open',
    ).length;
    await f.unavailable(false);
    await f.waitForText('Unverified held child tail');
    expect(f.host.textContent).toContain('Unverified held child tail');
    const resumed = f.requests.filter((request) => request.method === 'background.child.open')[
      opensBeforeRecovery
    ]!;
    expect(resumed.method).toBe('background.child.open');
    if (resumed.method !== 'background.child.open') throw Error('expected_child_recovery');
    expect(resumed.cursor).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('100 retired child waits release before their shared directory and only the final child opens', async () => {
  let resolveDirectory!: (value: number) => void;
  const directory = new Promise<number>((resolve) => {
    resolveDirectory = resolve;
  });
  const controllers = Array.from({ length: 100 }, () => new AbortController());
  const waits = controllers.map((controller) =>
    waitForNativeDirectory(directory, controller.signal),
  );
  for (const controller of controllers.slice(0, -1)) controller.abort();
  expect(
    (await Promise.allSettled(waits.slice(0, -1))).every((result) => result.status === 'rejected'),
  ).toBe(true);
  resolveDirectory(7);
  expect(await waits.at(-1)).toBe(7);

  const dom = new JSDOM('<div id="root"></div>');
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const item = backgroundItem(1, true),
    calls: NativeRequest[] = [];
  let release!: (value: NativeResult) => void;
  let open!: (id: string) => void;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      calls.push(request);
      if (request.method === 'background.open')
        return new Promise<NativeResult>((resolve) => {
          release = resolve;
        });
      if (request.method === 'background.child.open') throw Error('fixture_child_admitted');
      return null;
    },
  };
  function Harness() {
    const environment = useNativeEnvironment({
      bridge,
      generation: 1,
      selection: {
        viewGeneration: 1,
        viewSelection: 1,
        storeId: 'store',
        session: item.rootSession,
        runs: [],
        executions: [],
        interactions: [],
        interactionsAfterId: null,
        canReadModelOutput: false,
      },
      revision: 0,
      unavailable: false,
      onChanged: async () => {},
    });
    open = environment.openChild;
    return null;
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      for (let index = 0; index < 100; index++) open('child');
    });
    expect(calls.filter((request) => request.method === 'background.child.open')).toHaveLength(0);
    expect(calls.filter((request) => request.method === 'background.close')).toHaveLength(0);
    await act(async () =>
      release({
        kind: 'background.page',
        viewGeneration: 1,
        viewSelection: 1,
        rootSessionId: 'root',
        storeId: 'store',
        readId: calls.find((request) => request.method === 'background.open')!.readId,
        observationId: 1,
        startIndex: 0,
        nextIndex: 1,
        total: 1,
        complete: true,
        entries: [item],
      }),
    );
    expect(calls.filter((request) => request.method === 'background.child.open')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

for (const initial of ['unique', 'ambiguous', 'missing'] as const)
  test(`child navigation pins its first bounded carrier and refuses later retargeting: ${initial}`, async () => {
    const ambiguous = initial !== 'unique';
    const dom = new JSDOM('<div id="root"></div>');
    const prior = { window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const root = createRoot(dom.window.document.getElementById('root')!);
    const first = backgroundItem(1, true),
      second = backgroundItem(2, true);
    let entries = initial === 'missing' ? [] : ambiguous ? [first, second] : [first];
    let release!: (value: NativeResult) => void;
    let open!: (id: string, executionId?: string) => void;
    const calls: NativeRequest[] = [];
    let observation = 0;
    const page = (
      request: Extract<NativeRequest, { method: 'background.open' }>,
    ): NativeResult => ({
      kind: 'background.page',
      viewGeneration: 1,
      viewSelection: 1,
      rootSessionId: 'root',
      storeId: 'store',
      readId: request.readId,
      observationId: ++observation,
      startIndex: 0,
      nextIndex: entries.length,
      total: entries.length,
      complete: true,
      entries,
    });
    const bridge: NativeBridge = {
      watch: () => () => {},
      async request(request) {
        calls.push(request);
        if (request.method === 'background.open') {
          if (!observation)
            return new Promise<NativeResult>((resolve) => {
              release = resolve;
            });
          return page(request);
        }
        if (request.method === 'background.child.open') throw Error('fixture_child_read');
        return null;
      },
    };
    function Harness({ revision }: { revision: number }) {
      const environment = useNativeEnvironment({
        bridge,
        generation: 1,
        selection: {
          viewGeneration: 1,
          viewSelection: 1,
          storeId: 'store',
          session: first.rootSession,
          runs: [],
          executions: [],
          interactions: [],
          interactionsAfterId: null,
          canReadModelOutput: false,
        },
        revision,
        unavailable: false,
        onChanged: async () => {},
      });
      open = environment.openChild;
      return <p>{environment.child?.error ?? environment.child?.executionId ?? 'waiting'}</p>;
    }
    const childOpens = () => calls.filter((request) => request.method === 'background.child.open');
    try {
      await act(async () => root.render(<Harness revision={0} />));
      await act(async () => open('child'));
      expect(childOpens()).toHaveLength(0);
      await act(async () =>
        release(
          page(
            calls.find((request) => request.method === 'background.open') as Extract<
              NativeRequest,
              { method: 'background.open' }
            >,
          ),
        ),
      );
      expect(childOpens()).toHaveLength(ambiguous ? 0 : 1);
      if (ambiguous)
        expect(dom.window.document.body.textContent).toContain(
          'background_child_target_unavailable',
        );
      else expect(childOpens()[0]!.executionId).toBe(first.execution.id);
      entries = [second];
      await act(async () => root.render(<Harness revision={1} />));
      expect(childOpens()).toHaveLength(ambiguous ? 0 : 1);
      expect(dom.window.document.body.textContent).toContain(
        ambiguous ? 'background_child_target_unavailable' : 'background_child_unavailable',
      );
      entries = [first, second];
      await act(async () => root.render(<Harness revision={2} />));
      expect(childOpens().every((request) => request.executionId === first.execution.id)).toBe(
        true,
      );
      const beforeExplicit = childOpens().length;
      await act(async () => open('child', second.execution.id));
      expect(childOpens()).toHaveLength(beforeExplicit + 1);
      expect(childOpens().at(-1)!.executionId).toBe(second.execution.id);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, prior);
    }
  });

test('Main readonly qualification keeps child EOF alive during ordinary metadata refresh while parent writes stay gated', async () => {
  const f = fixture();
  f.scopedEnvironment();
  try {
    await f.render();
    await f.click('Original');
    await f.open();
    await f.waitForText('Child prefix');
    f.hold();
    await f.update('Read qualified tail');
    for (let attempt = 0; attempt < 50 && !f.heldId(); attempt++)
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    const readId = f.heldId();
    expect(readId).toBeDefined();
    const directoryReads = f.requests.filter(
      (request) => request.method === 'background.open',
    ).length;
    // A global refresh changes the raw metadata gate, but Main explicitly retains read authority.
    await f.unavailable(true);
    expect(f.requests.filter((request) => request.method === 'background.open')).toHaveLength(
      directoryReads,
    );
    expect(
      f.requests.some(
        (request) => request.method === 'background.child.close' && request.readId === readId,
      ),
    ).toBe(false);
    await f.release();
    await f.waitForText('Read qualified tail');
    expect(f.host.textContent).toContain('Read qualified tail');
    await f.click('返回主会话');
    expect(
      f.host.querySelector<HTMLButtonElement>('button[aria-label="发送明确的新轮次"]')!.disabled,
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('explicit child close wins over a directory publication with a queued automatic-resume effect', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const item = backgroundItem(1, true);
  let observation = 0,
    directoryCloses = 0,
    childOpens = 0,
    closed = false;
  let open!: () => void;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      if (request.method === 'background.open')
        return {
          kind: 'background.page',
          viewGeneration: 1,
          viewSelection: 1,
          rootSessionId: 'root',
          storeId: 'store',
          readId: request.readId,
          observationId: ++observation,
          startIndex: 0,
          nextIndex: 1,
          total: 1,
          complete: true,
          entries: [item],
        };
      if (request.method === 'background.close') directoryCloses++;
      if (request.method === 'background.child.open') {
        childOpens++;
        throw Error('fixture_read_failed');
      }
      return null;
    },
  };
  function Harness({ revision }: { revision: number }) {
    const environment = useNativeEnvironment({
      bridge,
      generation: 1,
      selection: {
        viewGeneration: 1,
        viewSelection: 1,
        storeId: 'store',
        session: item.rootSession,
        runs: [],
        executions: [],
        interactions: [],
        interactionsAfterId: null,
        canReadModelOutput: false,
      },
      revision,
      unavailable: false,
      onChanged: async () => {},
    });
    open = () => environment.openChild('child');
    // This is the precise commit/effect interval in which a user can leave the child page.
    useLayoutEffect(() => {
      if (revision && directoryCloses >= 2 && environment.child && !closed) {
        closed = true;
        environment.closeChild();
      }
    });
    return <p>{environment.child?.sessionId ?? 'main'}</p>;
  }
  try {
    await act(async () => root.render(<Harness revision={0} />));
    await act(async () => open());
    expect(dom.window.document.getElementById('root')!.textContent).toBe('child');
    await act(async () => root.render(<Harness revision={1} />));
    expect(closed).toBe(true);
    expect(dom.window.document.getElementById('root')!.textContent).toBe('main');
    expect(childOpens).toBe(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

test('NativeDesktop marks an unowned active Run unverified without changing durable Run facts or issuing mutations', async () => {
  for (const waiting of [false, true]) {
    const f = fixture(true);
    f.runningParent();
    if (waiting) f.waitingParent();
    const originalRun = f.observedRun();
    const warning = () => f.host.querySelector('[aria-label="会话执行状态待核实"]');
    const sidebarSpinner = () =>
      f.host.querySelector(
        'button.session-row [aria-label="会话运行中"], button.session-row [aria-label="任务进行中"]',
      );
    try {
      await f.observeExecutionOwner('unheld');
      await f.render();
      await f.click('Original');
      expect(warning()?.textContent).toContain('原执行者已释放');
      expect(sidebarSpinner()).toBeNull();
      expect(f.host.querySelector('.agent-turn-status-label')?.textContent).toBe('上次确认状态');
      expect(f.host.textContent).not.toContain('正在等待子 Agent 结果');
      expect(f.observedRun()).toEqual(originalRun);
      expect(f.observedRun()?.isActive).toBe(true);

      await f.observeExecutionOwner('held');
      expect(warning()).toBeNull();
      expect(sidebarSpinner()).not.toBeNull();
      expect(f.host.querySelector('.agent-turn-status-label')?.textContent).toMatch(
        waiting ? /^正在等待/ : /^已处理 .*秒/,
      );
      expect(f.host.textContent?.includes('正在等待子 Agent 结果')).toBe(waiting);

      await f.observeExecutionOwner('unknown');
      expect(warning()?.textContent).toContain('无法核实原执行者');
      expect(sidebarSpinner()).toBeNull();
      expect(f.host.querySelector('.agent-turn-status-label')?.textContent).toBe('上次确认状态');

      await f.observeExecutionOwner('unheld', true);
      expect(warning()).toBeNull();
      expect(sidebarSpinner()).toBeNull();
      expect(f.host.querySelector('button.session-row')?.getAttribute('aria-description')).toBe(
        '上次确认状态',
      );
      expect(f.observedRun()).toEqual(originalRun);
      const permittedReads = new Set([
        'attach',
        'state',
        'select',
        'directory',
        'messages',
        'messages.close',
        'draft.read',
        'input.models.read',
        'context.open',
        'context.chunk',
        'context.close',
        'runs.list',
        'toolMessages.list',
        'background.open',
        'background.close',
        'background.children.list',
        'modelSettings',
        'modelSettings.read',
        'modelInput.open',
        'modelInput.chunk',
        'modelInput.close',
      ]);
      expect(f.requests.filter((request) => !permittedReads.has(request.method))).toEqual([]);
    } finally {
      await f.close();
    }
  }
});

test('a completed child uses the shared collapsed process, concise exploration and verified final reply while preserving its parent', async () => {
  const f = fixture();
  const reply = '# Child final answer\n\n**Verified** child reply 雪🙂\r\n',
    output = { complete: true, content: reply, reasoning: '', toolCalls: [] },
    encoded = JSON.stringify(output);
  const snapshot: ModelOutputSnapshot = {
    storeId: 'store',
    sessionId: 'child',
    rootSessionId: 'root',
    runId: 'finished-child-run',
    executionId: 'child-model',
    originCommandId: 'child-work',
    rootWorkCommandId: 'start',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    snapshotCursor: '1',
    bodyHash: createHash('sha256').update(encoded).digest('hex'),
    bodyBytes: String(Buffer.byteLength(encoded)),
    contentBytes: String(Buffer.byteLength(reply)),
    reasoningBytes: '0',
    output,
  };
  const rows: Message[] = [
    { id: 'child-user', role: 'user', content: 'Inspect the child files' },
    {
      id: 'child-explanation',
      role: 'assistant',
      content: 'Child process explanation',
      toolCalls: [
        { id: 'read-a', name: 'files.read', arguments: '{"path":"child-a.txt"}' },
        { id: 'read-b', name: 'files.read', arguments: '{"path":"child-b.txt"}' },
      ],
    },
    {
      id: 'child-read-a',
      role: 'tool',
      content: 'RAW_CHILD_RECEIPT_A',
      sourceIds: ['child-tool-a'],
      toolCallId: 'read-a',
    },
    {
      id: 'child-read-b',
      role: 'tool',
      content: 'RAW_CHILD_RECEIPT_B',
      sourceIds: ['child-tool-b'],
      toolCallId: 'read-b',
    },
    {
      id: 'child-final',
      role: 'assistant',
      content: 'CHILD_REPLY_PREVIEW',
      outputBody: {
        kind: 'model_output',
        executionId: snapshot.executionId,
        complete: true,
        contentBytes: snapshot.contentBytes,
        reasoningBytes: '0',
        toolCallCount: 0,
      },
    },
  ].map((row, index) => ({
    ...row,
    sessionId: 'child',
    runId: snapshot.runId,
    seq: String(index + 1),
    status: 'complete',
  })) as Message[];
  f.childBody({
    upperSeq: '5',
    messages: rows,
    modelOutputs: [{ messageId: 'child-final', snapshot }],
    presentation: {
      runs: [
        {
          id: snapshot.runId!,
          sessionId: 'child',
          originStoreId: 'store',
          status: 'completed',
          isActive: false,
          createdAt: 1000,
          finishedAt: 3000,
          reason: null,
        },
      ],
      tools: ['a', 'b'].map((suffix) => ({
        messageId: `child-read-${suffix}`,
        executionId: `child-tool-${suffix}`,
        definitionId: 'files.read',
        definitionVersion: '3',
        status: 'succeeded',
        resultRevision: '1',
        target: `child-${suffix}.txt`,
      })),
      executions: [],
    },
  });
  try {
    await f.render();
    await f.click('Original');
    await f.edit('Keep the parent draft exactly 雪🙂');
    const parentNode = [...f.host.querySelectorAll('p')].find(
      (node) => node.textContent === 'Parent transcript',
    );
    expect(parentNode).toBeDefined();
    const beforeChild = f.requests.length;
    await f.open();
    await f.waitForText('Child final answer');
    const final = f.host.querySelector('.agent-turn-final');
    expect(final).not.toBeNull();
    expect(final!.querySelector('h1')!.textContent).toBe('Child final answer');
    expect(final!.querySelector('strong')!.textContent).toBe('Verified');
    expect(final!.textContent).not.toContain('Child process explanation');
    expect(f.host.textContent).not.toContain('CHILD_REPLY_PREVIEW');
    expect(f.host.textContent).not.toContain('Parent transcript');
    expect(f.host.querySelector('[role="textbox"][contenteditable]')).toBeNull();
    const process = f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    expect(process.getAttribute('aria-expanded')).toBe('false');
    expect(f.host.querySelector('[aria-label="复制本轮Agent回复"]')).not.toBeNull();
    await f.click('复制本轮Agent回复');
    expect(f.copied).toEqual([reply]);
    await act(async () => process.click());
    expect(f.host.textContent).toContain('Child process explanation');
    const exploration = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    expect(exploration).not.toBeNull();
    expect(exploration.textContent).toContain('2');
    await act(async () => exploration.click());
    expect(f.host.querySelectorAll('.tool-activity-steps .tool-activity-step')).toHaveLength(2);
    expect(f.host.textContent).toContain('child-a.txt');
    expect(f.host.textContent).toContain('child-b.txt');
    expect(f.host.textContent).toContain('读取');
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain('RAW_CHILD_RECEIPT_A');
    expect(f.host.textContent).not.toContain('RAW_CHILD_RECEIPT_B');
    expect(f.host.querySelectorAll('button.file-link')).toHaveLength(0);
    expect(f.host.querySelectorAll('.composer-attachments')).toHaveLength(0);
    const childRequests = f.requests.slice(beforeChild);
    expect(
      childRequests.filter(
        (request) =>
          request.method.startsWith('toolMessages.') ||
          request.method.startsWith('fileTargets.') ||
          request.method === 'messages',
      ),
    ).toHaveLength(0);
    expect(
      childRequests.filter(
        (request) =>
          /^(input|permission|interaction|messageFile)\./.test(request.method) &&
          !request.method.endsWith('.read'),
      ),
    ).toHaveLength(0);
    await f.click('返回主会话');
    await f.waitForText('Parent transcript');
    expect(f.host.contains(parentNode!)).toBe(true);
    expect(promptValue(f.host.querySelector('[role="textbox"][contenteditable]'))).toBe(
      'Keep the parent draft exactly 雪🙂',
    );
  } finally {
    await f.close();
  }
});

test('child metadata failure keeps its verified transcript readable and an explicit refresh restores presentation', async () => {
  const f = fixture();
  const body = {
    upperSeq: '1',
    messages: [
      {
        id: 'readable-child',
        sessionId: 'child',
        runId: null,
        seq: '1',
        role: 'assistant' as const,
        status: 'complete' as const,
        content: 'Verified child text while metadata is unavailable',
      },
    ],
    modelOutputs: [],
    presentation: { runs: [], tools: [], executions: [] },
  };
  f.childBody({ ...body, presentation: { ...body.presentation, unavailable: true } });
  try {
    await f.render();
    await f.click('Original');
    await f.open();
    await f.waitForText(body.messages[0]!.content);
    expect(f.host.textContent).toContain(body.messages[0]!.content);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain(
      '无法核对子会话轮次或工具状态',
    );
    expect(f.host.textContent).not.toContain('子日志读取失败');
    f.childBody(body);
    await f.click('刷新子日志');
    for (let attempt = 0; attempt < 50 && f.host.querySelector('[role="alert"]'); attempt++)
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    expect(f.host.textContent).toContain(body.messages[0]!.content);
    expect(
      f.requests.some(
        (request) => request.method === 'caller.submit' || request.method === 'submit',
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
