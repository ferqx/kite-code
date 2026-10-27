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

function fixture(options?: Parameters<typeof sessionSwitchBridge>[0], diagnostics = false) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
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
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
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
    expect(f.query('.composer').getAttribute('data-preserve-input')).toBe('true');
    expect(f.query('.composer-actions button')).toBe(action);
    expect(action.disabled).toBe(true);
    expect(action.dataset.preserveEnabled).toBe('true');
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
      expect(action.dataset.preserveEnabled).toBe(active ? 'true' : undefined);
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
