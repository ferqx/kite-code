import { expect, test } from 'bun:test';
import type { Execution } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge } from '../../src/native-bridge';
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

test('Native automatically presents only the selected browser Job, preserves dismissal, and keeps frozen annotation cards separate from existing draft', async () => {
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
  const bridge: NativeBridge = {
    ...control.bridge,
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
    [...host.querySelectorAll('button')].find((button) => button.textContent === text)!;
  const panel = () => host.querySelector('section[aria-label="Agent 浏览器"]');
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
    await until(() => !!panel() && !!button('暂停并接管'));
    expect(promptValue(host.querySelector('.composer [role="textbox"]'))).toBe('Keep my draft');
    const image = panel()!.querySelector('img')!;
    image.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 400, 300);
    await flush(() => image.dispatchEvent(new dom.window.Event('load')));
    await flush(() => button('⌖ 指向元素').click());
    await flush(() =>
      panel()!
        .querySelector('.agent-browser-frame')!
        .dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 70 }),
        ),
    );
    await until(() => !!button('加入提示词'));
    await flush(() => button('加入提示词').click());
    expect(promptValue(host.querySelector('.composer [role="textbox"]'))).toBe('Keep my draft');
    expect(host.querySelector('.browser-note-context')?.textContent).toContain('1 条网页注释');
    expect(browser.submitted).toHaveLength(0);
    expect(
      control.requests.some((request) =>
        ['input.prepare', 'caller.prepare', 'input.submit'].includes(request.method),
      ),
    ).toBe(false);
    await flush(() =>
      host
        .querySelector<HTMLButtonElement>(
          'aside[aria-label="Agent 浏览器"] button[aria-label="关闭"]',
        )!
        .click(),
    );
    await until(() => !panel());
    const reads = browser.calls.filter((call) => call.method === 'extensions.query').length;
    await flush(() => control.publish(), 380);
    expect(panel()).toBeNull();
    expect(browser.calls.filter((call) => call.method === 'extensions.query')).toHaveLength(reads);
    await flush(() => {
      executions = [job('new-owned-browser')];
      control.publish();
    });
    await until(() => !!panel());
    await flush(() => button('Session B').click());
    await until(() => host.querySelector('.breadcrumb strong')?.textContent === 'Session B');
    expect(panel()).toBeNull();
    if (promptValue(host.querySelector('.composer [role="textbox"]'))?.includes('@e1'))
      expect(
        host.querySelector('.composer [role="textbox"]')?.getAttribute('contenteditable'),
      ).toBe('false');
    await until(() => promptValue(host.querySelector('.composer [role="textbox"]')) === 'Draft B');
    expect(promptValue(host.querySelector('.composer [role="textbox"]'))).not.toContain('@e1');
    expect(browser.submitted.some((request) => request.actionId === 'browser.close')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restore();
    Object.assign(globalThis, prior);
  }
});
