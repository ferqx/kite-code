import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { AgentBrowserPanel } from '../../src/agent-browser-panel';
import { browserFixture, browserScope } from '../agent-browser.fixture';

async function setup() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = {
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
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const f = browserFixture(),
    quotes: string[] = [];
  const flush = async (action: () => void = () => {}, ms = 30) => {
    await act(async () => {
      action();
      await Bun.sleep(ms);
    });
  };
  const until = async (check: () => boolean) => {
    const end = Date.now() + 2500;
    while (!check()) {
      if (Date.now() > end)
        throw Error(`DOM condition timed out: ${dom.window.document.body.textContent}`);
      await flush();
    }
  };
  const render = (visible = true, canInvoke = true) =>
    flush(() =>
      root.render(
        <AgentBrowserPanel
          bridge={f.bridge}
          scope={browserScope}
          canRead
          canInvoke={canInvoke}
          visible={visible}
          onQuote={(text) => quotes.push(text)}
        />,
      ),
    );
  const button = (text: string) =>
    [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === text,
    )!;
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  };
  return { dom, f, quotes, root, flush, until, render, button, cleanup, host: dom.window.document };
}

test('live browser DOM walks handoff, scaled region picker, quoted draft, explicit input, invalidation and resume through Main', async () => {
  const x = await setup();
  try {
    await x.render();
    await x.until(() => !!x.button('暂停并接管'));
    expect(x.host.body.textContent).toContain('Agent 正在操作');
    expect(x.f.submitted).toHaveLength(0);
    await x.flush(() => {
      x.button('暂停并接管').click();
      x.button('暂停并接管')?.click();
    });
    await x.until(() => !!x.button('交还 Agent') && !x.button('交还 Agent').disabled);
    expect(x.f.submitted.map((item) => item.actionId)).toEqual(['browser.handoff']);
    expect(x.host.body.textContent).toContain('由你控制');
    const image = x.host.querySelector('img')!;
    image.getBoundingClientRect = () => ({
      left: 20,
      top: 30,
      width: 400,
      height: 300,
      right: 420,
      bottom: 330,
      x: 20,
      y: 30,
      toJSON() {},
    });
    await x.flush(() => image.dispatchEvent(new x.dom.window.Event('load')));
    const picker = x.host.querySelector<HTMLButtonElement>(
      '[aria-label="在画面中选取元素（不会点击网页）"]',
    )!;
    expect(picker.disabled).toBe(false);
    await x.flush(() =>
      picker.dispatchEvent(
        new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
      ),
    );
    await x.until(() => !!x.button('引用到对话') && !x.button('引用到对话').disabled);
    const fill = x.host.querySelector<HTMLInputElement>('[aria-label="填入内容"]')!;
    expect(x.host.getElementById(fill.getAttribute('aria-describedby')!)?.textContent).toBe(
      '普通填写内容会进入会话记录；此入口不支持输入密码、验证码或其他凭据。',
    );
    expect(x.f.submitted.map((item) => item.actionId)).toEqual([
      'browser.handoff',
      'browser.select',
    ]);
    expect(x.f.submitted[1]!.input).toMatchObject({
      ref: '@e1',
      seq: '1',
      generation: 'human-generation',
    });
    const note = x.host.querySelector<HTMLTextAreaElement>('textarea')!;
    await x.flush(() => {
      Object.getOwnPropertyDescriptor(
        x.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(note, 'Check this control');
      note.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
    });
    await x.flush(() => x.button('引用到对话').click());
    expect(x.quotes).toHaveLength(1);
    expect(x.quotes[0]).toContain('"ref":"@e1"');
    expect(x.quotes[0]).toContain('"frameSeq":"1"');
    expect(x.quotes[0]).toContain('我的说明：Check this control');
    expect(x.host.body.textContent).toContain('已添加到输入草稿，尚未发送');
    expect(x.f.submitted).toHaveLength(2);
    await x.flush(() => x.button('点击所选元素').click());
    await x.until(() => x.f.submitted.length === 3 && !x.button('引用到对话'));
    expect(x.f.submitted[2]).toMatchObject({
      actionId: 'browser.input',
      input: { command: { action: 'click', ref: '@e1', seq: '1' } },
    });
    expect(x.host.body.textContent).toContain('原引用已失效');
    expect(x.quotes).toHaveLength(1);
    await x.flush(() => x.button('交还 Agent').click());
    await x.until(() => !!x.button('暂停并接管') && !x.button('暂停并接管').disabled);
    expect(x.host.querySelector('select')).toBeNull();
    expect(x.f.submitted.map((item) => item.actionId)).toEqual([
      'browser.handoff',
      'browser.select',
      'browser.input',
      'browser.resume',
    ]);
  } finally {
    await x.cleanup();
  }
  expect(x.f.submitted.some((item) => item.actionId === 'browser.close')).toBe(false);
});

test('covered/hidden DOM stops observations, revokes actions, and unmount never closes the browser Job', async () => {
  const x = await setup();
  try {
    await x.render();
    await x.until(() => !!x.button('暂停并接管'));
    await x.render(false);
    const count = x.f.calls.filter((call) => call.method === 'extensions.query').length;
    await x.flush(() => {}, 420);
    expect(x.f.calls.filter((call) => call.method === 'extensions.query')).toHaveLength(count);
    expect(x.button('暂停并接管').disabled).toBe(true);
    await x.flush(() => x.button('暂停并接管').click());
    expect(x.f.submitted).toHaveLength(0);
    await x.render(true);
    await x.until(() => !x.button('暂停并接管').disabled);
    Object.defineProperty(x.host, 'visibilityState', { configurable: true, value: 'hidden' });
    await x.flush(() => x.host.dispatchEvent(new x.dom.window.Event('visibilitychange')));
    const hiddenCount = x.f.calls.filter((call) => call.method === 'extensions.query').length;
    await x.flush(() => {}, 420);
    expect(x.f.calls.filter((call) => call.method === 'extensions.query')).toHaveLength(
      hiddenCount,
    );
    expect(x.button('暂停并接管').disabled).toBe(true);
  } finally {
    await x.cleanup();
  }
  expect(x.f.calls.some((call) => call.method === 'extensions.release')).toBe(true);
  expect(x.f.submitted).toHaveLength(0);
});

test('unsupported platform is a clear unavailable state, not a generic read error or enabled human controls', async () => {
  const x = await setup();
  x.f.view = {
    ...x.f.view,
    browserId: '',
    generation: '',
    seq: '0',
    state: 'unavailable',
    frame: null,
    annotations: [],
    selectedAnnotation: null,
    error: 'browser_platform_unsupported',
  };
  try {
    await x.render();
    await x.until(() => x.host.body.textContent?.includes('当前平台尚未支持') === true);
    expect(x.host.body.textContent).toContain('浏览器不可用');
    expect(x.host.body.textContent).not.toContain('browser_platform_unsupported');
    expect(x.host.body.textContent).not.toContain('正在重新核实');
    expect(x.button('结束浏览器').disabled).toBe(true);
    expect(x.button('暂停并接管')).toBeUndefined();
    expect(x.f.submitted).toHaveLength(0);
  } finally {
    await x.cleanup();
  }
});
