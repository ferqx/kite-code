import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Message } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
import { useNativeEnvironment, waitForNativeDirectory } from '../../src/native-environment';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

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

function fixture(activeParent = false) {
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
  item.rootSession.nextSeq = '1';
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
  let childText = 'Child prefix',
    revision = 1,
    holdNext = false,
    holdParent = false,
    permissionUnavailable = false;
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
    environmentRevision: revision,
    selectedEnvironmentRevision,
    environmentReadUnavailable,
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
      permissionUnavailable,
      ...(activeParent
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
      executions: [],
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
          return {
            storeId: 'store',
            sessions: [item.rootSession],
            workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
          };
        case 'messages': {
          const result = { messages: [parentMessage], nextAfterSeq: null, highWaterSeq: '1' };
          if (holdParent) {
            holdParent = false;
            return new Promise<NativeResult>((resolve) => {
              releaseParent = () => resolve(result);
            });
          }
          return result;
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
        case 'background.open':
          return {
            kind: 'background.page',
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
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
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
    waitForText,
    requests,
    listeners,
    click,
    render: () => act(async () => root.render(<NativeDesktop />)),
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
    releaseParent: () => act(async () => releaseParent?.()),
    edit: (text: string) =>
      act(async () => {
        const input = host.querySelector('textarea')!;
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          'value',
        )!.set!.call(input, text);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      }),
    unavailable: async (value: boolean) => {
      permissionUnavailable = value;
      revision++;
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
    release: () => act(async () => releaseHeld?.()),
    async close() {
      await act(async () => root.unmount());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      restoreLayout();
      Object.assign(globalThis, prior);
    },
  };
}

test('live child navigation pauses parent history, updates the active child and restores the original draft', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click('Original');
    expect(f.listeners.size).toBe(1);
    expect(f.host.textContent).toContain('Parent transcript');
    expect(f.host.querySelector('textarea')!.value).toBe('Original private draft');
    await f.open();
    await f.waitForText('Child prefix');
    expect(f.host.textContent).toContain('Child prefix');
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
    expect(f.host.querySelector('textarea')!.value).toBe('Original private draft');
    expect(f.requests.filter((request) => request.method === 'messages').length).toBeGreaterThan(
      parentReads,
    );
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
      expect(f.host.querySelector('textarea')!.value).toBe('Original private draft');
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
    expect(f.host.querySelector('textarea')!.value).toBe('Original private draft');
    expect(f.host.querySelector('textarea')!.disabled).toBe(false);
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
