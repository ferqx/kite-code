import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { AgentBrowserPanel } from '../../src/agent-browser-panel';
import type { BrowserNoteInput } from '../../src/browser-annotation-drafts';
import { browserFixture, browserScope, browserView } from '../agent-browser.fixture';

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
    quotes: BrowserNoteInput[] = [];
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
  const render = (visible = true, canInvoke = true, scope = browserScope) =>
    flush(() =>
      root.render(
        <AgentBrowserPanel
          bridge={f.bridge}
          scope={scope}
          canRead
          canInvoke={canInvoke}
          visible={visible}
          onAnnotate={(capture) => {
            quotes.push(capture);
          }}
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
      '[aria-label="浏览器画面；接管后可选择操作元素"]',
    )!;
    expect(picker.disabled).toBe(false);
    await x.flush(() =>
      picker.dispatchEvent(
        new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
      ),
    );
    await x.until(() => !!x.button('点击所选元素') && !x.button('点击所选元素').disabled);
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
    // Historical annotation is independent of human browser selection.
    await x.flush(() => x.button('⌖ 指向元素').click());
    const frozen = x.host.querySelector<HTMLButtonElement>('.agent-browser-frame')!;
    await x.flush(() =>
      frozen.dispatchEvent(
        new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
      ),
    );
    const note = x.host.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]')!;
    await x.flush(() => {
      Object.getOwnPropertyDescriptor(
        x.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(note, 'Check this control');
      note.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
    });
    await x.flush(() => x.button('加入提示词').click());
    expect(x.quotes).toHaveLength(1);
    expect(x.quotes[0]).toMatchObject({
      element: { ref: '@e1' },
      source: { frameSeq: '1' },
      note: 'Check this control',
    });
    expect(x.host.body.textContent).toContain('已加入注释草稿');
    expect(x.f.submitted).toHaveLength(2);
    await x.flush(() =>
      x.host.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await x.flush(() => x.button('点击所选元素').click());
    await x.until(() => x.f.submitted.length === 3 && !x.button('点击所选元素'));
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

test('late frame bodies cannot restore a previous session or action authority across hide and reopen', async () => {
  const x = await setup();
  const delayed: ReturnType<typeof x.f.deferNextResponse>[] = [];
  x.f.view.state = 'human';
  x.f.view.title = 'Previous session';
  x.f.view.selectedAnnotation = x.f.view.annotations[0]!;
  try {
    await x.render();
    await x.until(() => !!x.button('点击所选元素') && !x.button('点击所选元素').disabled);
    const previous = x.f.deferNextResponse('extensions.read');
    delayed.push(previous);
    await x.until(() => previous.held);
    const scope = { ...browserScope, generation: 2, viewSelection: 2, sessionId: 'next-session' };
    x.f.scope = scope;
    x.f.view = {
      ...browserView(),
      browserId: 'next-browser',
      generation: 'next-generation',
      title: 'Next session',
      state: 'human',
      annotations: [],
    };
    await x.render(true, true, scope);
    await x.until(
      () =>
        x.host.body.textContent?.includes('Next session') === true &&
        !x.button('交还 Agent').disabled,
    );
    await x.flush(() => previous.release());
    expect(x.host.body.textContent).not.toContain('Previous session');
    expect(x.host.body.textContent).not.toContain('@e1');
    expect(x.button('引用到对话')).toBeUndefined();
    const hidden = x.f.deferNextResponse('extensions.read');
    delayed.push(hidden);
    await x.until(() => hidden.held);
    await x.render(false, true, scope);
    x.f.view.title = 'Newest frame';
    x.f.view.seq = '2';
    x.f.view.frame!.seq = '2';
    await x.render(true, true, scope);
    expect(x.button('交还 Agent').disabled).toBe(true);
    expect(x.host.body.textContent).toContain('此画面尚未重新核实');
    await x.flush(() => hidden.release());
    await x.until(
      () =>
        x.host.body.textContent?.includes('Newest frame') === true &&
        !x.button('交还 Agent').disabled,
    );
    expect(x.host.body.textContent).not.toContain('Next session');
    expect(x.host.body.textContent).not.toContain('Previous session');
    expect(x.f.submitted).toHaveLength(0);
    expect(x.quotes).toHaveLength(0);
  } finally {
    for (const response of delayed) response.release();
    await x.cleanup();
  }
});

test('an unknown page click stays blocked across panel reopen and repeated queries only recover its original command', async () => {
  const x = await setup();
  const lost = x.f.deferNextResponse('extensions.invoke');
  let recovery: ReturnType<typeof x.f.deferNextResponse> | undefined;
  x.f.view.state = 'human';
  x.f.view.selectedAnnotation = x.f.view.annotations[0]!;
  try {
    await x.render();
    await x.until(() => !!x.button('点击所选元素') && !x.button('点击所选元素').disabled);
    await x.flush(() => {
      x.button('点击所选元素').click();
      x.button('点击所选元素')?.click();
    });
    await x.until(() => lost.held);
    // Main completed the page click, but its response never reaches the renderer.
    x.f.drop = true;
    await x.flush(() => lost.drop());
    await x.until(() => !!x.button('查询原操作') && !x.button('引用到对话'));
    const original = x.f.submitted[0]!.commandId;
    expect(x.f.submitted[0]).toMatchObject({
      actionId: 'browser.input',
      input: { command: { action: 'click', ref: '@e1', seq: '1' } },
    });
    expect(x.button('向下滚动').disabled).toBe(true);
    expect(x.button('交还 Agent').disabled).toBe(true);
    expect(x.button('结束浏览器').disabled).toBe(true);
    await x.flush(() => x.root.render(null));
    await x.render();
    await x.until(() => !!x.button('查询原操作') && !!x.button('交还 Agent'));
    expect(x.button('向下滚动').disabled).toBe(true);
    expect(x.host.body.textContent).toContain('不会重复提交');
    x.f.drop = false;
    recovery = x.f.deferNextResponse('extensions.lookup');
    const lookups = () => x.f.calls.filter((call) => call.method === 'extensions.lookup');
    const count = lookups().length;
    await x.flush(() => {
      x.button('查询原操作').click();
      x.button('查询原操作').click();
    });
    await x.until(() => recovery!.held);
    await x.flush(() => x.button('查询原操作').click());
    expect(lookups()).toHaveLength(count + 1);
    expect(x.button('向下滚动').disabled).toBe(true);
    await x.flush(() => recovery!.release());
    await x.until(() => !x.button('查询原操作') && !x.button('向下滚动').disabled);
    expect(lookups().every((call) => 'commandId' in call && call.commandId === original)).toBe(
      true,
    );
    expect(x.f.calls.filter((call) => call.method === 'extensions.invoke')).toHaveLength(1);
    expect(x.f.submitted).toHaveLength(1);
    expect(x.button('引用到对话')).toBeUndefined();
    expect(x.quotes).toHaveLength(0);
  } finally {
    lost.release();
    recovery?.release();
    await x.cleanup();
  }
});

test('Agent-running frozen picker highlights one smallest hit, keeps original frame after updates, and Escape/scope change never hands off', async () => {
  const x = await setup();
  x.f.view.annotations.push({
    ref: '@e2',
    number: 2,
    role: 'group',
    name: 'overlap',
    box: { x: 0, y: 0, width: 500, height: 400 },
  });
  try {
    await x.render();
    await x.until(() => !!x.button('暂停并接管'));
    const image = x.host.querySelector('img')!;
    image.getBoundingClientRect = () => new x.dom.window.DOMRect(20, 30, 400, 300);
    await x.flush(() => image.dispatchEvent(new x.dom.window.Event('load')));
    await x.flush(() => x.button('⌖ 指向元素').click());
    const frame = x.host.querySelector('.agent-browser-frame')!;
    await x.flush(() =>
      frame.dispatchEvent(
        new x.dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 90 }),
      ),
    );
    expect(x.host.querySelectorAll('.agent-browser-region')).toHaveLength(1);
    await x.flush(() =>
      frame.dispatchEvent(
        new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
      ),
    );
    expect(x.host.querySelector('.agent-browser-note strong')?.textContent).toContain('Continue');
    x.f.view = {
      ...x.f.view,
      seq: '2',
      title: 'New live title',
      frame: { ...x.f.view.frame!, seq: '2', data: '/9j/3Q==' },
    };
    await x.until(() => x.host.body.textContent?.includes('New live title') === true);
    expect(x.host.querySelector('img')?.src).toContain('/9j/2Q==');
    expect(x.host.body.textContent).toContain('页面已有更新');
    await x.flush(() => x.button('加入提示词').click());
    expect(x.quotes[0]).toMatchObject({
      source: { seq: '1', frameSeq: '1' },
      element: { ref: '@e1' },
    });
    expect(x.f.submitted).toHaveLength(0);
    await x.flush(() =>
      x.host.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(x.host.querySelector('img')?.src).toContain('/9j/3Q==');
    expect(x.f.submitted).toHaveLength(0);
    const scope = { ...browserScope, sessionId: 'other', viewSelection: 2 };
    x.f.scope = scope;
    await x.render(true, true, scope);
    expect(x.host.querySelector('.agent-browser-note')).toBeNull();
    expect(x.host.querySelectorAll('.agent-browser-region')).toHaveLength(0);
  } finally {
    await x.cleanup();
  }
});
