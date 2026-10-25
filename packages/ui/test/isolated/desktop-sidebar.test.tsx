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
  HTMLIFrameElement: dom.window.HTMLIFrameElement,
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

test('empty Native notice fragments preserve the full-height surface and visible notices precede it', async () => {
  const overlaySelector =
    '.client-main-panel[data-header-overlay]:has(> main > .session-body:first-child)';
  await render({ notices: <>{false && <p>hidden</p>}</> });
  expect(document.querySelector(overlaySelector)).not.toBeNull();
  const header = document.querySelector('.session-header')!;
  const footer = document.querySelector('.conversation-footer')!;
  expect(TestResizeObserver.observed.has(header)).toBe(true);
  expect(TestResizeObserver.observed.has(footer)).toBe(true);

  await render({
    notices: (
      <>
        <p role="alert">可见提示</p>
      </>
    ),
  });
  expect(document.querySelector(overlaySelector)).toBeNull();
  await render({ notices: <>{null}</>, workbench: true });
  expect(document.querySelector(overlaySelector)).toBeNull();
  expect(TestResizeObserver.observed.has(footer)).toBe(false);
  await render({ notices: <>{null}</> });
  expect(document.querySelector(overlaySelector)).not.toBeNull();
  const returnedFooter = document.querySelector('.conversation-footer')!;
  expect(TestResizeObserver.observed.has(returnedFooter)).toBe(true);
  await act(() => root!.unmount());
  root = undefined;
  expect(TestResizeObserver.observed.has(header)).toBe(false);
  expect(TestResizeObserver.observed.has(returnedFooter)).toBe(false);
});

test('sidebar selection follows the visible page without highlighting a retained conversation', async () => {
  const shared: Partial<SessionPageProps> = {
    workspaces: [
      {
        id: 'w',
        label: '工作区',
        state: 'loaded',
        sessionCount: 1,
        sessions: [{ sessionId: 's', displayName: '已有会话', status: 'idle' }],
      },
      { id: 'other', label: '另一空间', state: 'loaded', sessionCount: 0, sessions: [] },
    ],
    selected: 's',
    onOpen: () => {},
    actions: { newSession: () => {}, scheduledTasks: () => {}, workbench: () => {} },
  };
  const newConversation = {
    projects: [
      { path: 'w', label: '工作区' },
      { path: 'other', label: '另一空间' },
    ],
    workspace: '',
    busy: false,
    onProject: () => {},
    onAddProject: () => {},
    onBranch: () => {},
    onRefreshBranch: () => {},
  };
  const pages: { label: string; props: Partial<SessionPageProps> }[] = [
    { label: '已有会话', props: {} },
    {
      label: '新对话',
      props: {
        newConversation,
      },
    },
    { label: '工作区', props: { newConversation: { ...newConversation, workspace: 'w' } } },
    { label: '另一空间', props: { newConversation: { ...newConversation, workspace: 'other' } } },
    {
      label: '工作区',
      props: { newConversation: { ...newConversation, workspace: 'w', busy: true } },
    },
    { label: '新对话', props: { newConversation: { ...newConversation, workspace: 'removed' } } },
    { label: '新对话', props: { newConversation } },
    {
      label: '安排任务',
      props: {
        newConversation: { ...newConversation, workspace: 'w' },
        scheduledTasks: { tasks: [], workspaces: shared.workspaces! },
      },
    },
    { label: '工作台', props: { workbench: true } },
    { label: '已有会话', props: {} },
  ];
  for (const page of pages) {
    await render({ ...shared, ...page.props });
    const current = document.querySelectorAll('.sidebar [aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toBe(page.label);
    expect(current[0]!.closest('.selected')).not.toBeNull();
    expect(document.querySelectorAll('.sidebar .selected')).toHaveLength(1);
  }
});

test('workspace removal is only selected through More, respects busy state and keeps its workspace identity', async () => {
  const removed: string[] = [];
  const props: Partial<SessionPageProps> = {
    workspaces: [
      { id: 'w', label: '工作区', state: 'loaded', sessionCount: 0, sessions: [] },
      { id: 'other', label: '另一空间', state: 'loaded', sessionCount: 0, sessions: [] },
    ],
    actions: { newWorkspaceSession: () => {}, removeWorkspace: (id) => removed.push(id) },
  };
  const openMenu = async (label: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label} 更多操作"]`)!;
    await act(() => {
      trigger.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return trigger;
  };
  const dismissMenu = async () => {
    const trigger = document.querySelector<HTMLButtonElement>('.space-more[data-state="open"]')!;
    const heading = trigger.closest('.space-heading')!;
    let restoredFocus = 0;
    const observeFocus = () => restoredFocus++;
    trigger.addEventListener('focus', observeFocus);
    await act(async () => {
      document.querySelector('[role="menu"]')!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    trigger.removeEventListener('focus', observeFocus);
    expect(trigger.getAttribute('data-state')).toBe('closed');
    expect(restoredFocus).toBe(0);
    expect(heading.contains(document.activeElement)).toBe(false);
    expect(heading.hasAttribute('data-menu-active')).toBe(false);
  };
  await render(props);
  expect(document.querySelector('.space-heading .space-remove')).toBeNull();
  await act(() => {
    document.querySelector<HTMLButtonElement>('[aria-label="工作区 更多操作"]')!.focus();
  });
  expect(document.querySelector('[data-slot="tooltip-content"]') !== null).toBe(true);
  const trigger = await openMenu('工作区');
  expect(trigger.getAttribute('data-state')).toBe('open');
  expect(document.querySelector('[data-slot="tooltip-content"]') === null).toBe(true);
  expect(document.querySelector('[role="menuitem"][aria-label="移除 工作区"]')).not.toBeNull();
  expect(removed).toEqual([]);
  await render({ ...props, mutationBusy: true });
  const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="移除 工作区"]')!;
  expect(trigger.disabled).toBe(true);
  expect(item.getAttribute('aria-disabled')).toBe('true');
  await act(() => item.click());
  expect(removed).toEqual([]);
  await dismissMenu();
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
  await render(props);
  await act(() => trigger.focus());
  await openMenu('工作区');
  await dismissMenu();
  expect(document.activeElement === trigger).toBe(false);
  expect(document.querySelector('[data-slot="tooltip-content"]') === null).toBe(true);
  const heading = trigger.closest('.space-heading')!;
  const edit = heading.querySelector('.space-new-session');
  await openMenu('工作区');
  await act(async () => {
    document.body.dispatchEvent(
      new dom.window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        button: 0,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
  expect(heading.hasAttribute('data-menu-active')).toBe(false);
  expect(heading.contains(document.activeElement)).toBe(false);
  expect(heading.querySelector('.space-new-session') === edit).toBe(true);
  expect(heading.querySelector('.space-more') === trigger).toBe(true);
  expect(document.querySelector('[data-slot="tooltip-content"]') === null).toBe(true);
  expect(removed).toEqual([]);
  const movePointer = () =>
    act(async () => {
      trigger.dispatchEvent(
        new dom.window.PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
  await movePointer();
  expect(document.querySelector('[data-slot="tooltip-content"]') === null).toBe(true);
  await act(() => {
    heading.dispatchEvent(
      new dom.window.PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
    );
    document.body.dispatchEvent(
      new dom.window.PointerEvent('pointerout', { bubbles: true, relatedTarget: heading }),
    );
  });
  await movePointer();
  expect(document.querySelector('[data-slot="tooltip-content"]') !== null).toBe(true);
  await openMenu('另一空间');
  await act(async () => {
    const item = document.querySelector<HTMLElement>(
      '[role="menuitem"][aria-label="移除 另一空间"]',
    )!;
    item.dispatchEvent(
      new dom.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
    );
    item.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(removed).toEqual(['other']);
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
});

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

test('environment only auto-opens with enough right gutter, keeps late content stable and respects manual toggles', async () => {
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  let width = 1560;
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

    await resizeView(1559);
    expect(sessionView().classList.contains('environment-information-closed')).toBe(true);
    expect(sessionView().classList.contains('environment-information-animated')).toBe(true);
    await resizeView(1560);
    expect(sessionView().classList.contains('environment-information-docked')).toBe(true);
    await resizeView(1200);
    expect(sessionView().classList.contains('environment-information-closed')).toBe(true);
    await click('显示环境信息');
    expect(sessionView().classList.contains('environment-information-overlay')).toBe(true);
    await click('隐藏环境信息');
    expect(sessionView().classList.contains('environment-information-closed')).toBe(true);
    await resizeView(1560);
    expect(sessionView().classList.contains('environment-information-closed')).toBe(true);
    await click('显示环境信息');
    expect(sessionView().classList.contains('environment-information-docked')).toBe(true);
    expect(sessionView().classList.contains('environment-information-animated')).toBe(true);
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test('new conversations start with environment closed unless the full right gutter fits', async () => {
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  let width = 1200;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('session-view')
      ? new dom.window.DOMRect(0, 0, width, 800)
      : originalRect.call(this);
  };
  try {
    for (width of [390, 1092, 1200, 1559, 1560, 1800]) {
      await render({
        readingKey: 'new-conversation',
        selected: undefined,
        newConversation: {
          projects: [],
          workspace: '',
          busy: false,
          onProject: () => {},
          onAddProject: () => {},
          onBranch: () => {},
          onRefreshBranch: () => {},
        },
        environmentInformation: <aside className="environment-information">环境信息</aside>,
      });
      const view = document.querySelector('.session-view')!;
      expect(view.classList.contains('environment-information-docked')).toBe(width >= 1560);
      expect(view.classList.contains('environment-information-closed')).toBe(width < 1560);
      expect(view.classList.contains('environment-information-animated')).toBe(false);
      await act(() => root!.unmount());
      root = undefined;
    }
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});
