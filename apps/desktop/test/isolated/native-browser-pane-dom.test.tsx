import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps, useLayoutEffect } from 'react';
import { expect, test } from '#kite-test';
import type {
  NativeBrowserMenuAction,
  NativeBrowserMenuRequest,
  NativeBrowserRequest,
  NativeBrowserState,
} from '../../src/native-browser-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

type Placement = Extract<NativeBrowserRequest, { action: 'present' }>;
const bootstrap = new JSDOM('<!doctype html><div></div>', { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { createPortal } = await import('react-dom');
const { NativeBrowserPane } = await import('../../src/native-browser-pane');
bootstrap.window.close();
const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
const loaded = (id = 'page', token = 'page-document-1'): NativeBrowserState => ({
  id,
  title: 'Original',
  url: 'https://example.test/original',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  display: 'ready',
  pageToken: token,
});

test('Windows hands seam paint to Native only after admission and updates grip interaction without a resize', async () => {
  const f = await fixture(loaded(), 'windows', true);
  const paint = () =>
    act(async () => {
      await new Promise((resolve) =>
        f.dom.window.requestAnimationFrame(() => f.dom.window.requestAnimationFrame(resolve)),
      );
    });
  try {
    await f.show();
    expect(f.layouts.at(-1)?.layout?.frame).toMatchObject({
      top: 38,
      bottom: 6,
      width: 1,
      color: [255, 255, 255, 0.08],
      grip: { left: -1.5, width: 3, height: 28, visible: false },
    });
    expect(
      document.querySelector('.native-browser-viewport')?.getAttribute('data-native-browser-frame'),
    ).toBe('true');
    await f.flush(() => {
      const handle = document.querySelector<HTMLElement>('#panel-handle')!;
      handle.tabIndex = 0;
      handle.focus();
      expect(handle.matches(':focus-visible')).toBe(true);
    });
    await f.remeasure();
    expect(f.layouts.at(-1)?.layout?.frame?.grip.visible).toBe(false);
    await f.flush(() =>
      document.querySelector('#panel-handle')!.setAttribute('data-separator', 'active'),
    );
    await paint();
    expect(f.layouts.at(-1)?.layout?.frame?.grip.visible).toBe(true);
    await f.resize(550, 444);
    expect(f.syncLayouts.at(-1)?.bounds?.x).toBe(550);
    expect(f.syncLayouts.at(-1)?.layout?.frame?.grip.visible).toBe(true);
    await f.flush(() => document.querySelector('#panel-handle')!.removeAttribute('data-separator'));
    await paint();
    expect(f.layouts.at(-1)?.layout?.frame?.grip.visible).toBe(false);
    await f.show({ visible: false });
    expect(document.querySelector('[data-native-browser-frame]')).toBeNull();
    expect(f.withdrawals.at(-1)?.bounds).toBeNull();
  } finally {
    await f.close();
  }
});

async function fixture(
  initial: NativeBrowserState = loaded(),
  panels: boolean | 'windows' | 'windows-shell' = false,
  nativeFrame = false,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const restore = prepareDesktopDom(dom);
  if (nativeFrame) document.documentElement.dataset.platform = 'windows';
  Object.assign(dom.window, { innerWidth: 1000, innerHeight: 800 });
  const windowsPanels = panels === 'windows' || panels === 'windows-shell';
  const shellInset = panels === 'windows-shell' ? 6 : 0;
  let x = 600,
    width = windowsPanels ? 394 : 400,
    clipWidth = 1000;
  let overlayRect = new dom.window.DOMRect(0, 0, 1000, 800);
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (windowsPanels) {
      if (this.classList.contains('right-sidebar'))
        return new dom.window.DOMRect(x, 38, width, 756);
      if (this.classList.contains('resizable-grip'))
        return new dom.window.DOMRect(x - 1.5, 402, 3, 28);
      if (this.id === 'navigation')
        return new dom.window.DOMRect(shellInset, 32 + shellInset, 200, 768 - shellInset * 2);
      if (this.id === 'navigation-handle')
        return new dom.window.DOMRect(200 + shellInset, 32 + shellInset, 1, 768 - shellInset * 2);
      if (this.id === 'workspace')
        return new dom.window.DOMRect(
          201 + shellInset,
          32 + shellInset,
          799 - shellInset * 2,
          768 - shellInset * 2,
        );
      if (this.classList.contains('native-window-content'))
        return new dom.window.DOMRect(0, 32, 1000, 768);
      if (this.classList.contains('client-panels'))
        return new dom.window.DOMRect(
          shellInset,
          32 + shellInset,
          1000 - shellInset * 2,
          768 - shellInset * 2,
        );
      if (
        this.classList.contains('client-content-frame') ||
        this.classList.contains('client-content-panels')
      )
        return new dom.window.DOMRect(207, 38, 787, 756);
      if (this.id === 'panel-left') return new dom.window.DOMRect(207, 38, x - 208, 756);
      if (this.id === 'panel-handle') return new dom.window.DOMRect(x - 1, 38, 1, 756);
      if (this.id === 'panel-right') return new dom.window.DOMRect(x, 38, width, 756);
    }
    if (this.classList.contains('native-browser-viewport'))
      return new dom.window.DOMRect(x, 74, width, 725);
    if (this.id === 'panel-left') return new dom.window.DOMRect(0, 0, x - 1, 800);
    if (this.id === 'panel-handle') return new dom.window.DOMRect(x - 1, 0, 1, 800);
    if (this.id === 'panel-right') return new dom.window.DOMRect(x, 0, width, 800);
    if (this.id === 'clip') return new dom.window.DOMRect(0, 0, clipWidth, 800);
    if (this.matches('[data-test-overlay]')) return overlayRect;
    return new dom.window.DOMRect(0, 0, 1000, 800);
  };
  const resizeObservers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  class Resize {
    targets = new Set<Element>();
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    observe(node: Element) {
      this.targets.add(node);
    }
    unobserve(node: Element) {
      this.targets.delete(node);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  Object.assign(globalThis, { ResizeObserver: Resize });
  const root = createRoot(document.getElementById('root')!);
  const requests: NativeBrowserRequest[] = [],
    layouts: Placement[] = [],
    withdrawals: Placement[] = [],
    syncLayouts: Placement[] = [],
    asyncLayouts: Placement[] = [];
  const placements: { mode: 'sync' | 'async'; request: Placement }[] = [];
  let displayed: string | undefined;
  let admittedRevision = 0;
  const commits: (string | undefined)[] = [];
  function CommitObserver() {
    useLayoutEffect(() => {
      commits.push(displayed);
    });
    return null;
  }
  const menus: NativeBrowserMenuRequest[] = [],
    cancelledMenus: string[] = [];
  let state = initial;
  const listeners = new Set<(state: NativeBrowserState) => void>();
  const subscriptions: ((state: NativeBrowserState) => void)[] = [];
  const remeasures = new Set<() => void>();
  let requestHook:
    | ((input: NativeBrowserRequest) => Promise<NativeBrowserState | null>)
    | undefined;
  let hold: ((input: Placement) => Promise<NativeBrowserState | null>) | undefined;
  let menuResolve: (action: NativeBrowserMenuAction | null) => void = () => {};
  let menuReject: (cause: unknown) => void = () => {};
  const emit = (next: NativeBrowserState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const host = {
    async browserRequest(input: NativeBrowserRequest) {
      requests.push(input);
      if (requestHook) return requestHook(input);
      if (input.action === 'navigate') {
        emit({
          ...state,
          url: input.input,
          loading: true,
          display: 'loading',
          pageToken: 'navigation-2',
        });
      }
      return state.id === input.id ? state : null;
    },
    watchBrowser(listener: (value: NativeBrowserState) => void) {
      subscriptions.push(listener);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watchBrowserPresentation(listener: () => void) {
      remeasures.add(listener);
      return () => {
        remeasures.delete(listener);
      };
    },
    presentBrowserLayout(input: Placement) {
      placements.push({ mode: 'sync', request: input });
      if (input.bounds) {
        layouts.push(input);
        syncLayouts.push(input);
        if (input.presentationRevision! > admittedRevision) displayed = input.id;
      } else {
        withdrawals.push(input);
        if (input.presentationRevision! > admittedRevision && displayed === input.id)
          displayed = undefined;
      }
      admittedRevision = Math.max(admittedRevision, input.presentationRevision!);
      return state.id === input.id ? state : loaded(input.id, input.pageToken);
    },
    async presentBrowserLayoutAsync(input: Placement) {
      placements.push({ mode: 'async', request: input });
      layouts.push(input);
      asyncLayouts.push(input);
      const result = hold ? await hold(input) : state;
      if (input.presentationRevision! > admittedRevision) {
        admittedRevision = input.presentationRevision!;
        displayed = input.id;
      }
      return result;
    },
    showBrowserMenu(input: NativeBrowserMenuRequest) {
      menus.push(input);
      return new Promise<NativeBrowserMenuAction | null>((resolve, reject) => {
        menuResolve = resolve;
        menuReject = reject;
      });
    },
    cancelBrowserMenu(id: string) {
      cancelledMenus.push(id);
    },
  };
  Object.assign(dom.window, { kiteNative: host });
  let props: ComponentProps<typeof NativeBrowserPane> = {
    id: state.id,
    visible: true,
    tools: <p>Start tools</p>,
    onTitleChange() {},
    scope,
  };
  const flush = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await fixtureDelay(25);
    });
  const show = (next: Partial<typeof props> = {}) =>
    flush(() => {
      props = { ...props, ...next };
      const policy = JSON.stringify({
        minSize: '0%',
        maxSize: '100%',
        groupResizeBehavior: 'preserve-relative-size',
        collapsible: false,
      });
      const pane = panels ? (
        <div
          className={windowsPanels ? 'client-content-panels' : 'client-panels'}
          data-slot="resizable-panel-group"
          style={{ display: 'flex', flexDirection: 'row' }}
        >
          <div id="panel-left" data-panel data-native-browser-layout={policy} />
          <div id="panel-handle" data-slot="resizable-handle">
            {nativeFrame && (
              <span className="resizable-grip" style={{ backgroundColor: 'rgb(181, 181, 181)' }} />
            )}
          </div>
          <div id="panel-right" data-panel data-native-browser-layout={policy}>
            {nativeFrame ? (
              <aside
                className="right-sidebar"
                style={{ borderLeft: '1px solid rgba(255, 255, 255, 0.08)' }}
              >
                <NativeBrowserPane {...props} />
              </aside>
            ) : (
              <NativeBrowserPane {...props} />
            )}
          </div>
        </div>
      ) : (
        <NativeBrowserPane {...props} />
      );
      root.render(
        <div id="clip" style={{ overflow: 'hidden' }}>
          {windowsPanels ? (
            <div className="native-window-content" style={{ padding: `${shellInset}px` }}>
              <div
                className="client-panels"
                data-slot="resizable-panel-group"
                style={{ display: 'flex', flexDirection: 'row' }}
              >
                <div id="navigation" data-panel data-native-browser-layout={policy} />
                <div id="navigation-handle" data-slot="resizable-handle" />
                <div id="workspace" data-panel data-native-browser-layout={policy}>
                  <div>
                    <div
                      className="client-content-frame"
                      style={{ margin: `${shellInset ? 0 : 6}px` }}
                    >
                      {pane}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            pane
          )}
        </div>,
      );
    });
  const address = () => document.querySelector<HTMLInputElement>('.native-browser-address')!;
  const edit = (value: string) =>
    flush(() => {
      address().focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        address(),
        value,
      );
      address().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  return {
    dom,
    host,
    requests,
    layouts,
    withdrawals,
    syncLayouts,
    asyncLayouts,
    placements,
    commits,
    menus,
    cancelledMenus,
    show,
    unmountPane: () => flush(() => root.render(<CommitObserver />)),
    flush,
    address,
    edit,
    state: () => state,
    displayed: () => displayed,
    showPair: (active: 'a' | 'b' | undefined) =>
      flush(() =>
        root.render(
          <>
            {(['a', 'b'] as const).map((id) => (
              <NativeBrowserPane
                key={id}
                id={id}
                visible={active === id}
                scope={scope}
                initialHint={loaded(id, `${id}-document`)}
                tools={null}
                onTitleChange={() => {}}
              />
            ))}
            <CommitObserver />
          </>,
        ),
      ),
    withoutSync: () => {
      Reflect.deleteProperty(host, 'presentBrowserLayout');
    },
    update: (next: Partial<NativeBrowserState>) => flush(() => emit({ ...state, ...next })),
    updateAndRemeasure: (next: Partial<NativeBrowserState>) =>
      flush(() => {
        emit({ ...state, ...next });
        for (const listener of remeasures) listener();
      }),
    emit: (next: NativeBrowserState) => flush(() => emit(next)),
    late: (index: number, next: NativeBrowserState) => flush(() => subscriptions[index]!(next)),
    resize: (nextX: number, nextWidth: number, clip = 1000) =>
      flush(() => {
        x = nextX;
        width = nextWidth;
        clipWidth = clip;
        for (const observer of resizeObservers)
          if (observer.targets.size) observer.callback([], observer as unknown as ResizeObserver);
      }),
    hold: (hook: typeof hold) => {
      hold = hook;
    },
    requestHook: (hook: typeof requestHook) => {
      requestHook = hook;
    },
    remeasure: () =>
      flush(() => {
        for (const listener of remeasures) listener();
      }),
    overlay: (selector: string, rect = new dom.window.DOMRect(0, 0, 1000, 800)) =>
      flush(() => {
        overlayRect = rect;
        const overlay = document.createElement(selector === 'dialog' ? 'dialog' : 'div');
        overlay.setAttribute('data-test-overlay', '');
        if (selector === 'dialog') overlay.setAttribute('open', '');
        else if (selector.startsWith('slot=')) overlay.setAttribute('data-slot', selector.slice(5));
        else if (selector.startsWith('role=')) overlay.setAttribute('role', selector.slice(5));
        else overlay.setAttribute(selector, '');
        document.body.append(overlay);
      }),
    dismiss: () => flush(() => document.querySelector('[data-test-overlay]')?.remove()),
    click: (label: string) =>
      flush(() =>
        document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
      ),
    choose: (action: NativeBrowserMenuAction | null) => flush(() => menuResolve(action)),
    rejectMenu: () => flush(() => menuReject(Error('native failure'))),
    async close() {
      await act(() => root.unmount());
      restore();
      dom.window.close();
      Object.assign(globalThis, previous);
    },
  };
}

test('the same Root toolbar owns empty, navigation loading, drawable content and display failure', async () => {
  const f = await fixture({
    ...loaded(),
    url: '',
    pageToken: undefined,
    display: undefined,
    canGoBack: false,
  });
  try {
    await f.show();
    const input = f.address(),
      toolbar = document.querySelector('form');
    expect(document.body.textContent).toContain('Start tools');
    expect(f.layouts).toHaveLength(0);
    await f.edit('https://example.test/first');
    await f.flush(() =>
      toolbar!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(f.requests.filter((value) => value.action === 'navigate')).toEqual([
      { action: 'navigate', id: 'page', input: 'https://example.test/first' },
    ]);
    expect(f.address()).toBe(input);
    expect(document.querySelector('form')).toBe(toolbar);
    expect(document.querySelector('[aria-label="网页加载中"]')).not.toBeNull();
    expect(f.layouts.at(-1)).toMatchObject({
      id: 'page',
      pageToken: 'navigation-2',
      bounds: { x: 600, y: 74, width: 400, height: 725 },
    });
    await f.update({ display: 'ready', loading: false });
    expect(document.querySelector('.native-browser-start')).toBeNull();
    expect(f.address()).toBe(input);
    await f.update({ display: 'stopped', loading: false });
    expect(document.querySelector('[role="status"]')?.textContent).toBe('已停止加载');
    expect(document.querySelector('[role="alert"], [aria-label="网页加载中"]')).toBeNull();
    expect(f.address()).toBe(input);
    await f.update({ display: 'ready', loading: false });
    expect(document.querySelector('.native-browser-start')).toBeNull();
    await f.update({ display: 'failed' });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('网页显示尚未确认');
    expect(f.withdrawals.at(-1)?.bounds).toBeNull();
    expect(f.address()).toBe(input);
    expect(document.querySelector('canvas, img')).toBeNull();
  } finally {
    await f.close();
  }
});

for (const failure of ['layout', 'request'] as const)
  test(`refresh ${failure} scope retirement stays quiet and the current page can recover`, async () => {
    const f = await fixture();
    try {
      await f.show();
      const input = f.address(),
        toolbar = document.querySelector('form'),
        present = f.host.presentBrowserLayout;
      f.host.presentBrowserLayout = (request) => {
        if (request.bounds && request.pageToken === 'refresh-intermediate')
          throw Error('browser_page_scope_denied');
        return present(request);
      };
      f.requestHook(async (request) => {
        if (request.action !== 'reload') return f.state();
        if (failure === 'request') throw Error('browser_page_scope_denied');
        return {
          ...f.state(),
          loading: true,
          display: 'loading',
          pageToken: 'refresh-intermediate',
        };
      });
      await f.click('刷新网页');
      await f.flush();
      expect(f.requests.filter((request) => request.action === 'reload')).toHaveLength(1);
      expect(document.querySelector('[role="alert"], [data-status="error"]') !== null).toBe(false);
      if (failure === 'layout')
        expect(document.querySelector('[aria-label="网页加载中"]')).not.toBeNull();
      expect(f.address()).toBe(input);
      expect(document.querySelector('form')).toBe(toolbar);
      await f.update({ loading: false, display: 'ready', pageToken: 'refresh-current' });
      expect(f.layouts.at(-1)?.pageToken).toBe('refresh-current');
      expect(document.querySelector('.native-browser-start')).toBeNull();
      expect(f.requests.filter((request) => request.action === 'reload')).toHaveLength(1);
      // Network failures show the browser error page; process failures remain distinct.
      await f.update({ error: 'load_failed', display: 'failed' });
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('无法访问此站点');
      await f.update({ error: 'process_gone' });
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('浏览页面已停止');
    } finally {
      await f.close();
    }
  });

test('failed navigation shows a browser error page, retries once and preserves the toolbar through recovery', async () => {
  const f = await fixture();
  try {
    await f.show();
    const input = f.address(),
      viewport = document.querySelector('.native-browser-viewport');
    const withdrawals = f.withdrawals.length;
    await f.update({ error: 'load_failed', display: 'ready', loading: false });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('无法访问此站点');
    expect(document.querySelector('.native-browser-viewport')).toBe(viewport);
    expect(f.withdrawals).toHaveLength(withdrawals + 1);
    f.requestHook(async (request) =>
      request.action === 'reload'
        ? { ...f.state(), error: undefined, loading: true, display: 'loading', pageToken: 'retry' }
        : f.state(),
    );
    await f.flush(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === '重新加载')!
        .click(),
    );
    expect(f.requests.filter((r) => r.action === 'reload')).toHaveLength(1);
    expect(document.querySelector('[aria-label="网页加载中"]')).not.toBeNull();
    await f.update({ error: undefined, loading: false, display: 'ready', pageToken: 'recovered' });
    expect(f.address()).toBe(input);
    expect(document.querySelector('[role="alert"], .native-browser-start')).toBeNull();
    f.requestHook(async () => {
      throw Error('unsupported_browser_protocol');
    });
    await f.edit('file:///private.txt');
    await f.flush(() =>
      document
        .querySelector('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(document.querySelector('.native-browser-start')).toBeNull();
    expect(document.querySelector('[data-status="error"]')?.getAttribute('title')).toContain(
      'HTTP',
    );
    expect(f.withdrawals).toHaveLength(withdrawals + 1);
  } finally {
    await f.close();
  }
});

test('certificate failure remains readable and cannot retry or bypass Agent control', async () => {
  const control = {
    phase: 'agent' as const,
    incarnation: 'current',
    navigation: 1,
    sessionId: 'session',
    browserId: 'browser',
  };
  const f = await fixture({
    ...loaded(),
    error: 'load_failed',
    display: 'failed',
    failure: { kind: 'certificate', code: 'ERR_CERT_AUTHORITY_INVALID' },
    control,
  });
  try {
    await f.show();
    const error = document.querySelector('.native-browser-error');
    expect(error?.textContent).toContain('安全证书');
    expect(error?.textContent).toContain('日期和时间');
    expect(error?.querySelector('a')).toBeNull();
    const retry = error!.querySelector<HTMLButtonElement>('button')!;
    expect(retry.disabled).toBe(true);
    await f.flush(() => retry.click());
    expect(f.requests.some((r) => r.action === 'reload')).toBe(false);
    await f.update({ control: { ...control, phase: 'human' } });
    expect(document.querySelector('.native-browser-error')).toBe(error);
    expect(retry.disabled).toBe(false);
  } finally {
    await f.close();
  }
});

test('calibration has one positive in flight, remeasures the latest geometry and never hides on resize', async () => {
  const f = await fixture();
  let release!: (value: NativeBrowserState | null) => void;
  try {
    f.hold(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.show();
    const initialWithdrawals = f.withdrawals.length;
    expect(f.syncLayouts).toHaveLength(1);
    await f.resize(550, 450);
    await f.resize(500, 500);
    expect(f.layouts).toHaveLength(2);
    f.hold(undefined);
    await f.flush(() => release(f.state()));
    expect(f.layouts).toHaveLength(3);
    expect(f.layouts[2]?.bounds).toMatchObject({ x: 500, width: 500 });
    expect(f.withdrawals).toHaveLength(initialWithdrawals);
    expect(f.layouts[2]!.presentationRevision).toBeGreaterThan(f.layouts[1]!.presentationRevision!);
    await f.resize(500, 500);
    expect(f.layouts).toHaveLength(3);
    expect(f.syncLayouts).toHaveLength(1);
    expect(f.asyncLayouts).toHaveLength(2);
    await f.resize(500, 500, 850);
    expect(f.layouts.at(-1)?.bounds).toMatchObject({ x: 500, width: 350 });
  } finally {
    release?.(f.state());
    await f.close();
  }
});

test('a truly hidden ancestor retires an in-flight layout immediately, and its late reply cannot restore old display or state', async () => {
  const f = await fixture();
  let release!: (value: NativeBrowserState | null) => void;
  try {
    f.hold(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.show();
    await f.resize(550, 450);
    const old = f.layouts[1]!;
    await f.flush(() => document.getElementById('clip')!.setAttribute('hidden', ''));
    const hidden = f.withdrawals.at(-1)!;
    expect(hidden.bounds).toBeNull();
    expect(hidden.presentationRevision!).toBeGreaterThan(old.presentationRevision!);
    await f.update({
      url: 'https://example.test/current',
      pageToken: 'new-document',
      display: 'ready',
    });
    await f.flush(() => release(loaded()));
    expect(f.address().value).toBe('https://example.test/current');
    expect(f.layouts).toHaveLength(2);
    f.hold(undefined);
    await f.flush(() => document.getElementById('clip')!.removeAttribute('hidden'));
    expect(f.layouts.at(-1)).toMatchObject({ pageToken: 'new-document' });
    expect(f.layouts.at(-1)!.presentationRevision!).toBeGreaterThan(hidden.presentationRevision!);
  } finally {
    release?.(f.state());
    await f.close();
  }
});

for (const selector of [
  'slot=dialog-overlay',
  'slot=alert-dialog-overlay',
  'slot=sheet-overlay',
  'slot=popover-content',
  'role=menu',
  'role=dialog',
  'dialog',
  'data-native-browser-overlay',
]) {
  test(`generic ${selector} never withdraws or replays the real page, even when intersecting`, async () => {
    const f = await fixture();
    try {
      await f.show();
      const count = f.withdrawals.length,
        draws = f.layouts.length;
      await f.overlay(selector, new f.dom.window.DOMRect(0, 0, 100, 50));
      expect(f.withdrawals).toHaveLength(count);
      expect(f.layouts).toHaveLength(draws);
      expect(f.displayed()).toBe('page');
      await f.dismiss();
      expect(f.layouts).toHaveLength(draws);
      await f.overlay(selector);
      expect(f.withdrawals).toHaveLength(count);
      expect(f.layouts).toHaveLength(draws);
      expect(f.displayed()).toBe('page');
      await f.dismiss();
      expect(f.withdrawals).toHaveLength(count);
      expect(f.layouts).toHaveLength(draws);
      expect(f.displayed()).toBe('page');
    } finally {
      await f.close();
    }
  });
}

for (const attribute of ['inert', 'aria-hidden']) {
  test(`ancestor ${attribute} alone does not visually hide or replay the real page`, async () => {
    const f = await fixture();
    try {
      await f.show();
      const count = f.withdrawals.length,
        draws = f.layouts.length;
      await f.flush(() => {
        document
          .getElementById('clip')!
          .setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
      });
      expect(f.withdrawals).toHaveLength(count);
      expect(f.layouts).toHaveLength(draws);
      expect(f.displayed()).toBe('page');
      await f.flush(() => document.getElementById('clip')!.removeAttribute(attribute));
      expect(f.withdrawals).toHaveLength(count);
      expect(f.layouts).toHaveLength(draws);
      expect(f.displayed()).toBe('page');
    } finally {
      await f.close();
    }
  });
}

for (const attribute of ['hidden', 'opacity']) {
  test(`ancestor ${attribute} blocks presentation and restoring it uses a newer exact layout`, async () => {
    const f = await fixture();
    try {
      await f.show();
      const previous = f.layouts.at(-1)!;
      await f.flush(() => {
        const clip = document.getElementById('clip')!;
        if (attribute === 'opacity') clip.style.opacity = '0';
        else clip.setAttribute(attribute, '');
      });
      expect(f.withdrawals.at(-1)!.presentationRevision!).toBeGreaterThan(
        previous.presentationRevision!,
      );
      const count = f.layouts.length;
      await f.flush(() => {
        const clip = document.getElementById('clip')!;
        clip.removeAttribute(attribute);
        clip.style.opacity = '';
      });
      expect(f.layouts).toHaveLength(count + 1);
      expect(f.layouts.at(-1)?.pageToken).toBe(previous.pageToken);
    } finally {
      await f.close();
    }
  });
}

test('hide, Main window remeasure, page-token changes and scope replacement preserve one local toolbar', async () => {
  const f = await fixture();
  try {
    await f.show();
    const input = f.address(),
      bar = document.querySelector('form');
    await f.show({ visible: false });
    const hidden = f.withdrawals.at(-1)!;
    await f.update({ title: 'Background update' });
    expect(f.address()).toBe(input);
    await f.show({ visible: true });
    expect(f.layouts.at(-1)!.presentationRevision!).toBeGreaterThan(hidden.presentationRevision!);
    const count = f.layouts.length;
    await f.remeasure();
    expect(f.layouts).toHaveLength(count + 1);
    await f.update({ pageToken: 'incarnation-successor' });
    expect(f.layouts.at(-1)?.pageToken).toBe('incarnation-successor');
    expect(document.querySelector('form')).toBe(bar);
    await f.edit('unsent address');
    await f.show({ scope: { ...scope, generation: 2 } });
    expect(document.activeElement).not.toBe(input);
    expect(f.address().value).toBe(f.state().url);
    expect(f.layouts.at(-1)?.scope?.generation).toBe(2);
    await f.late(0, { ...loaded(), url: 'https://example.test/retired-owner' });
    expect(f.address().value).toBe(f.state().url);
    expect(f.requests.some((request) => ['reload', 'close'].includes(request.action))).toBe(false);
  } finally {
    await f.close();
  }
});

test('focused address drafts and selection survive unrelated state updates and late old request replies are ignored', async () => {
  const f = await fixture();
  let resolve!: (value: NativeBrowserState) => void;
  try {
    await f.show();
    await f.edit('https://example.test/typed');
    f.address().setSelectionRange(8, 12);
    await f.update({ title: 'Changed title', url: 'https://example.test/redirect' });
    expect(f.address().value).toBe('https://example.test/typed');
    expect([f.address().selectionStart, f.address().selectionEnd]).toEqual([8, 12]);
    f.requestHook((input) =>
      input.action === 'navigate'
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(f.state()),
    );
    await f.flush(() =>
      document
        .querySelector('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    await f.update({ url: 'https://example.test/newest', title: 'Newest' });
    await f.flush(() => resolve(loaded()));
    await f.flush(() => f.address().blur());
    expect(f.address().value).toBe('https://example.test/newest');
  } finally {
    resolve?.(loaded());
    await f.close();
  }
});

test('native options leave page pixels alone; a local failure is readable and does not withdraw the page', async () => {
  const f = await fixture();
  try {
    await f.show();
    const hides = f.withdrawals.length,
      input = f.address();
    await f.click('页面选项');
    expect(f.menus).toHaveLength(1);
    expect(f.withdrawals).toHaveLength(hides);
    await f.rejectMenu();
    expect(f.address()).toBe(input);
    expect(f.withdrawals).toHaveLength(hides);
    expect(document.querySelector('[data-status="error"]')?.getAttribute('title')).toContain(
      '页面选项暂不可用',
    );
    await f.click('页面状态与选项');
    await f.show({ visible: false });
    await f.choose('back');
    expect(f.requests.filter((request) => request.action === 'back')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('retired page menu actions stay quiet without being dispatched or retried', async () => {
  const f = await fixture();
  try {
    await f.show();
    const input = f.address(),
      hides = f.withdrawals.length;
    await f.click('页面选项');
    await f.choose('forward'); // The current page has no forward history.
    expect(f.requests.filter((request) => request.action === 'forward')).toHaveLength(0);
    expect(document.querySelector('[data-status="error"], [role="alert"]') !== null).toBe(false);
    expect(f.menus).toHaveLength(1);
    expect(f.address()).toBe(input);
    expect(f.withdrawals).toHaveLength(hides);
    await f.click('页面选项');
    await f.choose('back');
    expect(f.requests.filter((request) => request.action === 'back')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('annotation UI stays in Root and its toolbar form does not submit navigation', async () => {
  const f = await fixture({
    ...loaded(),
    control: {
      browserId: 'browser',
      sessionId: 'session',
      phase: 'human',
      incarnation: 'original',
      navigation: 1,
    },
  });
  let added = 0;
  try {
    await f.show({
      annotate: (_page, showing, target) => (
        <>
          <p data-note-showing={showing}>Frozen notes</p>
          {target &&
            createPortal(
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  added++;
                }}
              >
                <button type="submit">Add note</button>
              </form>,
              target,
            )}
        </>
      ),
    });
    const input = f.address();
    await f.click('指向注释');
    expect(document.querySelector('[data-note-showing="true"]')).not.toBeNull();
    await f.flush(() =>
      document
        .querySelector('.native-browser-annotation-tools form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(added).toBe(1);
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(0);
    expect(f.address()).toBe(input);
  } finally {
    await f.close();
  }
});

test('explicit annotation mode withdraws the real page and returning restores its current geometry', async () => {
  const f = await fixture({
    ...loaded(),
    control: {
      browserId: 'browser',
      sessionId: 'session',
      phase: 'human',
      incarnation: 'original',
      navigation: 1,
    },
  });
  try {
    await f.show({
      annotate: (_page, showing) => <p data-note-showing={showing}>Frozen notes</p>,
    });
    const input = f.address(),
      previous = f.layouts.at(-1)!;
    await f.click('指向注释');
    const hidden = f.withdrawals.at(-1)!;
    expect(hidden.bounds).toBeNull();
    expect(hidden.presentationRevision!).toBeGreaterThan(previous.presentationRevision!);
    expect(f.displayed()).toBeUndefined();
    expect(document.querySelector('[data-note-showing="true"]')).not.toBeNull();
    const draws = f.layouts.length;
    await f.resize(500, 500);
    expect(f.layouts).toHaveLength(draws);
    expect(f.displayed()).toBeUndefined();
    await f.click('返回网页');
    expect(f.displayed()).toBe('page');
    expect(f.layouts.at(-1)?.bounds).toMatchObject({ x: 500, width: 500 });
    expect(f.layouts.at(-1)!.presentationRevision!).toBeGreaterThan(hidden.presentationRevision!);
    expect(document.querySelector('[data-note-showing="false"]')).not.toBeNull();
    expect(f.address()).toBe(input);
    expect(
      f.requests.some((request) => ['navigate', 'reload', 'close'].includes(request.action)),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('sidebar closing publishes its intermediate measured widths before the zero-width target is reached', async () => {
  const f = await fixture(loaded(), true);
  try {
    await f.show();
    const hides = f.withdrawals.length;
    await f.flush(() => {
      document.getElementById('panel-left')!.dataset.nativeBrowserLayout = JSON.stringify({
        minSize: '0px',
        maxSize: '0px',
        groupResizeBehavior: 'preserve-pixel-size',
        collapsible: false,
      });
    });
    for (const x of [550, 450, 350]) {
      await f.resize(x, 1000 - x);
      expect(f.layouts.at(-1)?.bounds).toMatchObject({ x, width: 1000 - x });
      expect(f.layouts.at(-1)?.layout?.groups[0]?.panels[0]).toMatchObject({ size: x - 1, max: 0 });
    }
    expect(f.withdrawals).toHaveLength(hides);
  } finally {
    await f.close();
  }
});

for (const motion of ['animated', 'dragged'] as const)
  test(`${motion} panels place every measured frame synchronously and retire a late asynchronous calibration`, async () => {
    const f = await fixture(loaded(), true);
    let rejectOld!: (cause: unknown) => void;
    try {
      await f.show();
      f.hold(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      );
      await f.resize(550, 450);
      expect(f.asyncLayouts).toHaveLength(1);
      await f.flush(() => {
        if (motion === 'animated')
          document.querySelector<HTMLElement>('.client-panels')!.dataset.animateWidth = 'true';
        else document.getElementById('panel-handle')!.dataset.separator = 'active';
      });
      for (const x of [500, 450, 400]) {
        const before = f.syncLayouts.length;
        await f.resize(x, 1000 - x);
        expect(f.syncLayouts).toHaveLength(before + 1);
        expect(f.syncLayouts.at(-1)?.bounds).toMatchObject({ x, width: 1000 - x });
        expect(f.asyncLayouts).toHaveLength(1);
      }
      const count = f.layouts.length;
      await f.flush(() => rejectOld(Error('obsolete native failure')));
      expect(f.layouts).toHaveLength(count);
      expect(document.querySelector('[data-status="error"], [role="alert"]')).toBeNull();
      await f.resize(400, 600);
      expect(f.layouts).toHaveLength(count);
      await f.flush(() => {
        delete document.querySelector<HTMLElement>('.client-panels')!.dataset.animateWidth;
        document.getElementById('panel-handle')!.dataset.separator = 'hover';
      });
      f.hold(undefined);
      await f.resize(350, 650);
      expect(f.asyncLayouts).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

test('hovering or focusing a separator and dragging an unrelated group keep stable calibration asynchronous', async () => {
  const f = await fixture(loaded(), true);
  try {
    await f.show();
    const sync = f.syncLayouts.length;
    await f.flush(() => {
      const unrelated = document.createElement('div');
      unrelated.dataset.slot = 'resizable-panel-group';
      unrelated.innerHTML = '<div data-separator="active"></div>';
      document.body.append(unrelated);
    });
    for (const [index, state] of ['hover', 'focus', 'inactive'].entries()) {
      await f.flush(() => {
        document.getElementById('panel-handle')!.dataset.separator = state;
      });
      await f.resize(550 - index * 50, 450 + index * 50);
      expect(f.syncLayouts).toHaveLength(sync);
      expect(f.asyncLayouts).toHaveLength(index + 1);
    }
  } finally {
    await f.close();
  }
});

test('one measured panel layout supplies the native resize projection, and unsupported ancestry withdraws', async () => {
  const f = await fixture(loaded(), true);
  try {
    await f.show();
    expect(f.layouts.at(-1)?.layout).toMatchObject({
      windowWidth: 1000,
      windowHeight: 800,
      insetLeft: 0,
      insetRight: 0,
      groups: [
        {
          gap: 1,
          panels: [
            { size: 599, preserve: 'relative' },
            { size: 400, preserve: 'relative' },
          ],
        },
      ],
    });
    await f.resize(550, 450);
    expect(f.layouts.at(-1)?.layout?.groups[0]?.panels[1]?.size).toBe(450);
    const count = f.withdrawals.length;
    await f.flush(() => {
      document.querySelector<HTMLElement>('.client-panels')!.style.flexDirection = 'column';
    });
    expect(f.withdrawals).toHaveLength(count + 1);
    expect(f.withdrawals.at(-1)?.bounds).toBeNull();
  } finally {
    await f.close();
  }
});

test('Windows titlebar and material frame margins establish a coherent layout while old DOM sizes remain deferred', async () => {
  const f = await fixture(loaded(), 'windows');
  try {
    await f.show();
    expect(f.layouts.at(-1)?.bounds).toMatchObject({ x: 600, width: 394 });
    expect(f.layouts.at(-1)?.layout?.groups).toMatchObject([
      { left: 0, right: 0, panels: [{ size: 200 }, { size: 799 }] },
      { left: 6, right: 6, panels: [{ size: 392 }, { size: 394 }] },
    ]);
    const count = f.layouts.length;
    await f.flush(() => Object.assign(window, { innerWidth: 1100 }));
    await f.remeasure();
    expect(f.layouts).toHaveLength(count);
    await f.flush(() => Object.assign(window, { innerWidth: 1000, innerHeight: 900 }));
    await f.remeasure();
    expect(f.layouts).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test('one outer shell gutter is measured once and inconsistent shell geometry waits for recovery', async () => {
  const f = await fixture(loaded(), 'windows-shell');
  try {
    await f.show();
    expect(f.layouts.at(-1)?.bounds).toMatchObject({ x: 600, width: 394 });
    expect(f.layouts.at(-1)?.layout?.groups).toMatchObject([
      { left: 6, right: 6, panels: [{ size: 200 }, { size: 787 }] },
      { left: 0, right: 0, panels: [{ size: 392 }, { size: 394 }] },
    ]);
    const count = f.layouts.length;
    await f.flush(() => {
      document.querySelector<HTMLElement>('.native-window-content')!.style.padding = '8px';
    });
    await f.remeasure();
    expect(f.layouts).toHaveLength(count);
    await f.flush(() => {
      document.querySelector<HTMLElement>('.native-window-content')!.style.padding = '6px';
    });
    await f.remeasure();
    expect(f.layouts.length).toBeGreaterThan(count);
    expect(f.layouts.at(-1)?.layout?.groups[0]).toMatchObject({ left: 6, right: 6 });
  } finally {
    await f.close();
  }
});

test('a stale initial state read cannot replace a newer state event for the same exact page', async () => {
  const f = await fixture();
  let resolve!: (value: NativeBrowserState) => void;
  try {
    f.requestHook((input) =>
      input.action === 'state'
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(f.state()),
    );
    await f.show();
    await f.update({ url: 'https://example.test/new-state', pageToken: 'document-new-state' });
    await f.flush(() => resolve(loaded()));
    expect(f.address().value).toBe('https://example.test/new-state');
    expect(f.layouts.at(-1)?.pageToken).toBe('document-new-state');
  } finally {
    resolve?.(loaded());
    await f.close();
  }
});

test('scope retirement rejects a blurred IME tail and only a newly focused address may submit navigation', async () => {
  const f = await fixture();
  try {
    await f.show();
    const input = f.address();
    await f.edit('https://example.test/old-draft');
    await f.show({ scope: { ...scope, generation: 2 } });
    await f.flush(() => {
      Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'old IME tail',
      );
      input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
      input
        .closest('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(0);
    await f.edit('https://example.test/new-draft');
    await f.flush(() =>
      input
        .closest('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(f.requests.filter((request) => request.action === 'navigate')).toEqual([
      { action: 'navigate', id: 'page', input: 'https://example.test/new-draft' },
    ]);
  } finally {
    await f.close();
  }
});

test('IME Enter is consumed before native form submission and does not navigate', async () => {
  const f = await fixture();
  try {
    await f.show();
    await f.edit('https://example.test/composition');
    const event = new f.dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await f.flush(() => {
      f.address().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a retired asynchronous resize reports no page or toolbar error and remeasures only the current geometry', async () => {
  const f = await fixture();
  let reject!: (cause: unknown) => void;
  try {
    f.hold(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await f.show();
    const input = f.address(),
      hides = f.withdrawals.length;
    await f.resize(550, 450);
    await f.resize(500, 500);
    f.hold(undefined);
    await f.flush(() => reject(Error('browser_layout_stale')));
    expect(f.layouts).toHaveLength(3);
    expect(f.layouts.at(-1)?.bounds).toMatchObject({ x: 500, width: 500 });
    expect(document.querySelector('[data-status="error"], [role="alert"]')).toBeNull();
    expect(f.address()).toBe(input);
    expect(f.withdrawals).toHaveLength(hides);
    await f.updateAndRemeasure({ pageToken: 'window-shown-new-token' });
    expect(
      f.layouts.slice(3).every((request) => request.pageToken === 'window-shown-new-token'),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

for (const code of ['browser_layout_stale', 'browser_page_scope_denied'])
  test(`retired ${code} layout waits quietly for a real notification instead of retrying itself`, async () => {
    const f = await fixture();
    try {
      f.hold(async () => {
        throw Error(code);
      });
      await f.show();
      await f.resize(550, 450);
      await f.flush();
      expect(f.layouts).toHaveLength(2);
      expect(document.querySelector('[data-status="error"], [role="alert"]') !== null).toBe(false);
      f.hold(undefined);
      await f.resize(500, 500);
      expect(f.layouts).toHaveLength(3);
      expect(f.syncLayouts).toHaveLength(1);
      expect(f.requests.some((request) => request.action === 'reload')).toBe(false);
    } finally {
      await f.close();
    }
  });

test('first display and retained pair switches finish native placement in the same Root layout commit', async () => {
  const f = await fixture();
  try {
    await f.showPair('a');
    expect(f.commits.at(-1)).toBe('a');
    expect(f.syncLayouts.map((request) => request.id)).toEqual(['a']);
    expect(f.asyncLayouts).toHaveLength(0);
    await f.showPair('b');
    expect(f.commits.at(-1)).toBe('b');
    await f.showPair('a');
    expect(f.commits.at(-1)).toBe('a');
    expect(f.syncLayouts.map((request) => request.id)).toEqual(['a', 'b', 'a']);
    expect(f.asyncLayouts).toHaveLength(0);
    expect(
      f.requests.some((request) => ['navigate', 'reload', 'close'].includes(request.action)),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('retained A to B to A replaces the target without a separate withdrawal or a later null', async () => {
  const f = await fixture();
  try {
    await f.showPair('a');
    const start = f.placements.length;
    await f.showPair('b');
    expect(f.commits.at(-1)).toBe('b');
    expect(f.displayed()).toBe('b');
    await f.showPair('a');
    expect(f.commits.at(-1)).toBe('a');
    expect(f.displayed()).toBe('a');
    expect(
      f.placements.slice(start).map(({ mode, request }) => ({
        mode,
        id: request.id,
        bounds: request.bounds === null ? null : 'measured',
      })),
    ).toEqual([
      { mode: 'sync', id: 'b', bounds: 'measured' },
      { mode: 'sync', id: 'a', bounds: 'measured' },
    ]);
  } finally {
    await f.close();
  }
});

test('hiding retained browser tabs without a successor withdraws by the end of the commit', async () => {
  const f = await fixture();
  try {
    await f.showPair('b');
    const start = f.placements.length;
    await f.showPair(undefined);
    expect(f.displayed()).toBeUndefined();
    const next = f.placements.slice(start);
    expect(next.length).toBeGreaterThan(0);
    expect(next.every(({ mode, request }) => mode === 'sync' && request.bounds === null)).toBe(
      true,
    );
    expect(next.some(({ request }) => request.id === 'b')).toBe(true);
  } finally {
    await f.close();
  }
});

test('a new page token for the same owner publishes only the current positive layout', async () => {
  const f = await fixture();
  try {
    await f.show();
    const start = f.placements.length;
    await f.update({ pageToken: 'page-document-2' });
    const next = f.placements.slice(start);
    expect(
      next.map(({ request }) => ({
        id: request.id,
        pageToken: request.pageToken,
        bounds: request.bounds === null ? null : 'measured',
      })),
    ).toEqual([{ id: 'page', pageToken: 'page-document-2', bounds: 'measured' }]);
    expect(f.displayed()).toBe('page');
  } finally {
    await f.close();
  }
});

test('a hidden Root maintains the current page intent while deselection retires it and generic popups do not', async () => {
  const f = await fixture();
  try {
    await f.show();
    const hides = f.withdrawals.length;
    await f.flush(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
    });
    expect(f.withdrawals).toHaveLength(hides);
    await f.update({ pageToken: 'window-hidden-current-token' });
    expect(f.syncLayouts.at(-1)?.pageToken).toBe('window-hidden-current-token');
    expect(f.syncLayouts.at(-1)?.bounds).not.toBeNull();
    await f.show({ visible: false });
    expect(f.withdrawals.at(-1)?.pageToken).toBe('window-hidden-current-token');
    expect(f.withdrawals.at(-1)?.bounds).toBeNull();
    await f.show({ visible: true });
    const restoredHides = f.withdrawals.length,
      draws = f.layouts.length;
    await f.overlay('role=dialog');
    expect(f.withdrawals).toHaveLength(restoredHides);
    expect(f.layouts).toHaveLength(draws);
    expect(f.displayed()).toBe('page');
  } finally {
    await f.close();
  }
});

test('a true owner replacement withdraws the original binding before presenting the new owner', async () => {
  const f = await fixture();
  try {
    await f.show();
    const start = f.placements.length;
    await f.show({ scope: { ...scope, generation: 2 } });
    const next = f.placements.slice(start);
    expect(next[0]).toMatchObject({
      mode: 'sync',
      request: { scope: { generation: 1 }, bounds: null },
    });
    const positive = next.findIndex(({ request }) => request.bounds !== null);
    expect(positive).toBeGreaterThan(0);
    expect(next[positive]).toMatchObject({
      mode: 'sync',
      request: { scope: { generation: 2 } },
    });
    expect(next.slice(positive).every(({ request }) => request.scope?.generation === 2)).toBe(true);
  } finally {
    await f.close();
  }
});

test('true unmount withdraws before the replacement Root commit can paint', async () => {
  const f = await fixture();
  try {
    await f.show();
    const start = f.placements.length;
    await f.unmountPane();
    expect(f.commits.at(-1)).toBeUndefined();
    expect(f.displayed()).toBeUndefined();
    expect(f.placements.slice(start)).toEqual([
      { mode: 'sync', request: expect.objectContaining({ id: 'page', bounds: null }) },
    ]);
  } finally {
    await f.close();
  }
});

test('a preload without a synchronous placement port retains bounded asynchronous initial and animated compatibility', async () => {
  const f = await fixture(loaded(), true);
  try {
    f.withoutSync();
    await f.show({ initialHint: loaded() });
    expect(f.syncLayouts).toHaveLength(0);
    expect(f.asyncLayouts).toHaveLength(1);
    await f.flush(() => {
      document.querySelector<HTMLElement>('.client-panels')!.dataset.animateWidth = 'true';
    });
    await f.resize(500, 500);
    expect(f.asyncLayouts).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('restoring after a truly hidden ancestor synchronously overtakes an old positive and its late rejection cannot retire successor calibration', async () => {
  const f = await fixture();
  let rejectOld!: (cause: unknown) => void;
  let resolveCurrent!: (value: NativeBrowserState | null) => void;
  try {
    await f.show({ initialHint: loaded() });
    f.hold(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    await f.resize(550, 450);
    const old = f.asyncLayouts[0]!;
    await f.flush(() => document.getElementById('clip')!.setAttribute('hidden', ''));
    const hidden = f.withdrawals.at(-1)!;
    expect(hidden.presentationRevision!).toBeGreaterThan(old.presentationRevision!);
    expect(f.displayed()).toBeUndefined();
    await f.flush(() => document.getElementById('clip')!.removeAttribute('hidden'));
    expect(f.displayed()).toBe('page');
    expect(f.syncLayouts).toHaveLength(2);
    expect(f.syncLayouts.at(-1)?.bounds).toMatchObject({ x: 550, width: 450 });
    expect(f.syncLayouts.at(-1)!.presentationRevision!).toBeGreaterThan(
      hidden.presentationRevision!,
    );
    f.hold(
      () =>
        new Promise((resolve) => {
          resolveCurrent = resolve;
        }),
    );
    await f.resize(500, 500);
    expect(f.asyncLayouts).toHaveLength(2);
    await f.flush(() => rejectOld(Error('obsolete native failure')));
    expect(document.querySelector('[data-status="error"], [role="alert"]')).toBeNull();
    await f.resize(450, 550);
    expect(f.asyncLayouts).toHaveLength(2);
    f.hold(undefined);
    await f.flush(() => resolveCurrent(f.state()));
    expect(f.asyncLayouts).toHaveLength(3);
    expect(f.asyncLayouts.at(-1)?.bounds).toMatchObject({ x: 450, width: 550 });
    expect(f.syncLayouts).toHaveLength(2);
    expect(f.displayed()).toBe('page');
  } finally {
    resolveCurrent?.(f.state());
    await f.close();
  }
});

test('a genuine synchronous first-placement failure stays readable without retrying its own error render', async () => {
  const f = await fixture();
  let attempts = 0;
  try {
    f.host.presentBrowserLayout = (request: Placement) => {
      if (request.bounds) {
        attempts++;
        throw Error('native layout failure');
      }
      return f.state();
    };
    await f.show({ initialHint: loaded() });
    await f.flush();
    expect(attempts).toBe(1);
    expect(document.querySelector('[data-status="error"]')).not.toBeNull();
    expect(f.asyncLayouts).toHaveLength(0);
    await f.resize(500, 500);
    expect(attempts).toBe(2);
  } finally {
    await f.close();
  }
});
