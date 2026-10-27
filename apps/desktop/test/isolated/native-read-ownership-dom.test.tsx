import { expect, test } from 'bun:test';
import type { Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { nativeDraftProof } from '../../electron/caller-journal';
import { NativeInputImages } from '../../electron/input-images';
import type { BrowserSavedAnnotation } from '../../src/browser-annotation-content';
import type {
  NativeBridge,
  NativeCallerMetadata,
  NativeDirectory,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
import { browserFixture } from '../agent-browser.fixture';
import { annotationFixture } from '../browser-annotation.fixture';
import {
  nextDesktopPresentation,
  prepareDesktopDom,
  promptValue,
  setPromptText,
} from '../native-page-dom.fixture';

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

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline)
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  expect(check()).toBe(true);
}

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
  browser = false,
  callers: () => readonly NativeCallerMetadata[] = () => [],
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
    callerSubmissions: callers(),
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      viewGeneration: selected === 'a' ? 1 : 2,
      viewSelection: selected === 'a' ? 1 : 2,
      canReadExtensions: browser,
      canInvokeExtensions: browser,
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
      if (button!.classList.contains('session-row')) await nextDesktopPresentation(dom);
    });
  return {
    dom,
    calls,
    click,
    async chooseModel() {
      await click('选择模型');
      for (const label of ['选择模型，当前 未选择', '选择模型 model']) {
        await until(() => !!dom.window.document.querySelector(`[aria-label="${label}"]`));
        await act(async () => {
          dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click();
        });
      }
      await act(async () => {
        dom.window.document
          .querySelector('[aria-label="模型与思考程度"]')!
          .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    },
    render: (testDiagnostics = false) =>
      act(async () => root.render(<NativeDesktop testDiagnostics={testDiagnostics} />)),
    notify: (event: NativeEvent = { generation: 1, kind: 'changed' }) =>
      act(async () => {
        for (const listener of listeners) listener(event);
      }),
    assertOther() {
      expect(
        [...dom.window.document.querySelectorAll('.session-header strong')].some(
          (heading) => heading.textContent === 'Other B',
        ),
      ).toBe(true);
      expect(
        promptValue(dom.window.document.querySelector('[role="textbox"][contenteditable]')),
      ).toBe('other text');
      expect(dom.window.document.querySelector('[role="alertdialog"]') === null).toBe(true);
    },
    async close() {
      await act(async () => root.unmount());
      // FocusScope enqueues its unmount event with setTimeout(0). Wait on that same FIFO timer
      // queue before releasing this Event realm; Bun.sleep(0) only yields a microtask.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

test('100 changed notifications retain one in-flight state read and one latest successor', async () => {
  const held: ReturnType<typeof deferred<NativeResult>>[] = [];
  let active = 0,
    peak = 0,
    hold = false;
  const f = fixture((request) => {
    if (request.method !== 'state' || !hold) return undefined;
    const next = deferred<NativeResult>();
    held.push(next);
    active++;
    peak = Math.max(peak, active);
    return next.promise.finally(() => {
      active--;
    });
  });
  try {
    await f.render();
    await f.click('Original A');
    hold = true;
    for (let index = 0; index < 100; index++) await f.notify();
    expect(held).toHaveLength(1);
    expect(active).toBe(1);
    await act(async () => held[0]!.resolve(null));
    expect(held).toHaveLength(2);
    expect(active).toBe(1);
    await act(async () => held[1]!.resolve(null));
    expect(active).toBe(0);
    expect(peak).toBe(1);
    expect(f.calls.filter((request) => request.method === 'state')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('a current event state failure recovers in the background without a dialog or another event', async () => {
  let fail = false;
  const f = fixture((request) => {
    if (request.method === 'state' && fail) throw Error('native_connection_unavailable');
    return undefined;
  });
  try {
    await f.render();
    await f.click('Original A');
    const priorStateReads = f.calls.filter((request) => request.method === 'state').length;
    fail = true;
    await f.notify();
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(f.dom.window.document.body.textContent).not.toContain('native_connection_unavailable');
    fail = false;
    await until(
      () => f.calls.filter((request) => request.method === 'state').length >= priorStateReads + 2,
    );
    expect(
      promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
    ).toBe('original text');
    expect(f.calls.filter((request) => request.method === 'conversation.send')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a current select rejection retries its exact target without an external error', async () => {
  const held = deferred<NativeResult>();
  let failed = false;
  const f = fixture((request) =>
    request.method === 'select' && request.sessionId === 'a' && !failed ? held.promise : undefined,
  );
  try {
    await f.render();
    await f.click('Original A');
    expect(f.calls.filter((request) => request.method === 'select')).toHaveLength(1);
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    failed = true;
    await act(async () => held.reject(Error('native_connection_unavailable')));
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    await until(() => f.calls.filter((request) => request.method === 'select').length === 2);
    expect(
      promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
    ).toBe('original text');
    expect(
      f.calls
        .filter((request) => request.method === 'select')
        .every((request) => request.sessionId === 'a'),
    ).toBe(true);
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
    await f.render(true);
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
    expect(
      promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
    ).toBe('other text');
  } finally {
    await f.close();
  }
});

test('a mutation transport failure automatically checks the original intent without another POST', async () => {
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
    await f.chooseModel();
    await act(async () => {
      await setPromptText(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="新对话草稿"]')!,
        'first prepared message',
      );
    });
    await f.click('发送首条消息');
    expect(submitted).toBeDefined();
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    await until(() => f.calls.some((request) => request.method === 'conversation.lookup'));
    const lookups = f.calls.filter((request) => request.method === 'conversation.lookup');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.commandId).toBe(submitted!.intent.commandId);
    expect(f.calls.filter((request) => request.method === 'conversation.send')).toHaveLength(1);
    expect(
      [...f.dom.window.document.querySelectorAll('button')].some(
        (button) => button.textContent === '查询原首次提交',
      ),
    ).toBe(false);
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

for (const method of ['state', 'directory'] as const)
  test(`normal quit retires the pending ${method} display, pauses refresh and cancel restores the same draft without mutation`, async () => {
    const held = deferred<NativeResult>();
    let hold = false;
    const f = fixture((request) => (request.method === method && hold ? held.promise : undefined));
    try {
      await f.render(method === 'directory');
      await f.click('Original A');
      hold = true;
      if (method === 'state') await f.notify();
      else await f.click('重新读取目录');
      const callsBeforeQuit = f.calls.filter((request) => request.method === 'state').length;
      await f.notify({ kind: 'lifecycle', phase: 'quitting' });
      await act(async () => held.reject(Error('native_draining')));
      expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(
        promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
      ).toBe('original text');
      await f.notify();
      expect(f.calls.filter((request) => request.method === 'state')).toHaveLength(callsBeforeQuit);
      hold = false;
      await f.notify({ kind: 'lifecycle', phase: 'active' });
      expect(f.calls.filter((request) => request.method === 'state').length).toBeGreaterThan(
        callsBeforeQuit,
      );
      expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(
        promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
      ).toBe('original text');
      expect(f.calls.filter((request) => request.method === 'attach')).toHaveLength(1);
      expect(f.calls.filter((request) => request.method === 'conversation.send')).toHaveLength(0);
      expect(f.calls.filter((request) => request.method === 'draft.write')).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('a temporary native_draining observation automatically retries without a failure dialog', async () => {
  let fail = false;
  const f = fixture((request) => {
    if (request.method === 'state' && fail) throw Error('native_draining');
    return undefined;
  });
  try {
    await f.render();
    await f.click('Original A');
    const priorStateReads = f.calls.filter((request) => request.method === 'state').length;
    fail = true;
    await f.notify();
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    fail = false;
    await until(
      () => f.calls.filter((request) => request.method === 'state').length >= priorStateReads + 2,
    );
    expect(f.calls.filter((request) => request.method === 'attach')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const method of ['select', 'draft.read'] as const)
  test(`cancelled quit resumes the retired ${method} read without clearing the original private draft`, async () => {
    const held = deferred<NativeResult>();
    let hold = false;
    const f = fixture((request) =>
      request.method === method && request.sessionId === 'a' && hold ? held.promise : undefined,
    );
    try {
      await f.render();
      await f.click('Original A');
      await f.click('Other B');
      hold = true;
      await f.click('Original A');
      expect(
        f.calls.filter((request) => request.method === method && request.sessionId === 'a'),
      ).toHaveLength(2);
      await f.notify({ kind: 'lifecycle', phase: 'quitting' });
      await act(async () => held.reject(Error('native_draining')));
      expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
      hold = false;
      await f.notify({ kind: 'lifecycle', phase: 'active' });
      expect(
        promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
      ).toBe('original text');
      expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(f.calls.filter((request) => request.method === 'attach')).toHaveLength(1);
      expect(f.calls.filter((request) => request.method === 'conversation.send')).toHaveLength(0);
      expect(f.calls.filter((request) => request.method === 'draft.write')).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('an already submitted mutation keeps its unknown receipt through quit and cancel without another POST', async () => {
  const held = deferred<NativeResult>();
  let submitted: Extract<NativeRequest, { method: 'conversation.send' }> | undefined;
  const f = fixture((request) => {
    if (request.method === 'conversation.send') {
      submitted = request;
      return held.promise;
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
    await f.chooseModel();
    await act(async () => {
      await setPromptText(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="新对话草稿"]')!,
        'first prepared message',
      );
    });
    await f.click('发送首条消息');
    expect(submitted).toBeDefined();
    await f.notify({ kind: 'lifecycle', phase: 'quitting' });
    await act(async () => held.reject(Error('network_outcome_unknown')));
    expect(f.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(f.calls.filter((request) => request.method === 'conversation.lookup')).toHaveLength(0);
    await f.notify({ kind: 'lifecycle', phase: 'active' });
    await until(() => f.calls.some((request) => request.method === 'conversation.lookup'));
    const lookups = f.calls.filter((request) => request.method === 'conversation.lookup');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.commandId).toBe(submitted!.intent.commandId);
    expect(f.calls.filter((request) => request.method === 'conversation.send')).toHaveLength(1);
    expect(
      [...f.dom.window.document.querySelectorAll('button')].some(
        (button) => button.textContent === '查询原首次提交',
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('private draft save is test-only and retains its original scope and CAS while history is still reading', async () => {
  const history = deferred<NativeResult>();
  const savedReply = deferred<NativeResult>();
  const raw = '  原私有草稿🙂\r\n保留 空格  ';
  const saves: Extract<NativeRequest, { method: 'draft.write' }>[] = [];
  const f = fixture((request) => {
    if (request.method === 'messages' && request.sessionId === 'a') return history.promise;
    if (request.method === 'draft.read' && request.sessionId === 'a')
      return {
        id: 'a',
        storeId: 'store',
        workspaceId: 'w',
        rootSessionId: 'a',
        revision: 7,
        content: raw,
      };
    if (request.method === 'draft.write') {
      saves.push(request);
      if (request.sessionId === 'a') return savedReply.promise;
      return {
        id: 'b',
        storeId: 'store',
        workspaceId: 'w',
        rootSessionId: 'b',
        revision: 2,
        content: request.content,
      };
    }
    return undefined;
  });
  try {
    await f.render();
    await f.click('Original A');
    expect(
      f.calls.some((request) => request.method === 'messages' && request.sessionId === 'a'),
    ).toBe(true);
    expect(f.dom.window.document.body.textContent).not.toContain(
      '历史已完整读取至固定高水位；当前执行事实仍须核实。',
    );
    expect(
      promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
    ).toBe(raw.replaceAll('\r\n', '\n'));
    expect(
      [...f.dom.window.document.querySelectorAll('button')].some(
        (candidate) => candidate.textContent === '保留草稿',
      ),
    ).toBe(false);
    expect(saves).toEqual([]);
    await f.render(true);
    const button = [...f.dom.window.document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === '保留草稿',
    )!;
    expect(button.disabled).toBe(false);
    await f.click('保留草稿');
    expect(saves).toEqual([
      { method: 'draft.write', generation: 1, sessionId: 'a', revision: 7, content: raw },
    ]);
    await f.click('Other B');
    expect(
      promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
    ).toBe('other text');
    await act(async () =>
      savedReply.resolve({
        id: 'a',
        storeId: 'store',
        workspaceId: 'w',
        rootSessionId: 'a',
        revision: 8,
        content: raw,
      }),
    );
    f.assertOther();
    await f.click('保留草稿');
    expect(saves[1]).toEqual({
      method: 'draft.write',
      generation: 1,
      sessionId: 'b',
      revision: 1,
      content: 'other text',
    });
    expect(
      f.calls.some((request) =>
        ['submit', 'conversation.send', 'interaction.answer', 'cancelInput'].includes(
          request.method,
        ),
      ),
    ).toBe(false);
  } finally {
    history.resolve({ messages: [], nextAfterSeq: null, highWaterSeq: '0' });
    savedReply.resolve({
      id: 'a',
      storeId: 'store',
      workspaceId: 'w',
      rootSessionId: 'a',
      revision: 8,
      content: raw,
    });
    await f.close();
  }
});

test('actual Native page keeps prompt separate, saves annotation metadata, scopes cards across sessions and seals one unknown send', async () => {
  const browser = browserFixture();
  browser.scope = {
    generation: 1,
    viewSelection: 1,
    historyEpoch: 0,
    storeId: 'store',
    workspaceId: 'w',
    sessionId: 'a',
    contextSelectionId: 'context-a',
  };
  const images = new NativeInputImages();
  const drafts = new Map<
    string,
    {
      revision: number;
      content: string;
      browserAnnotations?: readonly BrowserSavedAnnotation[];
      annotationImageOffset?: number;
    }
  >([
    ['a', { revision: 1, content: 'original text' }],
    ['b', { revision: 1, content: 'other text' }],
  ]);
  const submitted: Extract<NativeRequest, { method: 'submit' }>[] = [];
  const f = fixture((request) => {
    if (request.method.startsWith('extensions.')) return browser.bridge.request(request);
    if (request.method === 'input.images.begin') {
      images.begin(request);
      return null;
    }
    if (request.method === 'input.images.append') {
      images.append(request.id, request.offset, request.data);
      return null;
    }
    if (request.method === 'input.images.finish') {
      images.finish(request.id);
      return null;
    }
    if (request.method === 'input.images.release') {
      images.release(request.id);
      return null;
    }
    if (request.method === 'draft.read')
      return {
        id: 'a'.repeat(64),
        storeId: 'store',
        workspaceId: 'w',
        rootSessionId: request.sessionId,
        ...drafts.get(request.sessionId)!,
      };
    if (request.method === 'draft.write') {
      const previous = drafts.get(request.sessionId)!;
      if (previous.revision !== request.revision) throw Error('draft_revision_conflict');
      const saved = {
        content: request.content,
        revision: request.revision + 1,
        browserAnnotations: request.browserAnnotations,
        annotationImageOffset: request.annotationImageOffset,
      };
      drafts.set(request.sessionId, saved);
      return {
        id: 'a'.repeat(64),
        storeId: 'store',
        workspaceId: 'w',
        rootSessionId: request.sessionId,
        ...saved,
      };
    }
    if (request.method === 'submit') {
      submitted.push(request);
      return {
        sessionId: request.sessionId,
        intent: {
          kind: request.intent.kind,
          commandId: request.intent.commandId,
          expectedStoreId: request.intent.expectedStoreId,
        },
        phase: submitted.length === 1 ? 'failed' : 'unknown',
      };
    }
    return undefined;
  }, true);
  try {
    await f.render();
    await f.click('Original A');
    await f.chooseModel();
    await f.click('Agent 浏览器');
    await until(() => !!f.dom.window.document.querySelector('.agent-browser-frame img'));
    const image = f.dom.window.document.querySelector<HTMLImageElement>(
      '.agent-browser-frame img',
    )!;
    image.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 400, 300);
    await act(async () => image.dispatchEvent(new f.dom.window.Event('load')));
    await f.click('⌖ 指向元素');
    await act(async () =>
      f.dom.window.document
        .querySelector('.agent-browser-frame')!
        .dispatchEvent(
          new f.dom.window.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 70 }),
        ),
    );
    const note =
      f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        f.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(note, '关注按钮的具体说明');
      note.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    });
    await f.click('加入提示词');
    await until(() => !!drafts.get('a')?.browserAnnotations?.length);
    expect(
      promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
    ).toBe('original text');
    expect(f.dom.window.document.querySelector('.browser-note-context')?.textContent).toContain(
      '1 条网页注释',
    );
    expect(JSON.stringify(drafts.get('a'))).not.toContain('/9j/2Q==');
    const prepares = f.calls.filter((request) => request.method === 'input.images.begin').length;
    await f.click('编辑');
    const editor =
      f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="编辑注释"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        f.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(editor, '编辑后注释全文');
      editor.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    });
    await f.click('保存');
    await until(() => drafts.get('a')?.browserAnnotations?.[0]?.version === 2);
    expect(f.calls.filter((request) => request.method === 'input.images.begin')).toHaveLength(
      prepares,
    );
    await f.click('Other B');
    expect(f.dom.window.document.querySelector('.browser-note-context')).toBeNull();
    await f.click('Original A');
    expect(f.dom.window.document.querySelector('.browser-note-context')?.textContent).toContain(
      '编辑后注释全文',
    );
    await f.click('发送明确的新轮次');
    await until(() => submitted.length === 1);
    expect(submitted[0]!.intent.content).toContain('original text');
    expect(submitted[0]!.intent.content).toContain('编辑后注释全文');
    expect(submitted[0]!.imageIds).toHaveLength(1);
    await until(
      () =>
        !f.dom.window.document
          .querySelector('.browser-note-context')
          ?.textContent?.includes('正在提交'),
    );
    expect(f.dom.window.document.querySelector('.browser-note-context')?.textContent).toContain(
      '编辑后注释全文',
    );
    await act(async () =>
      setPromptText(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')!, ''),
    );
    await f.click('发送明确的新轮次');
    await until(() => submitted.length === 2);
    expect(submitted[1]!.intent.content).toContain('编辑后注释全文');
    expect(submitted[1]!.intent.content).not.toContain('original text');
    await until(
      () =>
        f.dom.window.document
          .querySelector('.browser-note-context')
          ?.textContent?.includes('原发送结果待核实') === true,
    );
    const send = [...f.dom.window.document.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === '发送明确的新轮次',
    )!;
    expect(send.disabled).toBe(true);
    send.click();
    expect(submitted).toHaveLength(2);
    expect(browser.submitted).toHaveLength(0); // Pointer never pauses or clicks the webpage.
    expect(f.dom.window.document.querySelector('.browser-note-context')?.textContent).toContain(
      '编辑后注释全文',
    );
  } finally {
    await f.close();
    images.close();
  }
});

test('cold unknown annotation keeps missing pixels and locks cards; accepted original receipt preserves and saves newer prompt', async () => {
  const { saved: note } = annotationFixture();
  let phase: 'unknown' | 'accepted' = 'unknown',
    revision = 1;
  const saved = {
    id: 'a'.repeat(64),
    storeId: 'store',
    workspaceId: 'w',
    rootSessionId: 'a',
    revision: 1,
    content: 'cold original',
    browserAnnotations: [note],
    annotationImageOffset: 0,
  };
  const proof = nativeDraftProof(saved),
    writes: Extract<NativeRequest, { method: 'draft.write' }>[] = [];
  const f = fixture(
    (request) => {
      if (request.method === 'draft.read' && request.sessionId === 'a') return saved;
      if (request.method === 'draft.write') {
        expect(request.revision).toBe(revision);
        revision++;
        writes.push(request);
        return {
          ...saved,
          content: request.content,
          browserAnnotations: request.browserAnnotations,
          annotationImageOffset: request.annotationImageOffset,
          revision,
        };
      }
      return undefined;
    },
    false,
    () => [
      {
        scope: { storeId: 'store', workspaceId: 'w', sessionId: 'a' },
        request: { kind: 'run.start', expectedStoreId: 'store', commandId: 'cold-original' },
        subjectId: 'owner',
        target: { kind: 'session', id: 'a' },
        bodyDigest: 'b'.repeat(64),
        requestDigest: 'c'.repeat(64),
        draft: proof,
        phase,
      },
    ],
  );
  try {
    await f.render();
    await f.click('Original A');
    expect(f.dom.window.document.querySelector('.browser-note-context')?.textContent).toContain(
      '快照未恢复',
    );
    expect(f.dom.window.document.querySelector('.browser-note-context')?.textContent).toContain(
      '原发送结果待核实',
    );
    const remove = [...f.dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === '删除',
    )!;
    expect(remove.disabled).toBe(true);
    expect(f.calls.filter((request) => request.method.startsWith('input.images.'))).toHaveLength(0);
    await act(async () =>
      setPromptText(
        f.dom.window.document.querySelector('[role="textbox"][contenteditable]')!,
        'newer edit',
      ),
    );
    phase = 'accepted';
    revision = 2;
    await f.notify();
    await until(() => writes.some((write) => write.content === 'newer edit'));
    expect(f.dom.window.document.querySelector('.browser-note-card')).toBeNull();
    expect(
      promptValue(f.dom.window.document.querySelector('[role="textbox"][contenteditable]')),
    ).toBe('newer edit');
    expect(writes.at(-1)!.browserAnnotations).toEqual([]);
    expect(f.calls.filter((request) => request.method === 'submit')).toHaveLength(0);
  } finally {
    await f.close();
  }
});
