import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
});
const viewport = Object.assign(new dom.window.EventTarget(), {
  matches: false,
  media: '(max-width: 600px)',
});
const matchMedia = (query: string) =>
  (query === viewport.media
    ? viewport
    : Object.assign(new dom.window.EventTarget(), {
        matches: false,
        media: query,
      })) as MediaQueryList;
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(dom.window, {
  matchMedia,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    dom.window.setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Element: dom.window.Element,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle,
  matchMedia,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { SessionPage } = await import('../../src/desktop/SessionPage');
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  viewport.matches = false;
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render() {
  root = createRoot(document.body);
  await act(() =>
    root!.render(
      <SessionPage
        workspaces={[]}
        sessionLabel="Conversation"
        readingKey="s"
        selected="s"
        messages={[]}
        connected
        connectionLabel=""
        loading={false}
        actions={{}}
      />,
    ),
  );
}
async function resize(narrow: boolean) {
  await act(() => {
    viewport.matches = narrow;
    viewport.dispatchEvent(new dom.window.Event('change'));
  });
}
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}
function expectDesktopSidebar(open: boolean) {
  const navigation = document.querySelector('#navigation .collapsible-sidebar-content');
  expect(navigation).not.toBeNull();
  expect(navigation!.getAttribute('aria-hidden')).toBe(String(!open));
  expect(navigation!.hasAttribute('inert')).toBe(!open);
  expect(document.querySelector('.kite-client')!.classList.contains('sidebar-visible')).toBe(open);
  const toggles = document.querySelectorAll<HTMLButtonElement>('.sidebar-toggle');
  expect(toggles).toHaveLength(1);
  expect(toggles[0]!.getAttribute('aria-label')).toBe(open ? '收起侧栏' : '展开侧栏');
  expect(toggles[0]!.getAttribute('aria-expanded')).toBe(String(open));
  expect(toggles[0]!.closest('[inert]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}

test('wide sidebar and its toggle remain consistent after repeated narrow window transitions', async () => {
  await render();
  expectDesktopSidebar(true);
  for (let cycle = 0; cycle < 3; cycle++) {
    await resize(true);
    expect(document.querySelector('#navigation')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await resize(false);
    expectDesktopSidebar(true);
  }
});

test('narrow sheet open and close do not replace the last desktop sidebar choice', async () => {
  await render();
  await click('收起侧栏');
  expectDesktopSidebar(false);
  await resize(true);
  await click('展开侧栏');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await resize(false);
  expectDesktopSidebar(false);

  await click('展开侧栏');
  expectDesktopSidebar(true);
  await resize(true);
  await click('展开侧栏');
  await click('收起侧栏');
  await resize(false);
  expectDesktopSidebar(true);
});

test('starting in a narrow window keeps its sheet closed and initializes one wide sidebar', async () => {
  viewport.matches = true;
  await render();
  expect(document.querySelector('#navigation')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelectorAll('.sidebar-toggle')).toHaveLength(1);
  await resize(false);
  expectDesktopSidebar(true);
  expect(document.querySelectorAll('.sidebar-toggle')).toHaveLength(1);
});

test('the title toggle and sidebar state change in the panel animation frame without replacing the title', async () => {
  await render();
  const group = document.querySelector<HTMLElement>('.client-panels')!;
  Object.defineProperty(group, 'offsetWidth', { configurable: true, value: 1000 });
  group.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 1000, 800);
  const title = document.querySelector('.session-header .breadcrumb strong');
  const frames = new Map<number, FrameRequestCallback>();
  let id = 10000;
  const queue = (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  };
  const cancel = (frame: number) => {
    frames.delete(frame);
  };
  const original = [
    globalThis.requestAnimationFrame,
    globalThis.cancelAnimationFrame,
    dom.window.requestAnimationFrame,
    dom.window.cancelAnimationFrame,
  ] as const;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame = queue;
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame = cancel;
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  try {
    const control = document.querySelector<HTMLButtonElement>('.sidebar-toggle')!;
    control.focus();
    await click('收起侧栏');
    expectDesktopSidebar(true);
    await flush();
    expectDesktopSidebar(false);
    expect(document.querySelector('.session-header .breadcrumb strong')).toBe(title);
    expect(group.dataset.animateWidth).toBe('true');
    expect(document.querySelector('.sidebar-toggle')).toBe(control);
    expect(document.activeElement).toBe(control);
    await click('展开侧栏');
    expectDesktopSidebar(false);
    await flush();
    expectDesktopSidebar(true);
    expect(document.querySelector('.session-header .breadcrumb strong')).toBe(title);
    expect(document.querySelector('.sidebar-toggle')).toBe(control);
    expect(document.activeElement).toBe(control);
  } finally {
    await act(() => root?.unmount());
    root = undefined;
    [
      globalThis.requestAnimationFrame,
      globalThis.cancelAnimationFrame,
      dom.window.requestAnimationFrame,
      dom.window.cancelAnimationFrame,
    ] = original;
  }
});
