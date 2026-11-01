import { afterAll, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps } from 'react';
import type { SessionPageProps } from '../../src/desktop/SessionPage';
import type { SessionTabsChromePresentation } from '../../src/desktop/types';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const matchMedia = (query: string) =>
  Object.assign(new dom.window.EventTarget(), { matches: false, media: query });
Object.assign(dom.window, { ResizeObserver: ResizeObserverStub, matchMedia });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  HTMLIFrameElement: dom.window.HTMLIFrameElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  DOMRect: dom.window.DOMRect,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: ResizeObserverStub,
  matchMedia,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const actualResizable = await import('../../src/desktop/components/ui/resizable');
const OriginalPanelGroup = actualResizable.ResizablePanelGroup;
const resizableExports = { ...actualResizable };
let captureContentLayout = false;
let contentLayoutProps: ComponentProps<typeof OriginalPanelGroup> | undefined;
mock.module('../../src/desktop/components/ui/resizable', () => ({
  ...resizableExports,
  ResizablePanelGroup(props: ComponentProps<typeof OriginalPanelGroup>) {
    if (captureContentLayout && props.id === 'content-layout') contentLayoutProps = props;
    return <OriginalPanelGroup {...props} />;
  },
}));
const { SessionPage } = await import('../../src/desktop/SessionPage');
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('tab scope reconciliation preserves the page shell without closing native browser pages', async () => {
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  let directoryEvaluations = 0;
  const workspaces: SessionPageProps['workspaces'] = [
    { id: 'w', label: 'Workspace', state: 'loaded', sessionCount: 0, sessions: [] },
  ];
  const find = workspaces.find.bind(workspaces);
  // The retained page resolves the selected Workspace once per render. Sidebar
  // has no selected Session here, so its independent memo does not call find.
  Object.defineProperty(workspaces, 'find', {
    value: (...args: Parameters<typeof workspaces.find>) => {
      directoryEvaluations++;
      return find(...args);
    },
  });
  const browsers = new Set<string>();
  const closed: string[] = [];
  const renderBrowser: SessionPageProps['renderBrowser'] = ({ id }) => {
    browsers.add(id);
    return <div data-browser={id}>Browser</div>;
  };
  const closeBrowser = (id: string) => closed.push(id);
  const show = (readingKey: string) =>
    act(async () =>
      root.render(
        <SessionPage
          workspaces={workspaces}
          sessionLabel="Session"
          readingKey={readingKey}
          messages={[]}
          connected
          connectionLabel=""
          loading={false}
          actions={{}}
          renderBrowser={renderBrowser}
          closeBrowser={closeBrowser}
        />,
      ),
    );
  let unmounted = false;
  const openBrowser = () =>
    act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click();
    });
  try {
    await show('a');
    expect(browsers.size).toBe(0);
    await openBrowser();
    await act(async () => {
      const escapeKey = new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      escapeKey.preventDefault();
      dom.window.dispatchEvent(escapeKey);
    });
    expect(host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded')).toBe('true');
    const header = host.querySelector('.session-header');
    const sidebar = host.querySelector('.sidebar');
    directoryEvaluations = 0;
    await show('b');
    expect(directoryEvaluations).toBe(1);
    expect(host.querySelector('.session-header')).toBe(header);
    expect(host.querySelector('.sidebar')).toBe(sidebar);
    expect(closed).toEqual([]);
    await openBrowser();
    expect(browsers.size).toBe(2);
    directoryEvaluations = 0;
    await show('c');
    expect(directoryEvaluations).toBe(1);
    expect(host.querySelector('.session-header')).toBe(header);
    expect(host.querySelector('.sidebar')).toBe(sidebar);
    expect(closed).toEqual([]);
    await openBrowser();
    expect(browsers.size).toBe(3);
    await act(async () => root.unmount());
    unmounted = true;
    expect(closed).toEqual([]);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
  }
});

test('a consumed child navigation never reopens on selection handoff, while a fresh request waits for the actual scope', async () => {
  const root = createRoot(document.getElementById('root')!);
  let closes = 0;
  const show = (readingKey: string, requestId?: number, loading = false, details = false) =>
    act(async () =>
      root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="Session"
          readingKey={readingKey}
          messages={[]}
          connected
          connectionLabel=""
          loading={loading}
          actions={{}}
          renderBrowser={() => <div>Browser</div>}
          renderChildSession={() => <div>Original child</div>}
          childTabRequest={
            requestId === undefined ? undefined : { requestId, sessionId: 'child', title: 'Child' }
          }
          detailPanel={
            details
              ? {
                  label: 'Tasks',
                  content: <div>Original task reader</div>,
                  onClose: () => {
                    closes++;
                  },
                }
              : undefined
          }
        />,
      ),
    );
  try {
    await show('a', 1, false, true);
    expect(closes).toBe(1);
    await show('pending', undefined, true, true);
    await show('b', undefined, false, true);
    await show('a', 1, false, true);
    expect(closes).toBe(1);
    expect(document.querySelector('[aria-label="Tasks"]')).not.toBeNull();
    await show('a', 2, true, true);
    expect(closes).toBe(1);
    await show('a', 2, false, true);
    expect(closes).toBe(2);
    await show('b', 1, false, true);
    expect(closes).toBe(2);
  } finally {
    await act(async () => root.unmount());
  }
});

test('tab presentation survives fresh reading identities while actual conversation scope changes retire it', async () => {
  const host = document.getElementById('root')!,
    root = createRoot(host);
  const closed: string[] = [],
    restored: string[] = [];
  const show = (
    readingKey: string,
    tabsScopeKey: string,
    generation: number,
    loading = false,
    requestId?: number,
  ) =>
    act(async () =>
      root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="Session"
          readingKey={readingKey}
          tabsScopeKey={tabsScopeKey}
          messages={[]}
          connected
          connectionLabel=""
          loading={loading}
          actions={{}}
          renderBrowser={({ id, visible }) => <div data-browser={id} data-visible={visible} />}
          closeBrowser={(id) => closed.push(id)}
          restoreBrowser={async () => {
            restored.push(`${tabsScopeKey}/${generation}`);
            return { id: `page-${tabsScopeKey}`, title: `Page ${tabsScopeKey}` };
          }}
          browserRestoreKey={`${tabsScopeKey}/${generation}`}
          browserPending={loading}
          browserTabRequest={
            requestId === undefined ? undefined : { requestId, createIfMissing: false }
          }
        />,
      ),
    );
  const expanded = () => host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded');
  try {
    await show('reading-a/1', 'store/a', 1, false, 1);
    expect(expanded()).toBe('true');
    const page = host.querySelector('[data-browser="page-store/a"]'),
      tabs = host.querySelector('.session-tabs');
    expect(page).not.toBeNull();
    await show('reading-unavailable', 'store/a', 2, true, 1);
    expect(expanded()).toBe('true');
    expect(host.querySelector('[data-browser="page-store/a"]')).toBe(page);
    expect(host.querySelector('.session-tabs')).toBe(tabs);
    await show('reading-a/2', 'store/a', 2, false, 1);
    expect(expanded()).toBe('true');
    expect(host.querySelector('[data-browser="page-store/a"]')).toBe(page);
    expect(host.querySelector('.session-tabs')).toBe(tabs);
    expect(restored).toEqual(['store/a/1', 'store/a/2']);
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    expect(expanded()).toBe('false');
    await show('reading-a/3', 'store/a', 3, false, 1);
    expect(expanded()).toBe('false');
    await show('reading-b/3', 'store/b', 3);
    expect(expanded()).toBe('false');
    expect(host.querySelector('[data-browser="page-store/a"]')).toBeNull();
    await show('reading-other-store/3', 'other-store/b', 3);
    expect(host.querySelector('[data-browser="page-store/b"]')).toBeNull();
    expect(closed).toEqual([]);
  } finally {
    await act(() => root.unmount());
  }
});

test('only a fresh host reveal restores the exact visible page once, without overriding later user closure or another panel', async () => {
  const host = document.getElementById('root')!,
    root = createRoot(host);
  let release!: () => void,
    detailCloses = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const show = (key: string, reveal: boolean, wait = false, details = false, scope = 'store/a') =>
    act(async () =>
      root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="Session"
          readingKey={scope}
          messages={[]}
          connected
          connectionLabel=""
          loading={false}
          actions={{}}
          renderBrowser={({ id, visible }) => <div data-browser={id} data-visible={visible} />}
          restoreBrowser={async () => {
            if (wait) await pending;
            return {
              id: 'page-one',
              title: 'Page one',
              pages: [
                { id: 'page-one', title: 'Page one' },
                { id: 'page-two', title: 'Page two' },
              ],
              activeId: 'page-two',
              ...(reveal ? { reveal: true as const } : {}),
            };
          }}
          browserRestoreKey={key}
          detailPanel={
            details
              ? {
                  label: 'Current task',
                  content: <div>Current task details</div>,
                  onClose: () => {
                    detailCloses++;
                  },
                }
              : undefined
          }
        />,
      ),
    );
  const expanded = () => host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded');
  try {
    await show('initial', false);
    expect(expanded()).toBe('false');
    await show('fresh-replacement', true, true, true);
    expect(expanded()).toBe('false');
    await act(async () => {
      release();
      await Bun.sleep(0);
    });
    expect(expanded()).toBe('false');
    expect(detailCloses).toBe(0);
    await show('fresh-replacement', true);
    expect(expanded()).toBe('true');
    expect(host.querySelector('[data-browser="page-two"]')?.getAttribute('data-visible')).toBe(
      'true',
    );
    expect(host.querySelector('[data-browser="page-one"]')?.getAttribute('data-visible')).toBe(
      'false',
    );
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    expect(expanded()).toBe('false');
    await show('same-pending-reveal-again', true);
    expect(expanded()).toBe('false');
    await show('other-conversation', false, false, false, 'store/b');
    expect(expanded()).toBe('false');
    await show('original-conversation-again', true);
    expect(expanded()).toBe('false');
    expect(detailCloses).toBe(0);
  } finally {
    release();
    await act(() => root.unmount());
  }
});

test('scope retirement settles before a frame, cancels old panel work and preserves pending original-page reveal', async () => {
  const host = document.getElementById('root')!,
    root = createRoot(host);
  const raf = globalThis.requestAnimationFrame,
    cancel = globalThis.cancelAnimationFrame,
    rect = dom.window.HTMLElement.prototype.getBoundingClientRect,
    offset = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetWidth')!;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.id === 'client-layout' || this.id === 'content-layout'
      ? new dom.window.DOMRect(0, 0, 1200, 600)
      : rect.call(this);
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.id === 'client-layout' || this.id === 'content-layout'
        ? 1200
        : offset.get!.call(this);
    },
  });
  const closed: string[] = [];
  let release!: (value: { id: string; title: string; reveal: true } | null) => void;
  const pending = new Promise<{ id: string; title: string; reveal: true } | null>((resolve) => {
    release = resolve;
  });
  const show = (scope: string, wait = false, details = false, empty = false) =>
    act(() =>
      root.render(
        <SessionPage
          workspaces={[]}
          readingKey={scope}
          sessionLabel="Session"
          messages={[]}
          connected
          connectionLabel=""
          loading={false}
          actions={{}}
          renderBrowser={({ id, visible }) => <div data-original={id} data-visible={visible} />}
          closeBrowser={(id) => closed.push(id)}
          restoreBrowser={() =>
            wait
              ? pending
              : Promise.resolve(empty ? null : { id: `page-${scope}`, title: scope, reveal: true })
          }
          browserRestoreKey={scope}
          detailPanel={
            details
              ? { label: 'Target details', content: 'Target details', onClose() {} }
              : undefined
          }
        />,
      ),
    );
  const flushFrame = () =>
    act(() => {
      const batch = [...frames];
      frames.clear();
      for (const [, callback] of batch) callback(0);
    });
  const expanded = () => host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded');
  const animating = () => host.querySelector('#content-layout')?.getAttribute('data-animate-width');
  try {
    await show('a');
    expect(expanded()).toBe('true');
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    // Leave while the previous owner's manual close is still queued.
    expect(frames.size).toBeGreaterThan(0);
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!.click());
    await show('b', true);
    expect(animating()).toBeNull();
    expect(host.querySelector('[data-original="page-a"]')).toBeNull();
    await flushFrame();
    expect(animating()).toBeNull();
    expect(host.querySelector('#client-layout')?.getAttribute('data-animate-width')).toBe('true');
    await act(() => release({ id: 'page-b', title: 'Original B', reveal: true }));
    expect(expanded()).toBe('true');
    expect(animating()).toBeNull();
    expect(host.querySelector('[data-original="page-b"]')?.getAttribute('data-visible')).toBe(
      'true',
    );
    await flushFrame();
    expect(expanded()).toBe('true');
    expect(animating()).toBeNull();
    await show('c', false, true);
    expect(Number(host.querySelector<HTMLElement>('#details')!.style.flexGrow)).toBeGreaterThan(0);
    await flushFrame();
    expect(host.textContent).toContain('Target details');
    expect(animating()).toBeNull();
    // B was not recorded as user-dismissed by the scope retirement.
    await show('b');
    expect(expanded()).toBe('true');
    expect(host.querySelector('[data-original="page-b"]')?.getAttribute('data-visible')).toBe(
      'true',
    );
    await show('empty', false, false, true);
    expect(expanded()).toBe('false');
    expect(Number(host.querySelector<HTMLElement>('#details')!.style.flexGrow)).toBe(0);
    expect(animating()).toBeNull();
    await flushFrame();
    expect(animating()).toBeNull();
    await show('b');
    expect(expanded()).toBe('true');
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    await flushFrame();
    expect(animating()).toBe('true');
    await show('c', false, true);
    expect(animating()).toBeNull();
    await show('b');
    expect(expanded()).toBe('false');
    expect(closed).toEqual([]);
  } finally {
    release(null);
    await act(() => root.unmount());
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = cancel;
    dom.window.HTMLElement.prototype.getBoundingClientRect = rect;
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', offset);
  }
});

function retainedSidebarFixture(restored = true) {
  const host = document.getElementById('root')!,
    root = createRoot(host),
    frames = new Map<number, FrameRequestCallback>(),
    raf = globalThis.requestAnimationFrame,
    cancel = globalThis.cancelAnimationFrame,
    rect = dom.window.HTMLElement.prototype.getBoundingClientRect,
    offset = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetWidth')!;
  let serial = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++serial, callback);
    return serial;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return ['client-layout', 'content-layout'].includes(this.id)
      ? new dom.window.DOMRect(0, 0, 1200, 600)
      : rect.call(this);
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return ['client-layout', 'content-layout'].includes(this.id) ? 1200 : offset.get!.call(this);
    },
  });
  const closed: string[] = [];
  const restoreBrowser: SessionPageProps['restoreBrowser'] = async () =>
    restored ? { id: 'retained-page', title: 'Original browser', reveal: true } : null;
  const renderBrowser: SessionPageProps['renderBrowser'] = ({ id, visible, tools }) => (
    <div data-retained-page={id} data-visible={visible}>
      <input aria-label="Original field" defaultValue="Original form" />
      {tools}
    </div>
  );
  const show = (options: { request?: number; child?: number; details?: boolean } = {}) =>
    act(async () =>
      root.render(
        <SessionPage
          workspaces={[]}
          readingKey="retained-animation"
          sessionLabel="Original session"
          messages={[]}
          connected
          connectionLabel=""
          loading={false}
          actions={{}}
          renderBrowser={renderBrowser}
          closeBrowser={(id) => closed.push(id)}
          restoreBrowser={restoreBrowser}
          browserRestoreKey="original"
          browserTabRequest={
            options.request === undefined
              ? undefined
              : { requestId: options.request, createIfMissing: true }
          }
          childTabRequest={
            options.child === undefined
              ? undefined
              : { requestId: options.child, sessionId: 'child', title: 'Child details' }
          }
          renderChildSession={() => <div>Child reader</div>}
          detailPanel={
            options.details
              ? { label: 'Ordinary details', content: 'Original details reader', onClose() {} }
              : undefined
          }
        />,
      ),
    );
  return {
    host,
    closed,
    show,
    click: (label: string) =>
      act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()),
    frame: () =>
      act(() => {
        const batch = [...frames.values()];
        frames.clear();
        for (const callback of batch) callback(0);
      }),
    width: () => Number(host.querySelector<HTMLElement>('#details')!.style.flexGrow),
    animating: () => host.querySelector('#content-layout')!.getAttribute('data-animate-width'),
    async close() {
      await act(() => root.unmount());
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = cancel;
      dom.window.HTMLElement.prototype.getBoundingClientRect = rect;
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', offset);
    },
  };
}

for (const closing of ['pending', 'completed'] as const)
  test(`retained browser header reopen settles final width without animation after ${closing} collapse`, async () => {
    const f = retainedSidebarFixture();
    try {
      await f.show();
      await f.frame();
      const page = f.host.querySelector('[data-retained-page="retained-page"]')!,
        field = page.querySelector<HTMLInputElement>('input')!,
        width = f.width();
      field.value = 'User original form';
      expect(width).toBeGreaterThan(0);
      expect(f.animating()).toBeNull();
      await f.click('标签页');
      if (closing === 'completed') {
        await f.frame();
        expect(f.width()).toBe(0);
        expect(f.animating()).toBe('true');
      }
      await f.click('标签页');
      expect(f.width()).toBe(width); // before any queued animation frame
      expect(f.animating()).toBeNull();
      expect(f.host.querySelector('[data-retained-page="retained-page"]')).toBe(page);
      expect(page.getAttribute('data-visible')).toBe('true');
      expect(field.value).toBe('User original form');
      await f.frame();
      expect(f.width()).toBe(width);
      expect(f.animating()).toBeNull();
      expect(f.closed).toEqual([]);
      await f.click('收起侧栏');
      await f.frame();
      expect(f.host.querySelector('#client-layout')!.getAttribute('data-animate-width')).toBe(
        'true',
      );
    } finally {
      await f.close();
    }
  });

test('retained browser requests settle directly while new browser and ordinary detail opens keep their animation', async () => {
  const f = retainedSidebarFixture();
  try {
    await f.show();
    await f.frame();
    const original = f.host.querySelector('[data-retained-page="retained-page"]'),
      width = f.width();
    await f.click('标签页');
    await f.frame();
    await f.show({ request: 1 });
    expect(f.width()).toBe(width);
    expect(f.animating()).toBeNull();
    expect(f.host.querySelector('[data-retained-page="retained-page"]')).toBe(original);
    await f.click('标签页');
    await f.frame();
    await f.show({ child: 1 }); // background browser must not bypass child-reader animation
    await f.frame();
    expect(f.animating()).toBe('true');
    expect(f.host.textContent).toContain('Child reader');
    await f.click('标签页');
    await f.frame();
    await f.click('标签页'); // selected child remains an ordinary animated open
    await f.frame();
    expect(f.animating()).toBe('true');
    await f.click('标签页');
    await f.frame();
    await f.show({ details: true });
    await f.frame();
    expect(f.animating()).toBe('true');
    expect(f.host.textContent).toContain('Original details reader');
    expect(f.closed).toEqual([]);
  } finally {
    await f.close();
  }
  const fresh = retainedSidebarFixture(false);
  try {
    await fresh.show();
    await fresh.frame();
    await fresh.click('标签页');
    await fresh.frame();
    expect(fresh.animating()).toBe('true');
    expect(fresh.host.querySelectorAll('[data-retained-page]')).toHaveLength(1);
  } finally {
    await fresh.close();
  }
});

/** Real Group/Panel rendering with controlled notifications, not a pointer-drag simulation. */
function collapseNotificationFixture() {
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  let groupWidth = 0;
  let groupReads = 0;
  let chrome: SessionTabsChromePresentation | null = null;
  const closed: string[] = [];
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  const originalOffset = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    'offsetWidth',
  )!;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'content-layout') {
      groupReads++;
      return new dom.window.DOMRect(0, 0, groupWidth, 600);
    }
    return originalRect.call(this);
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.id === 'content-layout' ? groupWidth : originalOffset.get!.call(this);
    },
  });
  captureContentLayout = true;
  contentLayoutProps = undefined;
  const flush = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(30);
    });
  const layout = (collapsed: boolean) => ({
    content: collapsed ? 100 : 50,
    details: collapsed ? 0 : 50,
  });
  return {
    host,
    closed,
    async open() {
      await flush(() =>
        root.render(
          <SessionPage
            workspaces={[]}
            readingKey="controlled-collapse"
            sessionLabel="Controlled collapse"
            messages={[]}
            connected
            connectionLabel=""
            loading={false}
            actions={{}}
            tabsChromeHosted
            onTabsChromePresentation={(value) => {
              chrome = value;
            }}
            renderBrowser={({ id, visible }) => (
              <div data-collapse-browser={id} data-visible={visible} />
            )}
            closeBrowser={(id) => closed.push(id)}
          />,
        ),
      );
      await flush(() => host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    },
    setWidth(width: number) {
      groupWidth = width;
    },
    reads() {
      return groupReads;
    },
    resetReads() {
      groupReads = 0;
    },
    notify(collapsed: boolean, count = 1) {
      return flush(() => {
        const callback = contentLayoutProps?.onLayoutChange;
        expect(typeof callback).toBe('function');
        for (let index = 0; index < count; index++) callback!(layout(collapsed));
      });
    },
    complete(collapsed: boolean, isUserInteraction: boolean) {
      return flush(() =>
        contentLayoutProps?.onLayoutChanged?.(layout(collapsed), { isUserInteraction }),
      );
    },
    browser() {
      return host.querySelector<HTMLElement>('[data-collapse-browser]')!;
    },
    expanded() {
      return host.querySelector('[aria-label="标签页"]')!.getAttribute('aria-expanded');
    },
    presentation() {
      return chrome?.data;
    },
    flush,
    async close() {
      await flush(() => root.unmount());
      captureContentLayout = false;
      contentLayoutProps = undefined;
      dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', originalOffset);
    },
  };
}

test('live collapsed Group notification withdraws hosted browser presentation before a user resize completes', async () => {
  const f = collapseNotificationFixture();
  try {
    await f.open();
    f.setWidth(1000);
    await f.notify(false);
    const browser = f.browser();
    const id = browser.dataset.collapseBrowser;
    expect(browser.dataset.visible).toBe('true');
    expect(f.presentation()).toMatchObject({ visible: true, present: true });
    await f.notify(true); // no final pointer-release/onLayoutChanged notification yet
    expect(f.expanded()).toBe('true'); // visibility and user intent are separate
    expect(f.browser()).toBe(browser);
    expect(browser.dataset.visible).toBe('false');
    expect(f.presentation()).toMatchObject({ visible: false, present: false });
    expect(f.closed).toEqual([]);
    await f.complete(true, true);
    expect(f.expanded()).toBe('false');
    f.setWidth(1400);
    await f.notify(false);
    expect(f.expanded()).toBe('false');
    expect(browser.dataset.visible).toBe('false');
    await f.flush(() => f.host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    await f.notify(false);
    expect(f.browser()).toBe(browser);
    expect(f.browser().dataset.collapseBrowser).toBe(id);
    expect(f.browser().dataset.visible).toBe('true');
    expect(f.closed).toEqual([]);
  } finally {
    await f.close();
  }
});

test('automatic collapse preserves open intent and repeated positive Group notices do not reread geometry', async () => {
  const f = collapseNotificationFixture();
  try {
    await f.open();
    const browser = f.browser();
    expect(browser.dataset.visible).toBe('true');
    await f.notify(true); // zero-width hidden Group cannot replace the initial unknown state
    expect(browser.dataset.visible).toBe('true');
    f.setWidth(1000);
    await f.notify(false);
    expect(browser.dataset.visible).toBe('true');
    f.resetReads();
    await f.notify(false, 25);
    expect(f.reads()).toBe(0);
    await f.notify(true);
    await f.complete(true, false); // window constraints, not an explicit user dismissal
    expect(f.expanded()).toBe('true');
    expect(browser.dataset.visible).toBe('false');
    expect(f.presentation()).toMatchObject({ visible: false, present: false });
    await f.notify(false);
    expect(f.expanded()).toBe('true');
    expect(f.browser()).toBe(browser);
    expect(browser.dataset.visible).toBe('true');
    expect(f.presentation()).toMatchObject({ visible: true, present: true });
    f.setWidth(0);
    await f.notify(true);
    expect(browser.dataset.visible).toBe('true'); // invalid hidden Group retains last valid result
    expect(f.closed).toEqual([]);
  } finally {
    await f.close();
  }
});
