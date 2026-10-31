import { expect, test } from 'bun:test';
import type { Execution } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge } from '../../src/native-bridge';
import type { NativeBrowserBridge, NativeBrowserState } from '../../src/native-browser-bridge';
import { browserFixture } from '../agent-browser.fixture';
import { prepareDesktopDom, promptValue, setPromptText } from '../native-page-dom.fixture';
import { sessionSwitchBridge } from '../session-switch-bridge.fixture';

const bootstrap = new JSDOM('<!doctype html><div></div>', { pretendToBeVisual: true });
const initial = {
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
Object.assign(globalThis, initial);
bootstrap.window.close();

test('Native reveals the ordinary retained page for an owned browser Job and annotates a frozen frame without a second Agent workspace', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
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
  const control = sessionSwitchBridge({ active: false, protocol: 'chat-completions' }),
    browser = browserFixture();
  let executions: Execution[] = [];
  const page = (id: string): NativeBrowserState => ({
    id,
    title: id === 'ordinary-a' ? 'Example page' : '新标签页',
    url: id === 'ordinary-a' ? 'http://localhost/fixture' : '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...(id === 'ordinary-a'
      ? {
          control: {
            phase: 'agent' as const,
            sessionId: 'a',
            incarnation: 'page-a',
            browserId: 'browser',
            navigation: 0,
          },
        }
      : {}),
  });
  const bridge: NativeBridge & NativeBrowserBridge = {
    ...control.bridge,
    async restoreBrowser(scope) {
      return {
        scope: { ...scope },
        page:
          scope.sessionId === 'a' &&
          executions.some((row) => row.sessionId === 'a' && row.originStoreId === 'store')
            ? page('ordinary-a')
            : null,
      };
    },
    async browserRequest(request) {
      return request.action === 'state' ? page(request.id) : null;
    },
    watchBrowser() {
      return () => {};
    },
    async request(request) {
      if (request.method.startsWith('extensions.')) return browser.bridge.request(request);
      const value = await control.bridge.request(request);
      if (value && 'generation' in value && 'selection' in value && value.selection) {
        const selection = value.selection;
        browser.scope = {
          generation: value.generation,
          viewSelection: selection.viewSelection ?? selection.viewGeneration,
          historyEpoch: value.historyEpoch ?? 0,
          storeId: selection.storeId,
          sessionId: selection.session.id,
          workspaceId: selection.session.workspaceId,
          contextSelectionId: selection.session.contextSelectionId,
        };
        return {
          ...value,
          selection: {
            ...selection,
            canReadExtensions: true,
            canInvokeExtensions: true,
            executions,
          },
        };
      }
      return value;
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const flush = async (action: () => void = () => {}, ms = 20) =>
    act(async () => {
      action();
      await Bun.sleep(ms);
    });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > end) throw Error(`Native DOM timeout: ${host.textContent}`);
      await flush();
    }
  };
  const button = (text: string) =>
    [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === text || button.getAttribute('aria-label') === text,
    )!;
  const panel = () => host.querySelector('section[aria-label="冻结快照注释"]');
  const job = (id: string, sessionId = 'a', originStoreId = 'store') =>
    ({
      id,
      sessionId,
      originStoreId,
      kind: 'job',
      definitionId: 'browser.session',
      definitionVersion: '1',
      status: 'running',
      cancelRequestedAt: null,
    }) as Execution;
  try {
    await flush(() => root.render(<NativeDesktop />));
    await until(() => !!button('Session A'));
    await flush(() => button('Session A').click());
    await until(
      () =>
        !!host.querySelector('.composer [role="textbox"]') &&
        !host.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled,
    );
    expect(panel()).toBeNull();
    await flush(() => {
      executions = [job('foreign-session', 'b'), job('foreign-store', 'a', 'foreign')];
      control.publish();
    }, 80);
    expect(panel()).toBeNull();
    expect(browser.calls.filter((call) => call.method === 'extensions.open')).toHaveLength(0);
    await act(async () =>
      setPromptText(host.querySelector('.composer [role="textbox"]')!, 'Keep my draft'),
    );
    await flush(() => {
      executions = [job('owned-browser')];
      control.publish();
    });
    await until(() => !!button('浏览器控制'));
    await flush(() => button('浏览器控制').click());
    await until(() => !!button('暂停并接管') && !button('暂停并接管').disabled);
    await flush(() => button('浏览器控制').click());
    expect(host.querySelectorAll('[aria-label="右侧栏标签页"]')).toHaveLength(1);
    expect([...host.querySelectorAll('[role="tab"]')].map((row) => row.textContent)).toContain(
      'Example page',
    );
    expect(
      [...host.querySelectorAll('[role="tab"]')].some((row) => row.textContent === 'Agent 浏览器'),
    ).toBe(false);
    expect(host.querySelector('section[aria-label="Agent 浏览器"]')).toBeNull();
    expect(host.querySelectorAll('.native-browser-page')).toHaveLength(1);
    expect(promptValue(host.querySelector('.composer [role="textbox"]'))).toBe('Keep my draft');
    const openedBeforeNotes = browser.calls.filter(
      (call) => call.method === 'extensions.open',
    ).length;
    await flush(() => button('指向注释').click());
    await until(() => !!panel()?.querySelector('img'));
    expect(host.querySelector('[data-native-browser-overlay]')?.hasAttribute('hidden')).toBe(false);
    expect(panel()!.querySelector('[data-control="handoff"]')).toBeNull();
    expect(panel()!.querySelector('[aria-label="打开网址"]')).toBeNull();
    const annotationTools = button('网页注释工具');
    expect(annotationTools?.closest('.native-browser-toolbar')).not.toBeNull();
    expect(panel()!.querySelector('.agent-browser-toolbar, header, form')).toBeNull();
    expect(panel()!.querySelector('.agent-browser-hint, [role="status"]')).toBeNull();
    expect(browser.calls.filter((call) => call.method === 'extensions.open')).toHaveLength(
      openedBeforeNotes,
    );
    const image = panel()!.querySelector('img')!;
    image.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 400, 300);
    await flush(() => image.dispatchEvent(new dom.window.Event('load')));
    await until(() => !!panel()?.querySelector('.is-pointing'));
    await flush(() =>
      panel()!
        .querySelector('.agent-browser-frame')!
        .dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 70 }),
        ),
    );
    await until(() => !!button('加入提示词'));
    expect(button('加入提示词').closest('.native-browser-surface')).toBeNull();
    expect(dom.window.document.querySelector('form form')).toBeNull();
    await flush(() => button('加入提示词').click());
    expect(promptValue(host.querySelector('.composer [role="textbox"]'))).toBe('Keep my draft');
    expect(host.querySelector('.browser-note-context')?.textContent).toContain('1 条网页注释');
    expect(browser.submitted).toHaveLength(0);
    expect(
      control.requests.some((request) =>
        ['input.prepare', 'caller.prepare', 'input.submit'].includes(request.method),
      ),
    ).toBe(false);
    await flush(() => button('返回网页').click());
    expect(host.querySelector('[data-native-browser-overlay]')?.hasAttribute('hidden')).toBe(true);
    await flush(() => host.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')!.click());
    await until(
      () => host.querySelector('[role="tab"][data-state="active"]')?.textContent === '新标签页',
    );
    expect(host.querySelectorAll('.native-browser-page')).toHaveLength(2);
    const choosePage = () =>
      [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((row) => row.textContent === 'Example page')!
        .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await flush(choosePage);
    await until(() => !!button('浏览器控制'));
    await flush(() => button('浏览器控制').click());
    await until(() => !button('暂停并接管').disabled);
    await flush(() => button('浏览器控制').click());
    await flush(() => host.querySelector<HTMLButtonElement>('[aria-label="收起标签栏"]')!.click());
    await until(() => host.querySelector('#session-tabs')?.getAttribute('aria-hidden') === 'true');
    await flush(() => control.publish(), 380);
    expect(host.querySelector('#session-tabs')?.getAttribute('aria-hidden')).toBe('true');
    executions = [job('second-owned-browser')];
    await flush(() => control.publish());
    await until(() => host.querySelector('#session-tabs')?.getAttribute('aria-hidden') === 'false');
    expect(host.querySelectorAll('.native-browser-page')).toHaveLength(2);
    expect(host.querySelectorAll('[role="tab"][data-state="active"]')).toHaveLength(1);
    expect(host.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe(
      'Example page',
    );
    expect(browser.submitted).toHaveLength(0);
    await flush(() => button('指向注释').click());
    await flush(() => button('浏览器控制').click());
    await until(() => !button('暂停并接管').disabled);
    await flush(() => button('暂停并接管').click());
    await until(() => browser.submitted.length === 1);
    expect(browser.submitted[0]?.actionId).toBe('browser.handoff');
    await flush(() => button('返回网页').click());
    await flush(() => button('指向注释').click());
    expect(browser.submitted).toHaveLength(1);
    expect(host.textContent).not.toContain('正在核实原操作；不会重复提交');
    await flush(() => button('Session B').click());
    await until(() => host.querySelector('.breadcrumb strong')?.textContent === 'Session B');
    await until(() => promptValue(host.querySelector('.composer [role="textbox"]')) === 'Draft B');
    expect(panel()).toBeNull();
    expect(host.querySelector('.browser-note-context')).toBeNull();
    expect(browser.submitted.some((request) => request.actionId === 'browser.close')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restore();
    Object.assign(globalThis, prior);
  }
});
