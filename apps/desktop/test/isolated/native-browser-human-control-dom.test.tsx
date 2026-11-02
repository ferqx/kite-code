import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBrowserMenuAction,
  NativeBrowserMenuRequest,
  NativeBrowserState,
} from '../../src/native-browser-bridge';
import { browserFixture, browserScope } from '../agent-browser.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

async function fixture(options: Parameters<typeof browserFixture>[0] = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restore = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const { NativeBrowserLeaseControls } = await import('../../src/native-browser-lease-controls');
  const root = createRoot(document.getElementById('root')!);
  const browser = browserFixture(options),
    menus: NativeBrowserMenuRequest[] = [],
    cancels: string[] = [];
  let resolve!: (action: NativeBrowserMenuAction | null) => void;
  Object.assign(dom.window, {
    kiteNative: {
      showBrowserMenu(input: NativeBrowserMenuRequest) {
        menus.push(input);
        return new Promise<NativeBrowserMenuAction | null>((done) => {
          resolve = done;
        });
      },
      cancelBrowserMenu(id: string) {
        cancels.push(id);
      },
    },
  });
  const flush = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(35);
    });
  const page = (
    phase: NonNullable<NativeBrowserState['control']>['phase'],
  ): NativeBrowserState => ({
    id: 'page',
    title: 'Page',
    url: 'http://localhost/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    control: {
      phase,
      sessionId: 'session',
      browserId: 'browser',
      incarnation: 'page-inc',
      navigation: 0,
    },
  });
  const render = async (
    phase: NonNullable<NativeBrowserState['control']>['phase'],
    visible = true,
    canInvoke = true,
  ) => {
    await flush(() =>
      root.render(
        <NativeBrowserLeaseControls
          bridge={browser.bridge}
          scope={browserScope}
          page={page(phase)}
          visible={visible}
          canRead
          canInvoke={canInvoke}
        />,
      ),
    );
    await flush();
  };
  const trigger = () => document.querySelector<HTMLButtonElement>('[aria-label="浏览器控制"]')!;
  return {
    browser,
    menus,
    cancels,
    render,
    trigger,
    flush,
    choose: (action: NativeBrowserMenuAction | null) => flush(() => resolve(action)),
    async open() {
      await flush(() => trigger().click());
      return menus.at(-1)!;
    },
    async close() {
      await act(() => root.unmount());
      restore();
      dom.window.close();
      Object.assign(globalThis, prior);
    },
  };
}
for (const [phase, state, label, handoff] of [
  ['acquiring', 'starting', '接管中', true],
  ['agent', 'agent', 'Agent', true],
  ['human', 'human', '人工', false],
  ['unknown', 'outcome_unknown', '待核实', false],
] as const)
  test(`native ${phase} controls retain the original target and only offer Takeover/Stop`, async () => {
    const f = await fixture();
    try {
      f.browser.view = {
        ...f.browser.view,
        state,
        humanRequest: 'Complete the form manually; saved reason remains readable.',
      };
      await f.render(phase);
      expect(f.trigger().textContent).toBe(label);
      const menu = await f.open();
      expect(menu).toMatchObject({
        id: 'page',
        incarnation: 'page-inc',
        navigation: 0,
        scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 },
      });
      expect(menu.details.join('')).toContain('saved reason');
      expect(menu.items).toEqual([
        { action: 'handoff', enabled: handoff },
        { action: 'close', enabled: true },
      ]);
      expect(document.querySelectorAll('button')).toHaveLength(1);
      expect(menu.items.some((item) => /resume|continue|human/.test(item.action))).toBe(false);
      await f.choose(handoff ? 'handoff' : 'close');
      expect(f.browser.submitted).toHaveLength(1);
      expect(f.browser.submitted[0]).toMatchObject({
        actionId: handoff ? 'browser.handoff' : 'browser.close',
        input: { browserId: 'browser', generation: 'browser-generation' },
      });
    } finally {
      await f.close();
    }
  });

test('selection/visibility cancellation rejects late menu actions and read-only state disables shrink actions', async () => {
  const f = await fixture();
  try {
    await f.render('agent');
    const first = await f.open();
    await f.render('agent', false);
    expect(f.cancels).toEqual([first.requestId]);
    await f.choose('handoff');
    expect(f.browser.submitted).toHaveLength(0);
    await f.render('agent', true, false);
    const readOnly = await f.open();
    expect(readOnly.items.every((item) => !item.enabled)).toBe(true);
    await f.choose('close');
    expect(f.browser.submitted).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('lost original action exposes accurate lookup details without a duplicate action', async () => {
  const f = await fixture();
  try {
    f.browser.drop = true;
    await f.render('agent');
    await f.open();
    await f.choose('handoff');
    expect(f.browser.submitted).toHaveLength(1);
    const menu = await f.open();
    expect(menu.items).toContainEqual({ action: 'checkOriginal', enabled: true });
    expect(menu.details.join('')).toContain('不会重复提交');
    await f.choose('checkOriginal');
    expect(f.browser.submitted).toHaveLength(1);
    expect(f.browser.calls.some((call) => call.method === 'extensions.lookup')).toBe(true);
  } finally {
    await f.close();
  }
});

test('freshness recheck leaves the native popup open but selection still requires current admission', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await f.render('agent');
    await f.open();
    f.browser.queryGate = new Promise<void>((done) => {
      release = done;
    });
    await act(async () => {
      await Bun.sleep(1700);
    });
    expect(f.cancels).toHaveLength(0);
    await f.choose('handoff');
    expect(f.browser.submitted).toHaveLength(0);
    expect(f.trigger().title).toContain('状态已变化，原操作未发送');
    expect(f.trigger().dataset.status).toBe('error');
  } finally {
    release?.();
    f.browser.queryGate = undefined;
    await f.flush();
    await f.close();
  }
});

test('a pending original action leaves the native popup open and prevents a second action', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const f = await fixture({ beforeAction: () => held });
  const { createAgentBrowserObservationOwner } = await import(
    '../../src/agent-browser-observation-owner'
  );
  const other = createAgentBrowserObservationOwner(f.browser.bridge, browserScope, () => {}, true);
  let original: Promise<boolean> | undefined;
  try {
    await f.render('agent');
    await f.open();
    other.start(true);
    original = other.invoke('handoff', { browserId: 'browser', generation: 'browser-generation' });
    await f.flush();
    expect(f.browser.submitted).toHaveLength(1);
    expect(f.cancels).toHaveLength(0);
    await f.choose('close');
    expect(f.browser.submitted).toHaveLength(1);
    expect(f.browser.submitted[0]!.actionId).toBe('browser.handoff');
  } finally {
    release();
    await original;
    other.stop();
    await f.close();
  }
});
