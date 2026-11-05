import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import {
  nextDesktopPresentation,
  prepareDesktopDom,
  promptValue,
  setPromptText,
} from '../native-page-dom.fixture';
import { sessionSwitchBridge } from '../session-switch-bridge.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const originals = {
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
Object.assign(globalThis, originals);
bootstrap.window.close();

function fixture(
  options?: Parameters<typeof sessionSwitchBridge>[0],
  diagnostics = false,
  url = 'http://localhost',
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url,
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN' });
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
  const control = sessionSwitchBridge(options);
  Object.defineProperty(dom.window, 'kiteNative', { value: control.bridge });
  const host = dom.window.document.getElementById('root')!;
  let root = createRoot(host);
  const query = <T extends Element = HTMLElement>(selector: string) =>
    host.querySelector<T>(selector)!;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 80 && !check(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(check()).toBe(true);
  };
  const click = async (id: string) => {
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === `Session ${id.toUpperCase()}`)!
        .click();
    });
    await act(async () => nextDesktopPresentation(dom));
  };
  const ready = async (id: string) =>
    until(
      () =>
        query('.breadcrumb strong')?.textContent === `Session ${id.toUpperCase()}` &&
        !query<HTMLButtonElement>('[data-permission-trigger]')?.disabled &&
        !query<HTMLButtonElement>('[data-model-trigger]')?.disabled,
    );
  return {
    ...control,
    host,
    query,
    until,
    click,
    ready,
    async render() {
      await act(async () => root.render(<NativeDesktop testDiagnostics={diagnostics} />));
      await click('a');
      await ready('a');
    },
    async startPreparation() {
      await act(async () => root.render(<NativeDesktop />));
      await until(
        () =>
          !!query('.new-conversation-page .composer') &&
          !!query('[data-model-trigger]') &&
          !query<HTMLButtonElement>('[data-model-trigger]').disabled,
      );
    },
    async restart() {
      await act(async () => root.unmount());
      root = createRoot(host);
      await act(async () => root.render(<NativeDesktop />));
      await click('a');
      await ready('a');
    },
    edit: async (value: string) =>
      act(async () => {
        await setPromptText(query('.composer [role="textbox"]'), value);
      }),
    release: async (phase: string) => act(async () => control.release(phase)),
    resume: async () => act(async () => control.resume()),
    refresh: async (value: boolean) => act(async () => control.refresh(value)),
    fail: async (value: boolean) => act(async () => control.fail(value)),
    async close() {
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      restore();
      Object.assign(globalThis, prior);
    },
  };
}

const businessMethods = new Set([
  'caller.prepare',
  'caller.submit',
  'permission.mode',
  'permission.trust',
  'submit',
  'conversation.create',
  'permission.prepare',
  'permission.submit',
  'input.prepare',
  'input.submit',
  'background.stop',
  'draft.write',
]);

test('terminal turn reminders survive failed reads and reopening, and clear only after visible reading', async () => {
  const f = fixture({ turnNotifications: true });
  const row = (id: string) => f.query(`[aria-label="Session ${id.toUpperCase()}"]`);
  const unread = (id: string) => !!row(id)?.querySelector('.session-unread-dot');
  try {
    await f.render();
    expect(f.host.querySelectorAll('.session-unread-dot')).toHaveLength(0);
    expect(row('b').querySelector('[aria-label="会话运行中"]')).not.toBeNull();
    await act(async () => f.setTurn('b', 'completed'));
    await f.until(() => unread('b'));
    expect(row('b').querySelector('[aria-label="会话运行中"]')).toBeNull();
    expect(row('b').getAttribute('aria-description')).toContain('有新结束的回复');
    await f.restart();
    expect(unread('b')).toBe(true);
    await f.edit('Keep private draft');
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    expect(unread('b')).toBe(true);
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    expect(unread('b')).toBe(true);
    await f.release('models');
    await f.until(() => f.pending('history') > 0);
    expect(unread('b')).toBe(true);
    await f.resume();
    await f.ready('b');
    await f.until(() => !unread('b'));
    await f.click('a');
    await f.ready('a');
    expect(promptValue(f.query('.composer [role="textbox"]'))).toBe('Keep private draft');
    await f.restart();
    expect(unread('b')).toBe(false);
    await act(async () => f.setTurn('b', 'running', 'second-b'));
    await f.until(() => !!row('b').querySelector('[aria-label="会话运行中"]'));
    expect(unread('b')).toBe(false);
    await act(async () => f.setTurn('b', 'failed', 'second-b'));
    await f.until(() => unread('b'));
    await f.fail(true);
    await f.click('b');
    await f.until(() => !!f.query('.breadcrumb strong')?.textContent?.includes('Session B'));
    expect(unread('b')).toBe(true);
    await f.fail(false);
    await f.ready('b');
    await f.until(() => !unread('b'));
    // A hidden current session cannot consume the next terminal result.
    Object.defineProperty(f.host.ownerDocument, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      f.host.ownerDocument.dispatchEvent(new window.Event('visibilitychange'));
      f.setTurn('b', 'cancelled', 'third-b');
    });
    await f.until(() => unread('b'));
    Object.defineProperty(f.host.ownerDocument, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await act(async () => f.host.ownerDocument.dispatchEvent(new window.Event('visibilitychange')));
    await f.until(() => !unread('b'));
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a failed private database write retains the reminder until a later write commits', async () => {
  const f = fixture({ turnNotifications: true });
  const unread = () => !!f.query('[aria-label="Session B"] .session-unread-dot');
  try {
    await f.render();
    await act(async () => f.setTurn('b', 'interrupted'));
    await f.until(unread);
    await act(async () => f.failReceipt(true));
    await f.click('b');
    await f.ready('b');
    expect(unread()).toBe(true);
    await act(async () => f.failReceipt(false));
    await f.until(() => !unread());
    await f.click('a');
    await f.ready('a');
    expect(unread()).toBe(false);
    // Resuming the same Run changes its terminal fact and needs a fresh receipt.
    await act(async () => f.setTurn('b', 'running'));
    await act(async () => f.setTurn('b', 'completed'));
    await f.until(unread);
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a new renderer origin restores the committed receipt and only a newer terminal turn lights again', async () => {
  const readTurns = new Map<string, string>();
  let f = fixture({ turnNotifications: true, readTurns }, false, 'http://127.0.0.1:31001');
  try {
    await f.render();
    await act(async () => f.setTurn('b', 'completed'));
    await f.until(() => !!f.query('[aria-label="Session B"] .session-unread-dot'));
    await f.click('b');
    await f.ready('b');
    await f.until(() => !f.query('[aria-label="Session B"] .session-unread-dot'));
    expect(readTurns.get('b')).toBe(JSON.stringify(['run-b', 'completed']));
    await f.close();
    f = fixture({ turnNotifications: true, readTurns }, false, 'http://127.0.0.1:31002');
    f.setTurn('b', 'completed');
    await f.render();
    expect(f.query('[aria-label="Session B"] .session-unread-dot')).toBeNull();
    await act(async () => f.setTurn('b', 'completed', 'new-b'));
    await f.until(() => !!f.query('[aria-label="Session B"] .session-unread-dot'));
  } finally {
    await f.close();
  }
});

test('the full Native shell retains observed controls and the old draft until Main confirms a session handoff', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click('b');
    await f.ready('b');
    await f.click('a');
    await f.ready('a');
    await f.edit('Local A');
    const permission = f.query<HTMLButtonElement>('[data-permission-trigger]'),
      model = f.query<HTMLButtonElement>('[data-model-trigger]'),
      editor = f.query('.composer [role="textbox"]'),
      action = f.query<HTMLButtonElement>('.composer-actions button'),
      environment = f.query('.environment-information'),
      stop = f.query<HTMLButtonElement>('.background-execution-stop');
    expect(permission.textContent).toBe('自动审核');
    expect(stop.disabled).toBe(false);
    const reads = f.requests.filter((request) => request.method === 'input.models.read').length;
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    expect(f.query('[data-permission-trigger]')).toBe(permission);
    expect(permission.textContent).toBe('自动审核');
    expect(permission.disabled).toBe(true);
    expect(promptValue(editor)).toBe('Local A');
    expect(editor.getAttribute('contenteditable')).toBe('false');
    expect(editor.dataset.disabled).toBeUndefined();
    expect(f.query('.composer-actions button')).toBe(action);
    expect(action.disabled).toBe(true);
    expect(action.dataset.readGated).toBe('true');
    expect(f.query('.environment-information')).toBe(environment);
    expect(f.query('.background-execution-stop')).toBe(stop);
    expect(stop.disabled).toBe(true);
    expect(environment.textContent).not.toContain('上次状态');
    expect(model.textContent).toContain('Model A');
    expect(f.requests.filter((request) => request.method === 'input.models.read')).toHaveLength(
      reads,
    );
    await act(async () => {
      permission.click();
      model.click();
      action.click();
      stop.click();
    });
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
    expect(f.host.querySelector('[role="menu"]')).toBeNull();
    await f.release('selection');
    await f.until(() => f.pending('history') > 0 && f.pending('models') > 0);
    expect(f.query('[data-permission-trigger]')).toBe(permission);
    expect(permission.textContent).toBe('完全访问');
    expect(permission.disabled).toBe(true);
    expect(f.query('.composer [role="textbox"]')).toBe(editor);
    expect(promptValue(editor)).toBe('Draft B');
    expect(model.textContent).toContain('Model B');
    expect(model.disabled).toBe(true);
    expect(f.query('.composer-cache-rate').textContent).toBe('缓存 30%');
    expect(f.query<HTMLButtonElement>('.composer-actions button').dataset.readGated).toBe('true');
    await f.release('history');
    await f.until(() => !permission.disabled);
    expect(model.disabled).toBe(true);
    await f.resume();
    await f.ready('b');
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
    await f.click('a');
    await f.ready('a');
    expect(promptValue(editor)).toBe('Local A');
  } finally {
    await f.close();
  }
});

test('a cold target waits for its saved draft before replacing the outgoing footer', async () => {
  const f = fixture({ holdDraft: true });
  const frames: { draft: string | undefined; model: string; action: string | null }[] = [];
  const record = () =>
    frames.push({
      draft: promptValue(f.query('.composer [role="textbox"]')),
      model: f.query('[data-model-trigger]').textContent ?? '',
      action: f.query('.composer-actions button').getAttribute('aria-label'),
    });
  const observer = new f.host.ownerDocument.defaultView!.MutationObserver(record);
  try {
    await f.render();
    observer.observe(f.host, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    record();
    const editor = f.query('.composer [role="textbox"]');
    const model = f.query('[data-model-trigger]');
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    await f.release('models');
    await f.until(() => f.pending('draft') > 0);
    expect(promptValue(editor)).toBe('Draft A');
    expect(model.textContent).toContain('Model A');
    expect(editor.getAttribute('contenteditable')).toBe('false');
    expect(
      f.requests.some((request) => request.method === 'messages' && request.sessionId === 'b'),
    ).toBe(false);
    await f.release('draft');
    await f.until(() => f.pending('history') > 0);
    expect(promptValue(editor)).toBe('Draft B');
    expect(model.textContent).toContain('Model B');
    expect(
      f.query<HTMLButtonElement>('.composer-actions button').getAttribute('aria-label'),
    ).not.toBe('停止任务');
    await f.resume();
    await f.ready('b');
    expect(frames.some((frame) => frame.draft === 'Draft A')).toBe(true);
    expect(frames.some((frame) => frame.draft === 'Draft B')).toBe(true);
    expect(
      frames.every(
        (frame) =>
          (frame.draft === 'Draft A' && frame.model.includes('Model A')) ||
          (frame.draft === 'Draft B' && frame.model.includes('Model B')),
      ),
    ).toBe(true);
    expect(frames.some((frame) => frame.action === '停止任务')).toBe(false);
    expect(f.query('.composer [role="textbox"]') === editor).toBe(true);
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
  } finally {
    observer.disconnect();
    await f.close();
  }
});

test('a departed cold draft read cannot publish its footer or replace the later Session draft', async () => {
  const f = fixture({ holdDraft: true });
  try {
    await f.render();
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    await f.release('models');
    await f.until(() => f.pending('draft') > 0);
    await f.click('a');
    await f.until(() => f.pending('selection') > 0);
    await f.resume();
    await f.ready('a');
    expect(f.query('.breadcrumb strong').textContent).toBe('Session A');
    expect(promptValue(f.query('.composer [role="textbox"]'))).toBe('Draft A');
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const initialSelection of [false, true]) {
  test(`leaving preparation retains its own draft and input while the first target is held (previous selection: ${initialSelection})`, async () => {
    const f = fixture({ initialSelection });
    try {
      if (initialSelection) {
        await f.render();
        await act(async () =>
          [...f.host.querySelectorAll('button')]
            .find((button) => button.textContent === '新对话')!
            .click(),
        );
        await f.until(() => !!f.query('.new-conversation-page .composer'));
      } else await f.startPreparation();
      await f.edit('New conversation private draft');
      await f.until(() => !f.query<HTMLButtonElement>('[data-model-trigger]').disabled);
      const document = f.host.ownerDocument;
      await act(async () => f.query<HTMLButtonElement>('[data-model-trigger]').click());
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label^="选择模型，当前 "]')!.click(),
      );
      await act(async () =>
        document.querySelector<HTMLElement>('[aria-label="选择模型 model-a"]')!.click(),
      );
      const send = f.query<HTMLButtonElement>('.composer-actions button');
      expect(send.disabled).toBe(false);
      const composer = f.query('.composer');
      const editor = f.query('.composer [role="textbox"]');
      const model = f.query('[data-model-trigger]');
      const modelLabel = model.textContent;
      f.hold();
      await f.click('b');
      await f.until(() => f.pending('selection') > 0);
      expect(f.query('.breadcrumb strong').textContent).toBe('Session B');
      expect(f.query('.composer') === composer).toBe(true);
      expect(f.query('.composer [role="textbox"]') === editor).toBe(true);
      expect(promptValue(editor)).toBe('New conversation private draft');
      expect(editor.getAttribute('contenteditable')).toBe('false');
      expect(model.textContent).toBe(modelLabel);
      expect(f.query<HTMLButtonElement>('[data-model-trigger]').disabled).toBe(true);
      expect(editor.dataset.disabled).toBeUndefined();
      expect(send.disabled).toBe(true);
      expect(send.dataset.disabled).toBeUndefined();
      expect(send.dataset.readGated).toBe('true');
      expect(f.query('.environment-information')).toBeNull();
      await act(async () => f.query<HTMLButtonElement>('.composer-actions button').click());
      expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
      const target = initialSelection ? 'b' : 'a';
      if (!initialSelection) {
        await f.click('a');
        await f.until(() => f.pending('selection') === 2);
        expect(f.query('.breadcrumb strong').textContent).toBe('Session A');
        expect(f.query('.composer') === composer).toBe(true);
        expect(promptValue(editor)).toBe('New conversation private draft');
      }
      await f.release('selection');
      await f.until(() => f.pending('models') > 0);
      expect(f.query('.composer') === composer).toBe(true);
      expect(promptValue(editor)).toBe('New conversation private draft');
      await f.resume();
      await f.ready(target);
      expect(f.query('.composer') === composer).toBe(true);
      expect(f.query('.composer [role="textbox"]') === editor).toBe(true);
      expect(promptValue(editor)).toBe(`Draft ${target.toUpperCase()}`);
      await act(async () =>
        [...f.host.querySelectorAll('button')]
          .find((button) => button.textContent === '新对话')!
          .click(),
      );
      await f.until(() => !!f.query('.new-conversation-page .composer'));
      expect(promptValue(editor)).toBe('New conversation private draft');
    } finally {
      await f.close();
    }
  });
}

test('cold confirmed controls keep their normal presentation while history reconciliation still disables their actions', async () => {
  const f = fixture();
  try {
    await f.render();
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    await f.release('models');
    await f.until(() => f.pending('history') > 0);
    const permission = f.query<HTMLButtonElement>('[data-permission-trigger]');
    expect(permission.textContent).toBe('完全访问');
    expect(permission.disabled).toBe(true);
    expect(permission.dataset.readGated).toBe('true');
    const send = f.query<HTMLButtonElement>('.composer-actions button');
    expect(send.disabled).toBe(true);
    expect(send.dataset.readGated).toBe('true');
    await act(async () => permission.click());
    expect(f.host.querySelector('[role="menu"]')).toBeNull();
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
    await f.resume();
    await f.ready('b');
    expect(f.query('[data-permission-trigger]')).toBe(permission);
    expect(permission.disabled).toBe(false);
  } finally {
    await f.close();
  }
});

test('a cold Session keeps metric nodes mounted through a single loading state and adopts both readings together without gating input', async () => {
  const f = fixture({ active: false, contextUsage: true });
  const changes: string[] = [];
  const record = () =>
    changes.push(
      JSON.stringify([
        f.query('.composer-cache-rate')?.textContent,
        f.query('.composer-context-usage')?.getAttribute('aria-label'),
      ]),
    );
  const observer = new f.host.ownerDocument.defaultView!.MutationObserver(record);
  try {
    await f.render();
    await f.until(() => !!f.query('.composer-context-usage'));
    const rate = f.query('.composer-cache-rate');
    const ring = f.query('.composer-context-usage');
    const editor = f.query('.composer [role="textbox"]');
    observer.observe(f.host, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    record();
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    await f.release('models');
    await f.until(() => f.pending('history') > 0);
    expect(f.query('.composer-cache-rate')).toBe(rate);
    expect(f.query('.composer-context-usage')).toBe(ring);
    expect(rate.textContent).toBe('缓存…');
    expect(ring.getAttribute('aria-label')).toBe('正在读取上下文占用');
    expect(promptValue(editor)).toBe('Draft B');
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(f.query<HTMLButtonElement>('[data-model-trigger]').disabled).toBe(false);
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
    await f.release('history');
    await f.until(() => f.pending('usage') > 0 && f.pending('context') > 0);
    await f.release('models');
    await f.ready('b');
    expect(editor.getAttribute('contenteditable')).toBe('true');
    await f.release('usage');
    expect(rate.textContent).toBe('缓存…');
    expect(ring.getAttribute('aria-label')).toBe('正在读取上下文占用');
    await f.release('context');
    await f.resume();
    await f.ready('b');
    expect(f.query('.composer-cache-rate')).toBe(rate);
    expect(f.query('.composer-context-usage')).toBe(ring);
    expect(rate.textContent).toBe('缓存 30%');
    expect(ring.getAttribute('aria-label')).toBe('上下文占用约 4%');
    expect(promptValue(editor)).toBe('Draft B');
    expect(new Set(changes)).toEqual(
      new Set([
        JSON.stringify(['缓存 70%', '上下文占用约 2%']),
        JSON.stringify(['缓存…', '正在读取上下文占用']),
        JSON.stringify(['缓存 30%', '上下文占用约 4%']),
      ]),
    );
  } finally {
    observer.disconnect();
    await f.close();
  }
});

test('failed cold usage reads end the loading state without borrowing another Session and a later visit can recover', async () => {
  const f = fixture({ active: false, contextUsage: true });
  const request = f.bridge.request.bind(f.bridge);
  let failed = false;
  f.bridge.request = async (input) => {
    if (failed && ['toolMessages.usage', 'toolMessages.contextUsage'].includes(input.method))
      throw Error('usage_read_unavailable');
    return request(input);
  };
  try {
    await f.render();
    await f.until(() => !!f.query('.composer-context-usage'));
    failed = true;
    await f.click('b');
    await f.ready('b');
    await f.until(() => !f.query('.composer-metrics'));
    expect(f.query('.composer [role="textbox"]').getAttribute('contenteditable')).toBe('true');
    failed = false;
    await f.click('a');
    await f.ready('a');
    expect(f.query('.composer-cache-rate').textContent).toBe('缓存 70%');
    await f.click('b');
    await f.ready('b');
    await f.until(() => f.query('.composer-cache-rate')?.textContent === '缓存 30%');
    expect(f.query('.composer-context-usage').getAttribute('aria-label')).toBe('上下文占用约 4%');
    expect(f.requests.filter((input) => businessMethods.has(input.method))).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('routine recalibration retains the approval mode, while an actual permission failure invalidates it', async () => {
  const f = fixture();
  try {
    await f.render();
    const permission = f.query<HTMLButtonElement>('[data-permission-trigger]');
    await f.refresh(true);
    await f.until(() => permission.disabled);
    expect(f.query('[data-permission-trigger]')).toBe(permission);
    expect(permission.textContent).toBe('自动审核');
    expect(f.query('.composer').dataset.sessionLoading).toBe('true');
    await act(async () => permission.click());
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
    await f.refresh(false);
    await f.ready('a');
    expect(f.query('[data-permission-trigger]')).toBe(permission);
    await f.fail(true);
    await f.until(() => !f.host.querySelector('[data-permission-trigger]'));
    expect(f.query('.composer').dataset.sessionLoading).toBeUndefined();
    await f.until(() => f.query('.environment-information').getAttribute('data-stale') === 'true');
    expect(f.host.querySelector('.background-execution-stop')).toBeNull();
    await f.refresh(true);
    await f.until(() => !!f.host.querySelector('[data-permission-trigger]'));
    expect(f.query('[data-permission-trigger]').textContent).toBe('审核方式');
    expect(f.query('[data-permission-trigger]').getAttribute('aria-busy')).toBe('true');
    await f.fail(false);
    await f.ready('a');
    expect(f.query('[data-permission-trigger]').textContent).toBe('自动审核');
  } finally {
    await f.close();
  }
});

test('a normally disabled empty send stays dim, and a running empty draft keeps its stop action during handoff', async () => {
  for (const active of [false, true]) {
    const f = fixture({ active, drafts: { a: '', b: '' } });
    try {
      await f.render();
      await f.click('b');
      await f.ready('b');
      await f.click('a');
      await f.ready('a');
      const action = f.query<HTMLButtonElement>('.composer-actions button');
      expect(action.disabled).toBe(!active);
      expect(action.getAttribute('aria-label')).toBe(active ? '停止任务' : '发送明确的新轮次');
      f.hold();
      await f.click('b');
      await f.until(() => f.pending('selection') > 0);
      expect(f.query('.composer-actions button')).toBe(action);
      expect(action.disabled).toBe(true);
      expect(action.dataset.readGated).toBe(active ? 'true' : undefined);
      await f.release('selection');
      await f.until(() => f.pending('history') > 0);
      expect(f.query('.composer-actions button')).toBe(action);
      expect(action.getAttribute('aria-label')).toBe(active ? '停止任务' : '发送明确的新轮次');
      await act(async () => action.click());
      expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
      await f.resume();
      await f.ready('b');
    } finally {
      await f.close();
    }
  }
});

test('a known environment failure stays visible while another selection is awaiting Main', async () => {
  const f = fixture(undefined, true);
  try {
    await f.render();
    await f.fail(true);
    await f.until(() =>
      f.query('.environment-information').textContent!.includes('environment_unavailable'),
    );
    const failed = f.query('.environment-information').textContent;
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    expect(f.query('.environment-information').textContent).toBe(failed);
    expect(f.host.querySelector('.background-execution-stop')).toBeNull();
    await f.resume();
    await f.fail(false);
    await f.ready('b');
  } finally {
    await f.close();
  }
});

test('a cold selection prepares its final model before publication, including intervening Main state events, without a second read', async () => {
  const f = fixture({ active: false });
  try {
    await f.render();
    const button = f.query<HTMLButtonElement>('[data-model-trigger]'),
      editor = f.query('.composer [role="textbox"]');
    const observed: string[] = [];
    const observer = new MutationObserver(() => observed.push(button.textContent ?? ''));
    observer.observe(button, { subtree: true, childList: true, characterData: true });
    const before = f.requests.filter((request) => request.method === 'input.models.read').length;
    f.hold();
    await f.click('b');
    await f.until(() => f.pending('selection') > 0);
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    expect(f.query('.breadcrumb strong').textContent).toBe('Session B');
    expect(button.textContent).toContain('Model A');
    expect(button.disabled).toBe(true);
    expect(promptValue(editor)).toBe('Draft A');
    expect(f.pending('history')).toBe(0);
    await act(async () => f.publish());
    expect(
      f.requests.some((request) => request.method === 'messages' && request.sessionId === 'b'),
    ).toBe(false);
    expect(f.host.textContent).not.toContain('Reply a');
    expect(f.host.textContent).not.toContain('Reply b');
    expect(f.query('.breadcrumb strong').textContent).toBe('Session B');
    expect(button.textContent).toContain('Model A');
    await f.release('models');
    await f.until(() => f.pending('history') > 0);
    expect(f.query('.breadcrumb strong').textContent).toBe('Session B');
    expect(f.query('[data-model-trigger]')).toBe(button);
    expect(button.textContent).toBe('Model B中');
    expect(button.disabled).toBe(false);
    expect(promptValue(editor)).toBe('Draft B');
    expect(observed.some((text) => text.includes('选择模型'))).toBe(false);
    expect(f.requests.filter((request) => request.method === 'input.models.read')).toHaveLength(
      before + 1,
    );
    await f.resume();
    await f.ready('b');
    expect(f.query<HTMLButtonElement>('.composer-actions button').disabled).toBe(false);
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
    observer.disconnect();
  } finally {
    await f.close();
  }
});

test('prepared cold sessions using the same model still publish their own ready choice', async () => {
  const f = fixture({ active: false, sameModel: true });
  try {
    await f.render();
    expect(f.query('[data-model-trigger]').textContent).toBe('Model A中');
    await f.click('b');
    await f.ready('b');
    expect(f.query('[data-model-trigger]').textContent).toBe('Model A中');
    await f.until(() => !f.query<HTMLButtonElement>('.composer-actions button').disabled);
    expect(f.query('.breadcrumb strong').textContent).toBe('Session B');
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('late cold model preparation cannot publish a departed page or start its history', async () => {
  const f = fixture({ active: false });
  try {
    await f.render();
    f.hold();
    await f.click('b');
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    await f.click('a');
    await f.release('selection');
    await f.until(() => f.pending('history') > 0);
    await f.resume();
    await f.ready('a');
    expect(f.query('[data-model-trigger]').textContent).toBe('Model A中');
    expect(promptValue(f.query('.composer [role="textbox"]'))).toBe('Draft A');
    expect(
      f.requests.some((request) => request.method === 'messages' && request.sessionId === 'b'),
    ).toBe(false);
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a cold model read failure opens the target history with an explicit local error and no send qualification', async () => {
  const f = fixture({ active: false, modelErrors: { b: 'fixture_model_error' } });
  try {
    await f.render();
    await f.click('b');
    await f.ready('b');
    expect(f.host.textContent).toContain('Reply b');
    expect(f.host.textContent).toContain('模型目录不可用：fixture_model_error');
    expect(f.query('[data-model-trigger]').textContent).toBe('选择模型');
    expect(f.query<HTMLButtonElement>('.composer-actions button').disabled).toBe(true);
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a Main withdrawal during cold preparation remains unavailable instead of reviving the acknowledged permissions', async () => {
  const f = fixture({ active: false });
  try {
    await f.render();
    f.hold();
    await f.click('b');
    await f.release('selection');
    await f.until(() => f.pending('models') > 0);
    await act(async () => f.withdraw());
    await f.release('models');
    await f.until(() => f.query('.breadcrumb strong').textContent === 'Session B');
    expect(f.query('.environment-information').getAttribute('data-stale')).toBe('true');
    expect(f.host.querySelector('[data-permission-trigger]')).toBeNull();
    expect(f.query<HTMLButtonElement>('.composer-actions button').disabled).toBe(true);
    expect(f.requests.filter((request) => businessMethods.has(request.method))).toHaveLength(0);
    await f.resume();
  } finally {
    await f.close();
  }
});
