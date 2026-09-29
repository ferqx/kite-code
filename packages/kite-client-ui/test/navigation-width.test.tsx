import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { SessionPage } from '../src/SessionPage';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  dom.window.HTMLElement.prototype,
  'offsetWidth',
);
const originalOffsetLeft = Object.getOwnPropertyDescriptor(
  dom.window.HTMLElement.prototype,
  'offsetLeft',
);
let groupWidth = 1000;
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', {
  configurable: true,
  get() {
    if (this.id === 'navigation-resize') return 200;
    if (this.id === 'content') return 201;
    if (this.id === 'details-resize') return 1001;
    if (this.id === 'details') return 1002;
    return 0;
  },
});
const originalAriaDisabled = Object.getOwnPropertyDescriptor(
  dom.window.HTMLElement.prototype,
  'ariaDisabled',
);
Object.defineProperty(dom.window.HTMLElement.prototype, 'ariaDisabled', {
  configurable: true,
  get() {
    return this.getAttribute('aria-disabled');
  },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    if (this.id === 'navigation')
      return Math.round((groupWidth * Number(this.style.flexGrow || 20)) / 100);
    if (this.id === 'content')
      return Math.round((groupWidth * Number(this.style.flexGrow || 80)) / 100);
    if (this.id === 'details') return 0;
    return 0;
  },
});
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.matches('[data-slot="resizable-panel-group"]'))
    return new DOMRect(0, 0, groupWidth, 800);
  return originalBounds.call(this);
};

class TestResizeObserver {
  static readonly observers = new Set<TestResizeObserver>();
  private readonly targets = new Set<Element>();
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    TestResizeObserver.observers.add(this);
    this.targets.add(target);
  }
  static resizeAll(width = groupWidth) {
    for (const observer of TestResizeObserver.observers)
      for (const target of observer.targets)
        observer.callback(
          [
            {
              target,
              contentRect: { width, height: 800 },
              borderBoxSize: [{ inlineSize: width, blockSize: 800 }],
            } as unknown as ResizeObserverEntry,
          ],
          observer as unknown as ResizeObserver,
        );
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    TestResizeObserver.observers.delete(this);
  }
}
const narrowMediaListeners = new Set<() => void>();
const narrowMedia = {
  matches: false,
  addEventListener: (_type: string, listener: () => void) => narrowMediaListeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) =>
    narrowMediaListeners.delete(listener),
};
Object.defineProperty(dom.window, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});

const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  Node: dom.window.Node,
  Element: dom.window.Element,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: TestResizeObserver,
  matchMedia: () => narrowMedia as unknown as MediaQueryList,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
}
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;

async function renderPage() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root!.render(
      <SessionPage
        workspaces={[]}
        sessionLabel="Session"
        readingKey="workspace/session"
        messages={[]}
        loading={false}
        connected
        connectionLabel=""
        actions={{}}
      />,
    ),
  );
  await act(() => TestResizeObserver.resizeAll());
}

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  window.localStorage.clear();
  groupWidth = 1000;
  narrowMedia.matches = false;
  narrowMediaListeners.clear();
});
afterAll(() => {
  if (originalOffsetLeft)
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', originalOffsetLeft);
  if (originalAriaDisabled)
    Object.defineProperty(dom.window.HTMLElement.prototype, 'ariaDisabled', originalAriaDisabled);
  else Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'ariaDisabled');
  if (originalOffsetWidth)
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  dom.window.HTMLElement.prototype.getBoundingClientRect = originalBounds;
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('navigation starts at 200px and restores a user-adjusted width after remount', async () => {
  await renderPage();
  const navigation = document.querySelector<HTMLElement>('#navigation')!;
  expect(navigation.style.flexGrow).toBe('20');
  expect(window.localStorage.getItem('kite.client.navigationWidth')).toBeNull();

  const separator = document.querySelector<HTMLElement>('#navigation-resize')!;
  await act(() =>
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(window.localStorage.getItem('kite.client.navigationWidth')).toBe('250');

  await act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  await renderPage();
  expect(document.querySelector<HTMLElement>('#navigation')!.style.flexGrow).toBe('25');
  const collapse = document.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!;
  await act(() => collapse.click());
  expect(window.localStorage.getItem('kite.client.navigationWidth')).toBe('250');
});

test('window resizing preserves the navigation pixel width before and after user resizing', async () => {
  await renderPage();
  const navigation = document.querySelector<HTMLElement>('#navigation')!;
  const navigationPixels = () => (groupWidth * Number(navigation.style.flexGrow)) / 100;
  expect(navigationPixels()).toBeCloseTo(200, 0);
  expect(navigation.hasAttribute('data-animate-width')).toBe(false);

  groupWidth = 1200;
  await act(() => TestResizeObserver.resizeAll());
  expect(navigationPixels()).toBeCloseTo(200, 0);
  expect(navigation.hasAttribute('data-animate-width')).toBe(false);

  groupWidth = 1000;
  await act(() => TestResizeObserver.resizeAll());
  const separator = document.querySelector<HTMLElement>('#navigation-resize')!;
  await act(() =>
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(navigationPixels()).toBeCloseTo(250, 0);
  expect(window.localStorage.getItem('kite.client.navigationWidth')).toBe('250');

  groupWidth = 900;
  await act(() => TestResizeObserver.resizeAll());
  expect(navigationPixels()).toBeCloseTo(250, 0);
  expect(window.localStorage.getItem('kite.client.navigationWidth')).toBe('250');
  expect(navigation.hasAttribute('data-animate-width')).toBe(false);

  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!.click());
  expect(navigation.getAttribute('data-animate-width')).toBe('true');
  await act(() =>
    document.querySelector<HTMLButtonElement>('.session-header [aria-label="展开侧栏"]')!.click(),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(navigationPixels()).toBeCloseTo(250, 0);
  await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
  expect(navigation.hasAttribute('data-animate-width')).toBe(false);
});

test('navigation restores the latest drag width after a narrow-screen round trip', async () => {
  await renderPage();
  const separator = document.querySelector<HTMLElement>('#navigation-resize')!;
  await act(() =>
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(window.localStorage.getItem('kite.client.navigationWidth')).toBe('250');

  await act(() => {
    groupWidth = 600;
    narrowMedia.matches = true;
    for (const listener of [...narrowMediaListeners]) listener();
  });
  expect(document.querySelector('#navigation')).toBeNull();

  await act(() => {
    groupWidth = 900;
    narrowMedia.matches = false;
    for (const listener of [...narrowMediaListeners]) listener();
  });
  const open = document.querySelector<HTMLButtonElement>('.session-header [aria-label="展开侧栏"]');
  if (open) await act(() => open.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const navigation = document.querySelector<HTMLElement>('#navigation')!;
  expect((groupWidth * Number(navigation.style.flexGrow)) / 100).toBeCloseTo(250, 0);
});

test('resizing navigation to collapsed shows the header control to reopen it', async () => {
  await renderPage();
  Object.defineProperty(document.querySelector('#client-layout')!, 'offsetWidth', {
    configurable: true,
    value: 1000,
  });
  const separator = document.querySelector<HTMLElement>('#navigation-resize')!;
  await act(() =>
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
  );

  expect(document.querySelector<HTMLElement>('#navigation')?.style.flexGrow).toBe('0');
  expect(document.querySelector('.collapsible-sidebar-content')?.getAttribute('aria-hidden')).toBe(
    'true',
  );
  expect(separator.getAttribute('data-open')).toBe('false');
  expect(
    document.querySelector<HTMLButtonElement>('.session-header [aria-label="展开侧栏"]'),
  ).not.toBeNull();
  expect(window.localStorage.getItem('kite.client.navigationWidth')).toBeNull();

  await act(() =>
    document.querySelector<HTMLButtonElement>('.session-header [aria-label="展开侧栏"]')!.click(),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.querySelector<HTMLElement>('#navigation')?.style.flexGrow).toBe('20');
  expect(document.querySelector('.collapsible-sidebar-content')?.getAttribute('aria-hidden')).toBe(
    'false',
  );
  expect(separator.getAttribute('data-open')).toBe('true');
});
