import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { SessionPageProps } from '../../src/desktop/SessionPage';

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
  static observed = new Map<Element, ResizeObserverCallback>();
  private targets = new Set<Element>();
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.targets.add(target);
    TestResizeObserver.observed.set(target, this.callback);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
    TestResizeObserver.observed.delete(target);
  }
  disconnect() {
    for (const target of this.targets) TestResizeObserver.observed.delete(target);
    this.targets.clear();
  }
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
// The panel library sorts registrations by layout position. JSDOM has no layout;
// preserve sibling order when navigation size constraints are re-registered.
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', {
  configurable: true,
  get() {
    return this.parentElement?.hasAttribute('data-group')
      ? Array.from(this.parentElement.children).indexOf(this) * 200
      : 0;
  },
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

async function render(overrides: Partial<SessionPageProps> = {}) {
  root ??= createRoot(document.body);
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
        {...overrides}
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

test('resizing across the old narrow breakpoint keeps the open sidebar and content mounted', async () => {
  await render();
  const navigation = document.querySelector('#navigation');
  const conversation = document.querySelector('.conversation-container');
  expectDesktopSidebar(true);
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const narrow of [true, false]) {
      await resize(narrow);
      expectDesktopSidebar(true);
      expect(document.querySelector('#navigation')).toBe(navigation);
      expect(document.querySelector('.conversation-container')).toBe(conversation);
    }
  }
});

test('only the toggle changes sidebar visibility across window widths', async () => {
  await render();
  await click('收起侧栏');
  expectDesktopSidebar(false);
  await resize(true);
  expectDesktopSidebar(false);
  await click('展开侧栏');
  expectDesktopSidebar(true);
  await resize(false);
  expectDesktopSidebar(true);
  await resize(true);
  await click('收起侧栏');
  expectDesktopSidebar(false);
  await resize(false);
  expectDesktopSidebar(false);
});

test('a narrow startup keeps navigation open; selection, new chat and Escape do not close it', async () => {
  viewport.matches = true;
  let selected: string | undefined;
  let created = 0;
  await render({
    workspaces: [
      {
        id: 'w',
        label: '工作区',
        state: 'loaded',
        sessionCount: 1,
        sessions: [{ sessionId: 'other', displayName: '已有会话', status: 'idle' }],
      },
    ],
    onOpen: (id) => {
      selected = id;
    },
    actions: {
      newSession: () => {
        created++;
      },
    },
  });
  expectDesktopSidebar(true);
  await click('已有会话');
  expect(selected).toBe('other');
  expectDesktopSidebar(true);
  const newSession = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '新对话',
  )!;
  await act(() => newSession.click());
  expect(created).toBe(1);
  await act(() => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
  expectDesktopSidebar(true);
  await resize(false);
  expectDesktopSidebar(true);
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

test('environment docking starts at its measured layout, keeps late content stable and animates later width changes', async () => {
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  let width = 1200;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('session-view')
      ? new dom.window.DOMRect(0, 0, width, 800)
      : originalRect.call(this);
  };
  const card = (text: string) => <aside className="environment-information">{text}</aside>;
  const sessionView = () => document.querySelector<HTMLElement>('.session-view')!;
  const resizeView = async (nextWidth: number) => {
    width = nextWidth;
    await act(() => {
      const element = sessionView();
      TestResizeObserver.observed.get(element)?.(
        [
          { target: element, contentRect: new dom.window.DOMRect(0, 0, width, 800) },
        ] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
    });
  };
  try {
    await render({ environmentInformation: card('') });
    expect(sessionView().classList.contains('environment-information-docked')).toBe(true);
    expect(sessionView().classList.contains('environment-information-animated')).toBe(false);
    const originalCard = document.querySelector('.environment-information');
    await render({ environmentInformation: card('已读取环境信息') });
    expect(document.querySelector('.environment-information')).toBe(originalCard);
    expect(sessionView().classList.contains('environment-information-docked')).toBe(true);
    expect(sessionView().classList.contains('environment-information-animated')).toBe(false);

    await resizeView(1000);
    expect(sessionView().classList.contains('environment-information-closed')).toBe(true);
    expect(sessionView().classList.contains('environment-information-animated')).toBe(true);
    await click('显示环境信息');
    expect(sessionView().classList.contains('environment-information-overlay')).toBe(true);
    await click('隐藏环境信息');
    expect(sessionView().classList.contains('environment-information-closed')).toBe(true);
    await resizeView(1200);
    expect(sessionView().classList.contains('environment-information-closed')).toBe(true);
    await click('显示环境信息');
    expect(sessionView().classList.contains('environment-information-docked')).toBe(true);
    expect(sessionView().classList.contains('environment-information-animated')).toBe(true);
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});
