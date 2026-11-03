import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createAgentBrowserObservationOwner } from '../../src/agent-browser-observation-owner';
import type { BrowserNoteInput } from '../../src/browser-annotation-drafts';
import { browserFixture, browserScope, browserView } from '../agent-browser.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

async function setup() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const restore = prepareDesktopDom(dom);
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
  const { AgentBrowserPanel } = await import('../../src/agent-browser-panel');
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
  const render = (
    visible = true,
    canInvoke = true,
    scope = browserScope,
    options: {
      annotationOnly?: boolean;
      annotationToolbarHost?: HTMLElement | null;
      expectedBrowserId?: string;
    } = {},
  ) =>
    flush(() =>
      root.render(
        <AgentBrowserPanel
          {...options}
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
      (button) => button.textContent === text || button.getAttribute('aria-label') === text,
    )!;
  const cleanup = async () => {
    await act(async () => root.unmount());
    // Radix restores focus in a zero-delay teardown; drain it before restoring the realm.
    await act(async () => {
      await Bun.sleep(30);
    });
    dom.window.close();
    restore();
    Object.assign(globalThis, previous);
  };
  const showMore = async () => {
    await until(() => !!button('更多浏览器操作'));
    if (button('更多浏览器操作').getAttribute('aria-expanded') !== 'true')
      await flush(() => button('更多浏览器操作').click());
  };
  return {
    dom,
    f,
    quotes,
    root,
    flush,
    until,
    render,
    button,
    showMore,
    cleanup,
    host: dom.window.document,
  };
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
    await x.showMore();
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
    await x.flush(() => x.button('更多浏览器操作').click());
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
    await x.showMore();
    await x.flush(() => x.button('点击所选元素').click());
    await x.until(() => x.f.submitted.length === 3 && !x.button('点击所选元素'));
    expect(x.f.submitted[2]).toMatchObject({
      actionId: 'browser.input',
      input: { command: { action: 'click', ref: '@e1', seq: '1' } },
    });
    expect(x.host.body.textContent).toMatch(/原引用已失效|此画面尚未重新核实，操作与引用暂不可用/);
    expect(x.button('点击所选元素')).toBeUndefined();
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
    await x.showMore();
    expect(x.host.querySelector('.agent-browser-more')).not.toBeNull();
    await x.render(false);
    expect(x.host.querySelector('.agent-browser-more')).toBeNull();
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
    await x.showMore();
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
    await x.showMore();
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
    await x.showMore();
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
    await x.showMore();
    expect(x.button('结束浏览器').disabled).toBe(true);
    await x.flush(() => x.root.render(null));
    await x.render();
    await x.showMore();
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

test('address navigation requires explicit handoff, binds current generation, blocks IME/unsafe URLs and deduplicates pending Enter', async () => {
  const x = await setup();
  try {
    await x.render();
    await x.until(() => !!x.button('暂停并接管'));
    const address = () => x.host.querySelector<HTMLInputElement>('[aria-label="打开网址"]')!;
    const form = () => x.host.querySelector<HTMLFormElement>('.agent-browser-location')!;
    const edit = async (value: string) =>
      x.flush(() => {
        Object.getOwnPropertyDescriptor(
          x.dom.window.HTMLInputElement.prototype,
          'value',
        )!.set!.call(address(), value);
        address().dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
      });
    const submit = () =>
      form().dispatchEvent(new x.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await edit('https://example.test/manual');
    await x.flush(submit);
    expect(x.f.submitted).toHaveLength(0);
    await x.flush(() => x.button('暂停并接管').click());
    await x.until(() => !!x.button('交还 Agent') && !x.button('交还 Agent').disabled);
    // The handoff changed generation; an edit from the Agent generation is not executable.
    expect(address().value).toBe('https://example.test/');
    await edit('javascript:alert(1)');
    await x.flush(submit);
    expect(x.host.body.textContent).toContain('完整 HTTP 或 HTTPS');
    expect(x.f.submitted).toHaveLength(1);
    await edit('https://user:secret@example.test/');
    await x.flush(submit);
    expect(x.f.submitted).toHaveLength(1);
    await edit('http://127.0.0.1:4321/local');
    await x.flush(() => {
      address().dispatchEvent(
        new x.dom.window.CompositionEvent('compositionstart', { bubbles: true }),
      );
      submit();
    });
    expect(x.f.submitted).toHaveLength(1);
    await x.flush(() =>
      address().dispatchEvent(
        new x.dom.window.CompositionEvent('compositionend', { bubbles: true }),
      ),
    );
    const gate = x.f.deferNextResponse('extensions.invoke');
    await x.flush(() => {
      submit();
      submit();
    });
    await x.until(() => gate.held);
    expect(x.f.submitted).toHaveLength(2);
    expect(x.f.submitted[1]).toMatchObject({
      actionId: 'browser.input',
      input: {
        browserId: 'browser',
        generation: 'human-generation',
        command: { action: 'navigate', url: 'http://127.0.0.1:4321/local' },
      },
    });
    expect(x.host.body.textContent).toContain('正在核实原操作');
    await x.flush(submit);
    expect(x.f.submitted).toHaveLength(2);
    gate.drop();
    await x.until(() => !!x.button('前往') && !x.button('前往').disabled);
    expect(x.f.submitted).toHaveLength(2);
    await edit('https://example.test/unsent');
    await x.flush(() =>
      address().dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(address().value).toBe('https://example.test/');
    await edit('https://example.test/stale');
    x.f.view = { ...x.f.view, generation: 'next-generation', url: 'https://example.test/next' };
    await x.until(() => address().value === 'https://example.test/next');
    const oldForm = form();
    await x.render(true, true, { ...browserScope, sessionId: 'other' });
    expect(oldForm.isConnected).toBe(false);
    await x.flush(() =>
      oldForm.dispatchEvent(new x.dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(x.f.submitted).toHaveLength(2);
  } finally {
    await x.cleanup();
  }
});

test('hidden browser tab ignores foreground Escape and preserves an unfinished frozen note; visible Escape exits', async () => {
  const x = await setup();
  try {
    await x.render();
    await x.until(() => !!x.button('暂停并接管'));
    const image = x.host.querySelector('img')!;
    image.getBoundingClientRect = () => new x.dom.window.DOMRect(20, 30, 400, 300);
    await x.flush(() => image.dispatchEvent(new x.dom.window.Event('load')));
    await x.flush(() => x.button('⌖ 指向元素').click());
    await x.flush(() =>
      x.host
        .querySelector('.agent-browser-frame')!
        .dispatchEvent(
          new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
        ),
    );
    const note = () => x.host.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]');
    const draft = '尚未加入卡片的备注，请保留。';
    await x.flush(() => {
      Object.getOwnPropertyDescriptor(
        x.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(note(), draft);
      note()!.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
    });
    expect(note()?.value).toBe(draft);
    await x.render(false);
    expect(note()?.value).toBe(draft);
    await x.flush(() =>
      x.host.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(note()?.value).toBe(draft);
    expect(x.host.querySelectorAll('.agent-browser-frame .agent-browser-region')).toHaveLength(1);
    x.f.view = {
      ...x.f.view,
      seq: '2',
      title: 'Latest page',
      frame: { ...x.f.view.frame!, seq: '2', data: '/9j/3Q==' },
    };
    await x.render();
    await x.until(() => x.host.body.textContent?.includes('Latest page') === true);
    expect(note()?.value).toBe(draft);
    expect(x.host.querySelector('img')?.src).toContain('/9j/2Q==');
    expect(x.host.body.textContent).toContain('页面已有更新');
    await x.flush(() =>
      x.host.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(note()).toBeNull();
    expect(x.host.querySelectorAll('.agent-browser-frame .agent-browser-region')).toHaveLength(0);
    expect(x.host.querySelector('img')?.src).toContain('/9j/3Q==');
    expect(x.quotes).toHaveLength(0);
    expect(x.f.submitted).toHaveLength(0);
  } finally {
    await x.cleanup();
  }
});

test('Native external annotation tools keep content image-only, auto-focus historical editing and preserve dismissed or hidden drafts', async () => {
  const x = await setup();
  const toolbar = x.host.createElement('form');
  const slot = x.host.createElement('span');
  toolbar.append(slot);
  x.host.body.append(toolbar);
  const options = {
    annotationOnly: true,
    annotationToolbarHost: slot,
    expectedBrowserId: 'browser',
  };
  const panel = () => x.host.querySelector<HTMLElement>('[aria-label="冻结快照注释"]')!;
  const editor = () => x.host.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]');
  try {
    await x.render(true, false, browserScope, options);
    await x.until(() => !!panel()?.querySelector('img'));
    const image = panel().querySelector('img')!;
    image.getBoundingClientRect = () => new x.dom.window.DOMRect(20, 30, 400, 300);
    await x.flush(() => image.dispatchEvent(new x.dom.window.Event('load')));
    expect(slot.querySelector('[aria-label="网页注释工具"]')).not.toBeNull();
    expect(slot.querySelector('button')?.getAttribute('data-size')).toBe('icon-sm');
    expect(panel().querySelector('.is-pointing')).not.toBeNull();
    expect(
      panel().querySelector(
        'form, .agent-browser-toolbar, header, p, [role="status"], [role="alert"]',
      ),
    ).toBeNull();
    expect(panel().textContent).toBe('');
    await x.flush(() =>
      panel()
        .querySelector('.agent-browser-frame')!
        .dispatchEvent(
          new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
        ),
    );
    await x.until(() => !!editor());
    expect(x.host.activeElement).toBe(editor());
    expect(editor()?.closest('.agent-browser-annotation-tools')).not.toBeNull();
    expect(toolbar.querySelector('form')).toBeNull();
    expect(panel().querySelector('form')).toBeNull();
    const draft = '保留此历史备注';
    await x.flush(() => {
      Object.getOwnPropertyDescriptor(
        x.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(editor(), draft);
      editor()!.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
    });
    await x.flush(() => x.button('网页注释工具').click());
    expect(editor()).toBeNull();
    expect(panel().querySelector('.is-pointing')).not.toBeNull();
    await x.flush(() => x.button('网页注释工具').click());
    await x.until(() => !!editor());
    expect(editor()?.value).toBe(draft);
    await x.render(false, false, browserScope, options);
    expect(editor()).toBeNull();
    expect(slot.childElementCount).toBe(0);
    await x.flush(() =>
      x.host.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await x.render(true, false, browserScope, options);
    await x.flush(() => x.button('网页注释工具').click());
    await x.until(() => !!editor());
    expect(editor()?.value).toBe(draft);
    x.f.view = {
      ...x.f.view,
      seq: '2',
      title: 'New live title',
      frame: { ...x.f.view.frame!, seq: '2', data: '/9j/3Q==' },
    };
    await x.until(() => x.host.body.textContent?.includes('New live title') === true);
    expect(panel().querySelector('img')?.src).toContain('/9j/2Q==');
    expect(x.host.body.textContent).toContain('页面已有更新');
    await x.flush(() => x.button('加入提示词').click());
    expect(x.quotes[0]).toMatchObject({
      note: draft,
      source: { seq: '1', frameSeq: '1' },
      element: { ref: '@e1' },
    });
    expect(editor()).toBeNull();
    await x.flush(() =>
      x.host.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(panel().querySelector('.is-pointing')).toBeNull();
    expect(panel().querySelector('img')?.src).toContain('/9j/3Q==');
    expect(x.f.submitted).toHaveLength(0);
  } finally {
    await x.cleanup();
  }
});

test('Native external annotation mode waits for a host without inline tools and host changes retain observer and frozen scope ownership', async () => {
  const x = await setup();
  const slot = x.host.createElement('span');
  const nextSlot = x.host.createElement('span');
  x.host.body.append(slot, nextSlot);
  const options = {
    annotationOnly: true,
    annotationToolbarHost: null as HTMLElement | null,
    expectedBrowserId: 'browser',
  };
  const panel = () => x.host.querySelector<HTMLElement>('[aria-label="冻结快照注释"]')!;
  try {
    await x.render(true, false, browserScope, options);
    await x.until(() => !!panel()?.querySelector('img'));
    expect(panel().textContent).toBe('');
    expect(panel().querySelector('.agent-browser-toolbar, form, p')).toBeNull();
    expect(x.button('网页注释工具')).toBeUndefined();
    const image = panel().querySelector('img')!;
    await x.flush(() => image.dispatchEvent(new x.dom.window.Event('load')));
    const opened = x.f.calls.filter((call) => call.method === 'extensions.open').length;
    options.annotationToolbarHost = slot;
    await x.render(true, false, browserScope, options);
    expect(slot.querySelector('[aria-label="网页注释工具"]')).not.toBeNull();
    expect(panel().querySelector('.is-pointing')).not.toBeNull();
    options.annotationToolbarHost = nextSlot;
    await x.render(true, false, browserScope, options);
    expect(slot.childElementCount).toBe(0);
    expect(nextSlot.querySelector('[aria-label="网页注释工具"]')).not.toBeNull();
    expect(panel().querySelector('.is-pointing')).not.toBeNull();
    expect(x.f.calls.filter((call) => call.method === 'extensions.open')).toHaveLength(opened);
    const scope = { ...browserScope, sessionId: 'other', viewSelection: 2 };
    x.f.scope = scope;
    await x.render(true, false, scope, options);
    expect(panel().querySelector('.is-pointing')).toBeNull();
    expect(x.host.querySelector('[aria-label="注释说明"]')).toBeNull();
    expect(x.f.submitted).toHaveLength(0);
  } finally {
    await x.cleanup();
  }
});

test('external annotation popup cancel and visible Escape clear only the unfinished selection without submitting browser actions', async () => {
  const x = await setup();
  const slot = x.host.createElement('span');
  x.host.body.append(slot);
  const options = { annotationOnly: true, annotationToolbarHost: slot };
  const panel = () => x.host.querySelector('[aria-label="冻结快照注释"]')!;
  const editor = () => x.host.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]');
  const pick = () =>
    panel()
      .querySelector('.agent-browser-frame')!
      .dispatchEvent(
        new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
      );
  try {
    await x.render(true, false, browserScope, options);
    await x.until(() => !!panel()?.querySelector('img'));
    const image = panel().querySelector('img')!;
    image.getBoundingClientRect = () => new x.dom.window.DOMRect(20, 30, 400, 300);
    await x.flush(() => image.dispatchEvent(new x.dom.window.Event('load')));
    await x.flush(pick);
    await x.until(() => !!editor());
    await x.flush(() => x.button('取消').click());
    expect(editor()).toBeNull();
    expect(panel().querySelector('.is-pointing')).not.toBeNull();
    await x.flush(() => x.button('网页注释工具').click());
    await x.flush(pick);
    await x.until(() => !!editor());
    await x.flush(() =>
      editor()!.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(editor()).toBeNull();
    expect(panel().querySelector('.is-pointing')).toBeNull();
    expect(x.button('网页注释工具').getAttribute('aria-expanded')).toBe('false');
    await x.flush(() => x.button('网页注释工具').click());
    expect(editor()).toBeNull();
    expect(x.button('⌖ 指向元素')).not.toBeUndefined();
    expect(x.quotes).toHaveLength(0);
    expect(x.f.submitted).toHaveLength(0);
  } finally {
    await x.cleanup();
  }
});

test('an annotation image decoded while hidden starts pointing on reveal without a second load and never freezes an old scope', async () => {
  const x = await setup();
  const toolbar = x.host.createElement('form'),
    slot = x.host.createElement('span');
  toolbar.append(slot);
  x.host.body.append(toolbar);
  const options = {
    annotationOnly: true,
    annotationToolbarHost: slot,
    expectedBrowserId: 'browser',
  };
  const reader = createAgentBrowserObservationOwner(x.f.bridge, browserScope, () => {}, false);
  const panel = () => x.host.querySelector<HTMLElement>('[aria-label="冻结快照注释"]')!;
  const editor = () => x.host.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]');
  const pick = () =>
    panel()
      .querySelector('.agent-browser-frame')!
      .dispatchEvent(
        new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 90 }),
      );
  let releaseNext!: () => void;
  const nextRead = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  try {
    await x.render(false, false, browserScope, options);
    expect(panel().querySelector('img')).toBeNull();
    // The ordinary page controls keep the same-scope observation alive while
    // Native's retained annotation surface is hidden.
    await x.flush(() => reader.start(true));
    await x.until(() => !!panel().querySelector('img'));
    const image = panel().querySelector('img')!,
      source = image.src;
    image.getBoundingClientRect = () => new x.dom.window.DOMRect(20, 30, 400, 300);
    let loads = 0;
    image.addEventListener('load', () => loads++);
    await x.flush(() => image.dispatchEvent(new x.dom.window.Event('load')));
    expect(loads).toBe(1);
    expect(panel().querySelector('.is-pointing')).toBeNull();
    expect(slot.childElementCount).toBe(0);

    await x.render(true, false, browserScope, options);
    await x.until(() => !!panel().querySelector('.is-pointing'));
    expect(panel().querySelector('img') === image).toBe(true);
    expect(image.src).toBe(source);
    expect(loads).toBe(1);
    await x.flush(pick);
    await x.until(() => !!editor());
    expect(x.host.activeElement === editor()).toBe(true);
    const draft = '隐藏时已解码，显示后写下的历史备注';
    await x.flush(() => {
      Object.getOwnPropertyDescriptor(
        x.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(editor(), draft);
      editor()!.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
    });
    await x.render(false, false, browserScope, options);
    expect(editor()).toBeNull();
    expect(panel().querySelector('.is-pointing')).not.toBeNull();
    await x.render(true, false, browserScope, options);
    expect(panel().querySelector('img') === image).toBe(true);
    expect(image.src).toBe(source);
    expect(loads).toBe(1);
    await x.flush(() => x.button('网页注释工具').click());
    await x.until(() => !!editor());
    expect(editor()?.value).toBe(draft);

    await x.flush(() =>
      editor()!.dispatchEvent(
        new x.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await x.flush(() => {}, 400);
    expect(panel().querySelector('.is-pointing')).toBeNull();
    expect(editor()).toBeNull();
    await x.flush(() => x.button('网页注释工具').click());
    await x.flush(() => x.button('⌖ 指向元素').click());
    expect(panel().querySelector('.is-pointing')).not.toBeNull();
    await x.flush(() => x.button('⌖ 退出指向 · Esc').click());
    await x.flush(() => {}, 400);
    expect(panel().querySelector('.is-pointing')).toBeNull();
    expect(loads).toBe(1);

    const nextScope = { ...browserScope, sessionId: 'next-session', viewSelection: 2 };
    x.f.scope = nextScope;
    x.f.view = {
      ...browserView(),
      title: 'Next scope with identical image bytes',
      generation: 'next-browser-generation',
    };
    x.f.queryGate = nextRead;
    await x.render(true, false, nextScope, options);
    expect(panel().querySelector('.is-pointing')).toBeNull();
    expect(editor()).toBeNull();
    expect(panel().querySelector('img')).toBeNull();
    await x.flush(() => releaseNext());
    await x.until(() => !!panel().querySelector('img'));
    expect(panel().querySelector('.is-pointing')).toBeNull();
    const nextImage = panel().querySelector('img')!;
    expect(nextImage.src).toBe(source);
    nextImage.getBoundingClientRect = () => new x.dom.window.DOMRect(20, 30, 400, 300);
    await x.flush(() => nextImage.dispatchEvent(new x.dom.window.Event('load')));
    await x.until(() => !!panel().querySelector('.is-pointing'));
    await x.flush(pick);
    await x.until(() => !!editor());
    expect(editor()?.value).toBe('');
    await x.flush(() => x.button('加入提示词').click());
    expect(x.quotes).toHaveLength(1);
    expect(x.quotes[0]).toMatchObject({
      source: {
        generation: 'next-browser-generation',
        title: 'Next scope with identical image bytes',
      },
      element: { ref: '@e1' },
    });
    expect(x.f.submitted).toHaveLength(0);
  } finally {
    releaseNext();
    reader.stop();
    await x.cleanup();
  }
});
