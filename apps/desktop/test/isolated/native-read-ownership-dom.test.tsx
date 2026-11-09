import { expect, test } from 'bun:test';
import type { Interaction, Session } from '@kite-ai/client';
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
import type { NativeBrowserBridge, NativeBrowserState } from '../../src/native-browser-bridge';
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
          // These cases exercise an explicit sidebar selection. A restored A
          // would make startup await the deliberately held select/draft read
          // before it can read the directory and expose that sidebar.
          return { ...snapshot(), selection: undefined };
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
                reasoningEffortChoices: ['medium'],
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
    snapshot,
    async chooseModel() {
      await act(async () => nextDesktopPresentation(dom));
      await until(() => {
        const trigger =
          dom.window.document.querySelector<HTMLButtonElement>('[data-model-trigger]');
        return !!trigger && !trigger.disabled && trigger.dataset.readGated !== 'true';
      });
      await click('选择模型');
      await until(() => !!dom.window.document.querySelector('[aria-label^="选择模型，当前 "]'));
      await act(async () =>
        dom.window.document
          .querySelector<HTMLButtonElement>('[aria-label^="选择模型，当前 "]')!
          .click(),
      );
      await until(() => !!dom.window.document.querySelector('[aria-label="选择模型 model"]'));
      await act(async () =>
        dom.window.document.querySelector<HTMLElement>('[aria-label="选择模型 model"]')!.click(),
      );
      await act(async () => {
        dom.window.document
          .querySelector('[aria-label="模型与思考程度"]')!
          .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    },
    async render(testDiagnostics = false, expectStartupFailure = false) {
      await act(async () => root.render(<NativeDesktop testDiagnostics={testDiagnostics} />));
      if (!expectStartupFailure)
        await until(
          () =>
            calls.some((request) => request.method === 'directory') &&
            [...dom.window.document.querySelectorAll('button.session-row')].some(
              (button) => button.textContent === 'Original A',
            ),
        );
    },
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
        promptValue(
          dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
        ),
      ).toBe('other text');
      expect(dom.window.document.querySelector('[role="alertdialog"]') === null).toBe(true);
      expect(dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
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
    if (request.method === 'state' && fail) throw Error('network_outcome_unknown');
    return undefined;
  });
  try {
    await f.render();
    await f.click('Original A');
    const priorStateReads = f.calls.filter((request) => request.method === 'state').length;
    fail = true;
    await f.notify();
    expect(f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
    expect(f.dom.window.document.body.textContent).not.toContain('network_outcome_unknown');
    fail = false;
    await until(
      () => f.calls.filter((request) => request.method === 'state').length >= priorStateReads + 2,
    );
    expect(
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
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
    expect(f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
    failed = true;
    await act(async () => held.reject(Error('network_outcome_unknown')));
    expect(f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
    await until(() => f.calls.filter((request) => request.method === 'select').length === 2);
    expect(
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
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

test('a diagnostic directory failure recovers after a same-generation session switch without a toast', async () => {
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
    await act(async () => held.resolve(null));
    expect(f.dom.window.document.querySelector('.native-toast') === null).toBe(true);
    hold = false;
    await until(() => f.calls.filter((request) => request.method === 'directory').length >= 3);
    f.assertOther();
    expect(f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
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
    expect(f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
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
    await f.render(false, true);
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
      expect(
        f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]'),
      ).toBeNull();
      expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
      expect(
        promptValue(
          f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
        ),
      ).toBe('original text');
      await f.notify();
      expect(f.calls.filter((request) => request.method === 'state')).toHaveLength(callsBeforeQuit);
      hold = false;
      await f.notify({ kind: 'lifecycle', phase: 'active' });
      expect(f.calls.filter((request) => request.method === 'state').length).toBeGreaterThan(
        callsBeforeQuit,
      );
      expect(
        f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]'),
      ).toBeNull();
      expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
      expect(
        promptValue(
          f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
        ),
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
    expect(f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
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
      expect(
        f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]'),
      ).toBeNull();
      expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
      hold = false;
      await f.notify({ kind: 'lifecycle', phase: 'active' });
      expect(
        promptValue(
          f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
        ),
      ).toBe('original text');
      expect(
        f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]'),
      ).toBeNull();
      expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
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
    expect(f.dom.window.document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(f.dom.window.document.querySelector('.native-toast [role="status"]')).toBeNull();
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
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
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
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
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
  const page: NativeBrowserState = {
    id: 'ordinary-a',
    title: 'Example page',
    url: 'https://example.test/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    control: {
      phase: 'agent',
      sessionId: 'a',
      incarnation: 'page-a',
      browserId: 'browser',
      navigation: 0,
    },
  };
  Object.assign(f.dom.window.kiteNative!, {
    async restoreBrowser(scope) {
      return { scope: { ...scope }, page: scope.sessionId === 'a' ? page : null };
    },
    async browserRequest(request) {
      return request.action === 'state' ? page : null;
    },
    watchBrowser() {
      return () => {};
    },
  } satisfies NativeBrowserBridge);
  try {
    await f.render();
    await f.click('Original A');
    await f.chooseModel();
    await f.click('标签页');
    await until(() => !!f.dom.window.document.querySelector('[aria-label="指向注释"]'));
    await f.click('指向注释');
    await until(() => !!f.dom.window.document.querySelector('.agent-browser-frame img'));
    const image = f.dom.window.document.querySelector<HTMLImageElement>(
      '.agent-browser-frame img',
    )!;
    image.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 400, 300);
    await act(async () => image.dispatchEvent(new f.dom.window.Event('load')));
    await until(() => !!f.dom.window.document.querySelector('.agent-browser-frame.is-pointing'));
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
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
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
      setPromptText(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]')!,
        '',
      ),
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
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]')!,
        'newer edit',
      ),
    );
    phase = 'accepted';
    revision = 2;
    await f.notify();
    await until(() => writes.some((write) => write.content === 'newer edit'));
    expect(f.dom.window.document.querySelector('.browser-note-card')).toBeNull();
    expect(
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
    ).toBe('newer edit');
    expect(writes.at(-1)!.browserAnnotations).toEqual([]);
    expect(f.calls.filter((request) => request.method === 'submit')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a cached unavailable selection rereads the same activation and retires an accepted approval without replaying writes', async () => {
  let unavailable = false,
    recovered = false;
  let originalState!: () => NativeState;
  const card: Interaction = {
    id: 'original-approval',
    originStoreId: 'store',
    sessionId: 'a',
    runId: 'run',
    executionId: 'tool',
    presentationSessionId: 'a',
    ancestry: ['a'],
    attempt: 1,
    kind: 'approval',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    inputDigest: 'input',
    policyRevision: 'policy',
    requiredRefs: [],
    request: {
      definitionId: 'shell.execute',
      definitionVersion: '1',
      input: { command: 'printf exact' },
      options: [{ kind: 'once', optionId: 'once', presentation: { label: '仅此次', details: [] } }],
    },
    answer: null,
    revision: '1',
    acceptedDecisionRevision: null,
    state: 'pending',
  };
  const stale = (): NativeState => {
    const value = originalState();
    return {
      ...value,
      selection: { ...value.selection!, permissionUnavailable: true, interactions: [card] },
      interactionSubmissions: [
        {
          interaction: card,
          intent: {
            expectedStoreId: 'store',
            commandId: 'original-answer',
            expectedRevision: '1',
            answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
          },
          phase: 'accepted',
        },
      ],
    };
  };
  const f = fixture((request) => {
    // Main state remains a cache. Only the exact original select retry can refresh its source.
    if (request.method === 'state' && unavailable && !recovered) return stale();
    if (request.method === 'select' && unavailable) {
      recovered = true;
      const value = originalState();
      return { ...value, selection: { ...value.selection!, viewGeneration: 3 } };
    }
    return undefined;
  });
  originalState = f.snapshot;
  try {
    await f.render();
    await f.click('Original A');
    await act(async () => {
      await setPromptText(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]')!,
        'newer private 🙂',
      );
    });
    const activation = f.calls.find((request) => request.method === 'select')!;
    unavailable = true;
    await f.notify();
    expect(f.dom.window.document.body.textContent).toContain('审批回答已保存，等待执行。');
    await until(
      () =>
        recovered &&
        !f.dom.window.document.querySelector('[aria-label="approval original-approval"]'),
    );
    const selects = f.calls.filter((request) => request.method === 'select');
    expect(selects).toHaveLength(2);
    expect(selects[1]).toEqual(activation);
    expect(
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
    ).toBe('newer private 🙂');
    expect(
      f.calls.filter((request) =>
        [
          'interaction.answer',
          'conversation.send',
          'input',
          'caller.submit',
          'cancelInput',
          'permission.mode',
          'permission.trust',
        ].includes(request.method),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('failed selection and unavailable observation share one read while the original unknown answer can recover', async () => {
  const held = deferred<NativeResult>();
  const selectionStarted = deferred<void>();
  let failing = false,
    unavailable = false,
    selectionReads = 0,
    lookups = 0;
  let answerPhase: 'unknown' | 'accepted' = 'unknown';
  let f!: ReturnType<typeof fixture>;
  const card: Interaction = {
    id: 'original-approval',
    originStoreId: 'store',
    sessionId: 'a',
    runId: 'run',
    executionId: 'tool',
    presentationSessionId: 'a',
    ancestry: ['a'],
    attempt: 1,
    kind: 'approval',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    inputDigest: 'input',
    policyRevision: 'policy',
    requiredRefs: [],
    request: {
      options: [{ kind: 'once', optionId: 'once', presentation: { label: '仅此次', details: [] } }],
    },
    answer: null,
    revision: '1',
    acceptedDecisionRevision: null,
    state: 'pending',
  };
  const stale = (): NativeState => {
    const value = f.snapshot();
    return {
      ...value,
      selection: { ...value.selection!, permissionUnavailable: true },
      interactionSubmissions: [
        {
          interaction: card,
          intent: {
            expectedStoreId: 'store',
            commandId: 'original-answer',
            expectedRevision: '1',
            answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
          },
          phase: answerPhase,
        },
      ],
    };
  };
  f = fixture((request) => {
    if (request.method === 'select' && failing) {
      failing = false;
      unavailable = true;
      throw Error('original_selection_read_failed');
    }
    if (request.method === 'select' && unavailable) {
      selectionReads++;
      selectionStarted.resolve(undefined);
      return held.promise;
    }
    if (request.method === 'state' && unavailable) return stale();
    if (request.method === 'lookupInteraction') {
      expect(request.commandId).toBe('original-answer');
      return selectionStarted.promise.then(() => {
        lookups++;
        answerPhase = 'accepted';
        return null;
      });
    }
    return undefined;
  });
  try {
    await f.render();
    failing = true;
    await f.click('Original A');
    const activation = f.calls.filter((request) => request.method === 'select').at(-1)!;
    await f.notify();
    // Neither recovery reason may consume the second slot needed by the saved answer.
    // The selected read remains held until after the original lookup has completed.
    await until(() => lookups > 0 || selectionReads > 1);
    expect({ selectionReads, lookups }).toEqual({ selectionReads: 1, lookups: 1 });
    expect(stale().interactionSubmissions[0]?.phase).toBe('accepted');
    const selects = f.calls.filter((request) => request.method === 'select');
    expect(selects).toHaveLength(2); // failed activation, one held retry
    expect(selects.at(-1)).toEqual(activation);
    unavailable = false;
    await act(async () => held.resolve(f.snapshot()));
    await until(
      () =>
        f.dom.window.document.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled ===
        false,
    );
    expect(selectionReads).toBe(1);
    expect(lookups).toBe(1);
    expect(
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
    ).toBe('original text');
    const reads = new Set([
      'attach',
      'state',
      'directory',
      'select',
      'draft.read',
      'conversation.models.read',
      'input.models.read',
      'conversation.branch',
      'messages',
      'messages.close',
      'background.open',
      'background.close',
      'lookupInteraction',
    ]);
    expect(f.calls.filter((request) => !reads.has(request.method))).toEqual([]);
  } finally {
    held.resolve(f.snapshot());
    await f.close();
  }
});

for (const recoveredDependency of ['directory', 'answer'] as const) {
  test(`an unavailable directory published by state recovers after ${recoveredDependency} without replaying the original answer`, async () => {
    const held = deferred<NativeResult>();
    let outage = false,
      directoryUnavailable = true,
      directoryReads = 0,
      selectionReads = 0,
      lookups = 0;
    let answerPhase: 'unknown' | 'accepted' = 'unknown';
    let f!: ReturnType<typeof fixture>;
    const card: Interaction = {
      id: 'next-job-approval',
      originStoreId: 'store',
      sessionId: 'a',
      runId: 'run',
      executionId: 'job',
      presentationSessionId: 'a',
      ancestry: ['a'],
      attempt: 1,
      kind: 'approval',
      definitionId: 'shell.command',
      definitionVersion: '1',
      inputDigest: 'input',
      policyRevision: 'policy',
      requiredRefs: [],
      request: {
        definitionId: 'shell.command',
        definitionVersion: '1',
        input: { command: 'printf exact' },
        options: [
          { kind: 'once', optionId: 'once', presentation: { label: '仅此次', details: [] } },
        ],
      },
      answer: null,
      revision: '1',
      acceptedDecisionRevision: null,
      state: 'pending',
    };
    f = fixture((request) => {
      if (outage && (request.method === 'state' || request.method === 'select')) {
        if (request.method === 'select') selectionReads++;
        const value = f.snapshot();
        return {
          ...value,
          directory: { ...directory, unavailable: directoryUnavailable },
          selection: {
            ...value.selection!,
            permissionUnavailable: directoryUnavailable,
            interactions: [card],
          },
          interactionSubmissions: [
            {
              interaction: { ...card, id: 'original-tool-approval', executionId: 'tool' },
              intent: {
                expectedStoreId: 'store',
                commandId: 'original-answer',
                expectedRevision: '1',
                answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
              },
              phase: answerPhase,
            },
          ],
        };
      }
      if (request.method === 'directory' && outage) {
        directoryReads++;
        if (recoveredDependency === 'answer') {
          if (answerPhase === 'unknown') return { ...directory, unavailable: true };
          directoryUnavailable = false;
          return directory;
        }
        return held.promise.then((value) => {
          directoryUnavailable = false;
          return value;
        });
      }
      if (request.method === 'lookupInteraction') {
        expect(request.commandId).toBe('original-answer');
        lookups++;
        if (recoveredDependency === 'answer')
          return held.promise.then(() => {
            answerPhase = 'accepted';
            return null;
          });
        answerPhase = 'accepted';
        return null;
      }
      return undefined;
    });
    const approve = () =>
      [...f.dom.window.document.querySelectorAll('button')].find(
        (button) => button.textContent === '仅此次',
      );
    try {
      await f.render();
      await f.click('Original A');
      outage = true;
      await f.notify();
      await until(() => !!approve());
      expect(approve()!.disabled).toBe(true);
      // The other dependency has already backed off before the held read succeeds.
      await until(
        () =>
          directoryReads >= (recoveredDependency === 'answer' ? 2 : 1) &&
          lookups > 0 &&
          selectionReads >= 2,
        4500,
      );
      if (recoveredDependency === 'directory') expect(directoryReads).toBe(1);
      await act(async () => held.resolve(directory));
      await until(() => approve()?.disabled === false, 1500);
      expect(
        promptValue(
          f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
        ),
      ).toBe('original text');
      expect(
        f.calls.filter((request) =>
          ['interaction.answer', 'conversation.send', 'caller.submit', 'permission.mode'].includes(
            request.method,
          ),
        ),
      ).toEqual([]);
    } finally {
      held.resolve(directory);
      await f.close();
    }
  }, 10000);
}

test('same-scope observation recovery preserves an outstanding complete history scan across retries', async () => {
  const messages = deferred<NativeResult>();
  const heldSelection = deferred<NativeResult>();
  let unavailable = false,
    recovered = false,
    hold = true,
    reads = 0;
  let originalState!: () => NativeState;
  const f = fixture((request) => {
    if (request.method === 'messages') {
      reads++;
      if (hold) return messages.promise;
    }
    if (request.method === 'state' && unavailable) {
      const value = originalState();
      return { ...value, selection: { ...value.selection!, permissionUnavailable: !recovered } };
    }
    if (request.method === 'select' && unavailable) {
      recovered = true;
      return heldSelection.promise;
    }
    return undefined;
  });
  originalState = f.snapshot;
  try {
    await f.render();
    await f.click('Original A');
    await until(() => reads === 1);
    const activation = f.calls.find((request) => request.method === 'select')!;
    unavailable = true;
    await f.notify();
    await until(() => recovered);
    // Main can publish state while the same activation's retry is still pending.
    // That notification must gate actions without canceling the ongoing history scan.
    const closed = f.calls.filter((request) => request.method === 'messages.close').length;
    await f.notify();
    expect(f.calls.filter((request) => request.method === 'messages.close')).toHaveLength(closed);
    await act(async () => heldSelection.resolve(originalState()));
    // A second scheduled observation must reuse the original scan while its read is slow.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300));
    });
    expect(reads).toBe(1);
    expect(f.calls.filter((request) => request.method === 'select').length).toBeGreaterThanOrEqual(
      3,
    );
    expect(
      f.calls
        .filter((request) => request.method === 'select')
        .every((request) => JSON.stringify(request) === JSON.stringify(activation)),
    ).toBe(true);
    expect(
      promptValue(
        f.dom.window.document.querySelector('[role="textbox"][aria-label="当前会话私有草稿"]'),
      ),
    ).toBe('original text');
    hold = false;
    await act(async () =>
      messages.resolve({ messages: [], nextAfterSeq: null, highWaterSeq: '0' }),
    );
    expect(
      f.calls.filter(
        (request) =>
          request.method === 'interaction.answer' || request.method === 'conversation.send',
      ),
    ).toHaveLength(0);
  } finally {
    heldSelection.resolve(originalState());
    await f.close();
  }
});

test('a history epoch change revokes a held same-session recovery scan', async () => {
  const messages = deferred<NativeResult>();
  const heldSelection = deferred<NativeResult>();
  let recovering = false,
    started = false,
    epoch = 0;
  let f!: ReturnType<typeof fixture>;
  const snapshot = (): NativeState => ({ ...f.snapshot(), historyEpoch: epoch });
  f = fixture((request) => {
    if (request.method === 'messages') return messages.promise;
    if (request.method === 'state' && recovering) {
      const value = snapshot();
      return { ...value, selection: { ...value.selection!, permissionUnavailable: true } };
    }
    if (request.method === 'select' && recovering) {
      started = true;
      return heldSelection.promise;
    }
    return undefined;
  });
  try {
    await f.render();
    await f.click('Original A');
    await until(() => f.calls.some((request) => request.method === 'messages'));
    recovering = true;
    await f.notify();
    await until(() => started);
    const closed = f.calls.filter((request) => request.method === 'messages.close').length;
    epoch++;
    await f.notify();
    expect(f.calls.filter((request) => request.method === 'messages.close')).toHaveLength(
      closed + 1,
    );
    recovering = false;
    await act(async () => heldSelection.resolve(snapshot()));
  } finally {
    heldSelection.resolve(snapshot());
    messages.resolve({ messages: [], nextAfterSeq: null, highWaterSeq: '0' });
    await f.close();
  }
});

test('ordinary Native permission menu owns the complete grant directory and original unknown clear without exposing diagnostics', async () => {
  let target = 'a',
    unknown = false;
  let f!: ReturnType<typeof fixture>;
  const held = deferred<NativeResult>();
  let holdRead = false;
  const facts = (sessionId: string) => ({
    observationId: sessionId === 'a' ? 31 : 32,
    page: {
      storeId: 'store',
      sessionId,
      revision: '4',
      snapshotCursor: '4',
      highWaterSeq: '1',
      upperSeq: '1',
      nextAfterSeq: null,
      items: [
        {
          seq: '1',
          grant: {
            id: 'grant-a',
            originStoreId: 'store',
            sessionId,
            workspaceId: 'w',
            kind: 'tool' as const,
            definitionId: 'fixture.command',
            definitionVersion: '1',
            inputDigest: 'input-digest',
            interactionId: 'original-approval',
            decisionRevision: '2',
            executionId: 'original-execution',
            ruleId: 'fixture.rule',
            contractId: 'fixture.scope',
            scope: { resource: '/exact/resource', command: 'safe append' },
            scopeDigest: 'scope-digest',
            bindings: [
              { kind: 'tool' as const, definitionId: 'fixture.command', definitionVersion: '1' },
            ],
            presentation: {
              label: '当前会话准确资源',
              details: ['完整资源范围说明', '最后一条完整出处'],
            },
          },
        },
      ],
    },
  });
  const snapshot = (): NativeState => {
    const value = f.snapshot();
    return {
      ...value,
      grantSubmissions: unknown
        ? [
            {
              sessionId: 'a',
              workspaceId: 'w',
              observationId: 31,
              intent: { expectedStoreId: 'store', commandId: 'original-clear', ifRevision: '4' },
              phase: 'unknown',
            },
          ]
        : [],
      selection: {
        ...value.selection!,
        session: sessions.find((s) => s.id === target)!,
        viewSelection: target === 'a' ? 1 : 2,
        viewGeneration: target === 'a' ? 1 : 2,
        canReadPermissionGrants: true,
        permissions: {
          observationId: 1,
          mode: {
            storeId: 'store',
            sessionId: target,
            scopeSessionId: target,
            mode: 'auto',
            revision: '1',
            defaultMode: 'auto',
            defaultRevision: '1',
          },
          trust: {
            storeId: 'store',
            workspaceId: 'w',
            status: 'trusted',
            trusted: true,
            revision: '1',
            canonicalIdentity: 'a'.repeat(64),
            externalReadScopeDigest: 'b'.repeat(64),
            readScopes: [{ kind: 'workspace', description: 'Workspace' }],
          },
        },
      },
    };
  };
  f = fixture((request) => {
    if (request.method === 'select') {
      target = request.sessionId;
      return snapshot();
    }
    if (request.method === 'state') return snapshot();
    if (request.method === 'grants.read') return holdRead ? held.promise : facts(request.sessionId);
    if (request.method === 'grants.clear') {
      unknown = true;
      return null;
    }
    if (request.method === 'lookupGrant') {
      unknown = false;
      return null;
    }
    return undefined;
  });
  async function open() {
    await until(
      () => !!f.dom.window.document.querySelector('[data-permission-trigger]:not([disabled])'),
    );
    await act(async () =>
      f.dom.window.document.querySelector('[data-permission-trigger]')!.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await until(() =>
      [...f.dom.window.document.querySelectorAll('[role="menuitem"]')].some((e) =>
        ['当前会话授权', 'Current session grants'].includes(e.textContent ?? ''),
      ),
    );
    await act(async () =>
      [...f.dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((e) => ['当前会话授权', 'Current session grants'].includes(e.textContent ?? ''))!
        .click(),
    );
    await until(() => !!f.dom.window.document.querySelector('[aria-label="当前会话授权目录"]'));
  }
  try {
    await f.render(false);
    await f.click('Original A');
    await open();
    expect(f.dom.window.document.body.textContent).not.toContain('会话工具');
    expect(f.dom.window.document.body.textContent).not.toContain('公开扩展能力');
    await f.click('读取当前会话授权');
    const body = f.dom.window.document.body.textContent!;
    for (const detail of [
      '完整资源范围说明',
      '最后一条完整出处',
      '/exact/resource',
      'fixture.rule',
      'fixture.scope',
      'original-approval',
      'original-execution',
      'scope-digest',
      'fixture.command@1',
    ])
      expect(body).toContain(detail);
    const clear = [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (e) => e.textContent === '清除当前会话授权',
    )!;
    expect(clear.disabled).toBe(true);
    await act(async () =>
      f.dom.window.document
        .querySelector<HTMLInputElement>('[aria-label="当前会话授权目录"] input[type="checkbox"]')!
        .click(),
    );
    await act(async () => {
      clear.click();
      clear.click();
    });
    expect(f.calls.filter((r) => r.method === 'grants.clear')).toEqual([
      { method: 'grants.clear', generation: 1, observationId: 31 },
    ]);
    await until(() => f.dom.window.document.body.textContent!.includes('查询原授权清除选择'));
    expect(f.dom.window.document.body.textContent).toContain(
      '原会话 a · 工作区 w · 原存储 store · 授权版本 4',
    );
    await f.click('查询原授权清除选择');
    expect(f.calls.filter((r) => r.method === 'lookupGrant')).toEqual([
      { method: 'lookupGrant', generation: 1, commandId: 'original-clear' },
    ]);
    expect(f.calls.filter((r) => r.method === 'grants.clear')).toHaveLength(1);
    holdRead = true;
    await f.click('读取当前会话授权');
    await act(async () =>
      f.dom.window.document
        .querySelector<HTMLElement>('[role="dialog"]')!
        .dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await f.click('Other B');
    await act(async () => held.resolve(facts('a')));
    expect(f.dom.window.document.querySelector('[aria-label="当前会话授权目录"]')).toBeNull();
    holdRead = false;
    await open();
    expect(f.dom.window.document.body.textContent).not.toContain('original-approval');
    await f.click('读取当前会话授权');
    expect(f.dom.window.document.body.textContent).toContain('实际会话：b');
    expect(
      f.calls.some((r) =>
        ['submit', 'conversation.send', 'interaction.answer', 'caller.submit'].includes(r.method),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
