import { expect, test } from 'bun:test';
import type { Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeDirectory,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
const sessions: Session[] = ['a', 'b'].map((id) => ({
  id,
  workspaceId: 'w',
  rootSessionId: id,
  parentSessionId: null,
  title: id === 'a' ? 'Original A' : 'Other B',
  controlRevision: '0',
  contextSelectionId: `context-${id}`,
  nextSeq: '0',
  deletedAt: null,
}));
const directory: NativeDirectory = {
  storeId: 'store',
  workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
  sessions,
};

function fixture(
  override: (request: NativeRequest) => NativeResult | Promise<NativeResult> | undefined,
) {
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
  let selected = 'a';
  const calls: NativeRequest[] = [];
  const listeners = new Set<(event: NativeEvent) => void>();
  const snapshot = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      viewGeneration: selected === 'a' ? 1 : 2,
      viewSelection: selected === 'a' ? 1 : 2,
      canReadModelOutput: false,
      storeId: 'store',
      session: sessions.find((session) => session.id === selected)!,
      runs: [],
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
    async request(request) {
      calls.push(request);
      const replacement = override(request);
      if (replacement !== undefined) return replacement;
      switch (request.method) {
        case 'attach':
        case 'state':
          return snapshot();
        case 'directory':
          return directory;
        case 'select':
          selected = request.sessionId;
          return snapshot();
        case 'messages':
          return { messages: [], nextAfterSeq: null, highWaterSeq: '0' };
        case 'draft.read':
          return {
            id: request.sessionId,
            storeId: 'store',
            workspaceId: 'w',
            rootSessionId: request.sessionId,
            revision: 1,
            content: request.sessionId === 'a' ? 'original text' : 'other text',
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
            storeId: 'store',
            scope: 'user',
            observationId: 1,
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
        default:
          return null;
      }
    },
  };
  Object.assign(dom.window, { kiteNative: bridge });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const click = (name: string) =>
    act(async () => {
      const button = [...dom.window.document.querySelectorAll('button')].find(
        (candidate) =>
          candidate.textContent === name || candidate.getAttribute('aria-label') === name,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  return {
    dom,
    calls,
    click,
    render: () => act(async () => root.render(<NativeDesktop />)),
    notify: () =>
      act(async () => {
        for (const listener of listeners) listener({ generation: 1, kind: 'changed' });
      }),
    assertOther() {
      expect(
        [...dom.window.document.querySelectorAll('.session-header strong')].some(
          (heading) => heading.textContent === 'Other B',
        ),
      ).toBe(true);
      expect(dom.window.document.querySelector('textarea')!.value).toBe('other text');
      expect(dom.window.document.querySelector('[role="alertdialog"]') === null).toBe(true);
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      restoreLayout();
      Object.assign(globalThis, prior);
    },
  };
}

for (const method of ['select', 'draft.read'] as const) {
  test(`superseded A ${method} rejection cannot replace B or open its failure dialog`, async () => {
    const held = deferred<NativeResult>();
    const f = fixture((request) =>
      request.method === method && request.sessionId === 'a' ? held.promise : undefined,
    );
    try {
      await f.render();
      await f.click('Original A');
      expect(f.calls.filter((request) => request.method === method)).toHaveLength(1);
      await f.click('Other B');
      f.assertOther();
      await act(async () => held.reject(Error('native_selection_changed')));
      f.assertOther();
      expect(f.calls.filter((request) => request.method === 'conversation.send')).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
}

test('an old event state rejection in the same generation cannot open a dialog in B', async () => {
  const held = deferred<NativeResult>();
  let hold = false;
  const f = fixture((request) => (request.method === 'state' && hold ? held.promise : undefined));
  try {
    await f.render();
    await f.click('Original A');
    hold = true;
    await f.notify();
    expect(f.calls.filter((request) => request.method === 'state')).toHaveLength(1);
    await f.click('Other B');
    f.assertOther();
    await act(async () => held.reject(Error('connection_superseded')));
    f.assertOther();
  } finally {
    await f.close();
  }
});

test('a current event state failure still opens the original failure dialog', async () => {
  let fail = false;
  const f = fixture((request) => {
    if (request.method === 'state' && fail) throw Error('native_connection_unavailable');
    return undefined;
  });
  try {
    await f.render();
    await f.click('Original A');
    fail = true;
    await f.notify();
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'native_connection_unavailable',
    );
  } finally {
    await f.close();
  }
});

test('a current select rejection is still reported instead of being consumed as superseded', async () => {
  const held = deferred<NativeResult>();
  const f = fixture((request) =>
    request.method === 'select' && request.sessionId === 'a' ? held.promise : undefined,
  );
  try {
    await f.render();
    await f.click('Original A');
    expect(f.calls.filter((request) => request.method === 'select')).toHaveLength(1);
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => held.reject(Error('native_connection_unavailable')));
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'native_connection_unavailable',
    );
    expect(f.calls.filter((request) => request.method === 'select')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a global directory failure remains visible after a same-generation session switch', async () => {
  const held = deferred<NativeResult>();
  let hold = false;
  const f = fixture((request) =>
    request.method === 'directory' && hold ? held.promise : undefined,
  );
  try {
    await f.render();
    await f.click('Original A');
    hold = true;
    await f.click('重新读取目录');
    expect(f.calls.filter((request) => request.method === 'directory')).toHaveLength(2);
    await f.click('Other B');
    f.assertOther();
    await act(async () => held.reject(Error('session_directory_unavailable')));
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'session_directory_unavailable',
    );
    expect(f.dom.window.document.querySelector('textarea')!.value).toBe('other text');
  } finally {
    await f.close();
  }
});

test('a mutation transport failure retains the unknown original intent and explicit lookup without another POST', async () => {
  let submitted: Extract<NativeRequest, { method: 'conversation.send' }> | undefined;
  const f = fixture((request) => {
    if (request.method === 'conversation.send') {
      submitted = request;
      throw Error('network_outcome_unknown');
    }
    if (request.method === 'conversation.lookup')
      return {
        kind: 'conversation',
        commandId: request.commandId,
        phase: 'unknown',
        stage: 'create',
      };
    return undefined;
  });
  try {
    await f.render();
    await f.click('Original A');
    await f.click('在 Workspace 中新建对话');
    await f.click('研究与理解资料');
    await f.click('发送首条消息');
    expect(submitted).toBeDefined();
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'network_outcome_unknown',
    );
    await f.click('确定');
    await f.click('查询原首次提交');
    const lookups = f.calls.filter((request) => request.method === 'conversation.lookup');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.commandId).toBe(submitted!.intent.commandId);
    expect(f.calls.filter((request) => request.method === 'conversation.send')).toHaveLength(1);
    expect(
      [...f.dom.window.document.querySelectorAll('button')].some(
        (button) => button.textContent === '查询原首次提交',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('a real initial attach failure retains startup failure and retry instead of entering the product', async () => {
  const f = fixture((request) => {
    if (request.method === 'attach') throw Error('required_capability_missing');
    return undefined;
  });
  try {
    await f.render();
    expect(f.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain(
      '启动未完成：required_capability_missing',
    );
    expect(f.dom.window.document.querySelector('.shell')).toBeNull();
    expect(
      [...f.dom.window.document.querySelectorAll('button')].some(
        (button) => button.textContent === '重新尝试',
      ),
    ).toBe(true);
    expect(f.calls.map((request) => request.method)).toEqual(['attach']);
  } finally {
    await f.close();
  }
});
