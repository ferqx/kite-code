import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect, useState } from 'react';
import { childAgentAppearance } from '../../src/desktop/ApprovalHeader';
import type {
  SessionChildTabRequest,
  SessionChildTarget,
  SessionTabsModel,
} from '../../src/desktop/SessionTabs';

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
const { createPortal } = await import('react-dom');
const { SessionBrowserToolbar, SessionTabs, useSessionTabs } = await import(
  '../../src/desktop/SessionTabs'
);
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

let mounted = 0,
  closed = 0;
const released: string[] = [];
const childChanges: (SessionChildTarget | undefined)[] = [];
let childMounted = 0,
  childClosed = 0;
function Child({ sessionId, executionId }: SessionChildTarget) {
  useEffect(() => {
    childMounted++;
    return () => {
      childClosed++;
    };
  }, []);
  return <p>{`Child ${sessionId} / ${executionId}`}</p>;
}
function Changes() {
  useEffect(() => {
    mounted++;
    return () => {
      closed++;
    };
  }, []);
  return <section aria-label="变更内容">Saved changes</section>;
}
let workspaceMounts = 0,
  workspaceUnmounts = 0;
function Workspace({ visible }: { visible: boolean }) {
  useEffect(() => {
    workspaceMounts++;
    return () => {
      workspaceUnmounts++;
    };
  }, []);
  return <section data-workspace-visible={visible}>Managed browser snapshot</section>;
}
async function render(
  scope = 's',
  hostDetails = false,
  covered = false,
  childTabRequest?: SessionChildTabRequest,
  workspaceTab?: { requestId: number; onClose: () => void },
) {
  root ??= createRoot(document.body);
  await act(() =>
    root!.render(
      <SessionPage
        workspaces={[]}
        selected={scope}
        readingKey={scope}
        sessionLabel="Conversation"
        messages={[]}
        connected
        connectionLabel=""
        loading={false}
        actions={{}}
        covered={covered}
        workspaceTab={
          workspaceTab
            ? {
                ...workspaceTab,
                label: 'Agent 浏览器',
                render: (visible) => <Workspace visible={visible} />,
              }
            : undefined
        }
        detailPanel={
          hostDetails
            ? { label: 'Host details', content: <p>Host details body</p>, onClose() {} }
            : undefined
        }
        closeBrowser={(id) => released.push(id)}
        childTabRequest={childTabRequest}
        renderChildSession={(target) => <Child {...target} />}
        onChildSessionChange={(target) => childChanges.push(target)}
        fileChangesContent={<Changes />}
        renderBrowser={({ id, visible, tools }) => (
          <section data-browser-id={id} data-visible={visible}>
            {tools}
          </section>
        )}
      />,
    ),
  );
}
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}
async function changes() {
  const button = document.querySelector<HTMLButtonElement>('.session-browser-tool');
  expect(button).not.toBeNull();
  await act(() => button!.click());
}
function browserIds() {
  return [...document.querySelectorAll<HTMLElement>('[data-browser-id]')].map(
    (node) => node.dataset.browserId!,
  );
}

async function selectTab(title: string) {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (tab) => tab.title === title,
  );
  expect(tab).toBeDefined();
  await act(() => {
    tab!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    tab!.click();
  });
}

function closeFixture() {
  let model!: SessionTabsModel;
  const closed: {
    id: string;
    originalPresent: boolean;
    resolve(): void;
    reject(cause: unknown): void;
  }[] = [];
  function Harness({ scope = 'original' }: { scope?: string }) {
    model = useSessionTabs(scope, (id) => {
      const originalPresent = !!document.querySelector(`[data-retained-id="${id}"]`);
      return new Promise<void>((resolve, reject) =>
        closed.push({ id, originalPresent, resolve, reject }),
      );
    });
    return (
      <SessionTabs
        model={model}
        visible
        changes={null}
        onClose={() => {}}
        renderBrowser={({ id }) => <p data-retained-id={id}>Page {id}</p>}
      />
    );
  }
  root = createRoot(document.body);
  return {
    closed,
    model: () => model,
    render: (scope = 'original') => act(() => root!.render(<Harness scope={scope} />)),
    mutate: (action: (value: SessionTabsModel) => void) => act(() => action(model)),
  };
}

test('a close captures its target in the click stack and immediately selects the array neighbor', async () => {
  const f = closeFixture();
  await f.render();
  await f.mutate((model) => model.addBrowser());
  await f.mutate((model) => model.addBrowser());
  const [a, b] = f.model().tabs;
  await f.mutate((model) => model.closeTab(b!.id));
  expect(f.closed.map(({ id, originalPresent }) => ({ id, originalPresent }))).toEqual([
    { id: b!.id, originalPresent: true },
  ]);
  expect(f.model().active).toBe(a!.id);
  expect(f.model().tabs.map((tab) => tab.id)).toEqual([a!.id]);
  await act(async () => {
    f.closed[0]!.reject(Error('unknown close'));
    await Promise.resolve();
  });
  expect(f.model().tabs.map((tab) => tab.id)).toEqual([a!.id, b!.id]);
  expect(f.model().active).toBe(b!.id);
  expect(f.model().closeIssue).toContain('未能确认网页已关闭');
  expect(f.closed).toHaveLength(1);
});

for (const boundary of ['intent', 'scope', 'scope-return'] as const) {
  test(`a failed close preserves newer selection and only restores its current owner: ${boundary}`, async () => {
    const f = closeFixture();
    await f.render();
    await f.mutate((model) => model.addBrowser());
    const a = f.model().active;
    await f.mutate((model) => model.closeTab(a));
    if (boundary !== 'intent') await f.render('successor');
    if (boundary === 'scope-return') await f.render('original');
    await f.mutate((model) => model.addBrowser());
    const successor = f.model().active;
    await act(async () => {
      f.closed[0]!.reject(Error('late close result'));
      await Promise.resolve();
    });
    expect(f.model().active).toBe(successor);
    expect(f.model().tabs.some((tab) => tab.id === a)).toBe(boundary === 'intent');
    expect(!!f.model().closeIssue).toBe(boundary === 'intent');
    expect(f.model().closeReveal).toBe(0);
    expect(f.closed).toHaveLength(1);
  });
}

test('a failed close after selecting another existing tab restores only its page without stealing focus', async () => {
  const f = closeFixture();
  await f.render();
  await f.mutate((model) => model.addBrowser());
  await f.mutate((model) => model.addBrowser());
  const [a, b] = f.model().tabs;
  await f.mutate((model) => model.closeTab(b!.id));
  await f.mutate((model) => model.select(a!.id));
  await f.mutate((model) => model.title(a!.id, 'Updated page'));
  await act(async () => {
    f.closed[0]!.reject(Error('close failed'));
    await Promise.resolve();
  });
  expect(f.model().tabs.map((tab) => tab.id)).toEqual([a!.id, b!.id]);
  expect(f.model().tabs[0]!.title).toBe('Updated page');
  expect(f.model().active).toBe(a!.id);
  expect(f.model().closeIssue).toContain('未能确认网页已关闭');
  expect(f.model().closeReveal).toBe(0);
});

test('concurrent close failures merge exact pages without resurrecting a successful close', async () => {
  const f = closeFixture();
  await f.render();
  for (let index = 0; index < 3; index++) await f.mutate((model) => model.addBrowser());
  const [a, b, c] = f.model().tabs;
  await f.mutate((model) => model.closeTab(a!.id));
  await f.mutate((model) => model.closeTab(b!.id));
  await f.mutate((model) => model.addBrowser());
  const latest = f.model().active;
  await act(async () => {
    f.closed[1]!.resolve();
    f.closed[0]!.reject(Error('original close failed'));
    await Promise.resolve();
  });
  expect(f.model().tabs.map((tab) => tab.id)).toEqual([a!.id, c!.id, latest]);
  expect(f.model().active).toBe(latest);
  expect(f.model().closeReveal).toBe(0);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`pending close reserves its eighth slot until ${outcome}`, async () => {
    const f = closeFixture();
    await f.render();
    for (let index = 0; index < 8; index++) await f.mutate((model) => model.addBrowser());
    const original = f.model().active;
    await f.mutate((model) => model.closeTab(original));
    await f.mutate((model) => model.addBrowser());
    expect(f.model().tabs).toHaveLength(7);
    await f.mutate((model) => {
      expect(model.openChild({ sessionId: 'child' }, 'Child')).toBe(false);
      expect(model.openWorkspace('Workspace')).toBe(false);
      model.openChanges();
    });
    expect(f.model().tabs).toHaveLength(7);
    await act(async () => {
      if (outcome === 'success') f.closed[0]!.resolve();
      else f.closed[0]!.reject(Error('close failed'));
      await Promise.resolve();
    });
    await f.mutate((model) => model.addBrowser());
    expect(f.model().tabs).toHaveLength(8);
    expect(f.model().tabs.some((tab) => tab.id === original)).toBe(outcome === 'failure');
  });
}

test('tabs replace the direct file changes action; only the visible selected tool owns a reader', async () => {
  mounted = closed = 0;
  released.length = 0;
  await render();
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === '文件变更')).toBe(
    false,
  );
  expect(mounted).toBe(0);
  await click('标签页');
  expect(document.querySelector('#session-tabs')!.hasAttribute('hidden')).toBe(false);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  const customBrowser = document.querySelector('[data-browser-id]')!;
  const customTools = customBrowser.querySelector(
    'section.session-browser-tools[aria-label="工具"]',
  )!;
  expect(customTools).not.toBeNull();
  expect(customTools.querySelector('h2')?.textContent).toBe('工具');
  expect(customBrowser.querySelectorAll('button')).toHaveLength(1);
  expect(customTools.querySelector('button')?.textContent).toBe('变更');
  expect(customTools.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  expect(document.querySelector('.session-tabs-heading .session-browser-tool')).toBeNull();
  await changes();
  expect(mounted - closed).toBe(1);
  await click('新建标签页');
  expect(mounted - closed).toBe(0);
  expect(browserIds()).toHaveLength(2);
  await changes();
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(3);
  expect(mounted - closed).toBe(1);
  await click('收起标签栏');
  const shell = document.querySelector<HTMLElement>('#session-tabs')!;
  expect(shell.hidden).toBe(true);
  expect(shell.classList.contains('right-sidebar')).toBe(false);
  expect(shell.getAttribute('aria-hidden')).toBe('true');
  expect(shell.hasAttribute('inert')).toBe(true);
  expect(mounted - closed).toBe(0);
  expect(document.querySelector('.session-tab-changes')).toBeNull();
  expect(document.querySelectorAll('[data-browser-id][data-visible="true"]')).toHaveLength(0);
  await click('标签页');
  expect(mounted - closed).toBe(1);
  expect(document.querySelector('button button')).toBeNull();
  expect(released).toHaveLength(0);
});

test('default Web blank page retains its tools heading and a working changes action', async () => {
  mounted = closed = 0;
  root = createRoot(document.body);
  await act(() =>
    root!.render(
      <SessionPage
        workspaces={[]}
        selected="web-default"
        readingKey="web-default"
        sessionLabel="Conversation"
        messages={[]}
        connected
        connectionLabel=""
        loading={false}
        actions={{}}
        fileChangesContent={<Changes />}
      />,
    ),
  );
  await click('标签页');
  const start = document.querySelector('.session-browser-start')!;
  expect(start).not.toBeNull();
  expect(start.querySelectorAll('h2')).toHaveLength(1);
  expect(start.querySelector('section[aria-label="工具"] > h2')?.textContent).toBe('工具');
  expect(start.querySelector<HTMLButtonElement>('.session-browser-tool')?.disabled).toBe(false);
  await changes();
  expect(document.querySelector('[role="tab"][title="变更"]')?.getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(document.querySelector('.session-tab-changes')?.textContent).toBe('Saved changes');
  expect(mounted - closed).toBe(1);
});
test('responsive resize retains tabs; switching session releases readers without closing browser pages', async () => {
  mounted = closed = 0;
  released.length = 0;
  await render();
  await click('标签页');
  await click('新建标签页');
  const ids = browserIds();
  for (const narrow of [true, false])
    await act(() => {
      viewport.matches = narrow;
      viewport.dispatchEvent(new dom.window.Event('change'));
    });
  expect(browserIds()).toEqual(ids);
  expect(released).toHaveLength(0);
  await changes();
  expect(mounted - closed).toBe(1);
  await render('other');
  expect(released).toEqual([]);
  expect(mounted - closed).toBe(0);
  expect(browserIds()).toHaveLength(0);
  await click('标签页');
  expect(browserIds()).toHaveLength(1);
  expect(ids).not.toContain(browserIds()[0]);
  await act(() => root!.unmount());
  root = undefined;
  expect(released).toEqual([]);
});
test('closing the final browser tab collapses the sidebar and reopening leaves a usable new page', async () => {
  released.length = 0;
  await render();
  await click('标签页');
  const first = browserIds()[0]!;
  await click('关闭标签页：新标签页');
  expect(released).toContain(first);
  expect(document.querySelector('#session-tabs')!.getAttribute('aria-hidden')).toBe('true');
  expect(
    document.querySelector('[aria-controls="session-tabs"]')!.getAttribute('aria-expanded'),
  ).toBe('false');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('标签页');
  expect(document.querySelectorAll('[data-browser-id][data-visible="true"]')).toHaveLength(0);
  await click('标签页');
  expect(document.querySelector('#session-tabs')!.getAttribute('aria-hidden')).toBe('false');
  expect(browserIds()).toHaveLength(1);
  expect(browserIds()[0]).not.toBe(first);
  for (let i = 0; i < 7; i++) await click('新建标签页');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  expect(
    document.querySelector<HTMLButtonElement>('button[aria-label="新建标签页"]')!.disabled,
  ).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('.session-browser-tool')!.disabled).toBe(true);
});

test.each([
  'changes',
  'child',
] as const)('closing the final %s tab collapses the sidebar and releases its reader', async (kind) => {
  mounted = closed = childMounted = childClosed = 0;
  childChanges.length = 0;
  await render();
  await click('标签页');
  if (kind === 'changes') await changes();
  else
    await render('s', false, false, {
      requestId: 1,
      sessionId: 'child',
      executionId: 'task',
      title: 'Child task',
    });
  await click('关闭标签页：新标签页');
  expect(document.querySelector('#session-tabs')!.getAttribute('aria-hidden')).toBe('false');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(mounted - closed + childMounted - childClosed).toBe(1);
  await click(`关闭标签页：${kind === 'changes' ? '变更' : 'Child task'}`);
  expect(document.querySelector('#session-tabs')!.getAttribute('aria-hidden')).toBe('true');
  expect(mounted - closed + childMounted - childClosed).toBe(0);
  expect(childChanges.at(-1)).toBeUndefined();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('标签页');
  await click('标签页');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(document.querySelector('[role="tab"]')!.textContent).toBe('新标签页');
});

test('another host panel or covered page hides the tab shell without retaining its reader', async () => {
  mounted = closed = 0;
  await render();
  await click('标签页');
  await changes();
  expect(mounted - closed).toBe(1);
  await render('s', true);
  const shell = document.querySelector<HTMLElement>('#session-tabs')!;
  expect(shell.hidden).toBe(true);
  expect(shell.classList.contains('right-sidebar')).toBe(false);
  expect(mounted - closed).toBe(0);
  expect(document.querySelectorAll('.right-sidebar')).toHaveLength(1);
  expect(document.querySelector('.right-sidebar')!.textContent).toContain('Host details body');
  await render();
  await click('标签页');
  await render('s', false, true);
  expect(document.querySelector<HTMLElement>('#session-tabs')!.hidden).toBe(true);
  expect(mounted - closed).toBe(0);
});

test('opening tabs replaces the host details panel without losing the open intent', async () => {
  function Surface() {
    const [hostOpen, setHostOpen] = useState(true);
    return (
      <SessionPage
        workspaces={[]}
        readingKey="s"
        sessionLabel="Conversation"
        messages={[]}
        connected
        connectionLabel=""
        loading={false}
        actions={{}}
        fileChangesContent={<Changes />}
        detailPanel={
          hostOpen
            ? {
                label: 'Host details',
                content: <p>Host details body</p>,
                onClose: () => setHostOpen(false),
              }
            : undefined
        }
      />
    );
  }
  root = createRoot(document.body);
  await act(() => root!.render(<Surface />));
  const group = document.querySelector<HTMLElement>('.client-content-panels')!;
  Object.defineProperty(group, 'offsetWidth', { configurable: true, value: 1200 });
  group.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 1200, 800);
  expect(document.querySelector('.right-sidebar')!.textContent).toContain('Host details body');
  await click('标签页');
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
  expect(document.body.textContent).not.toContain('Host details body');
  expect(
    document.querySelector('[aria-controls="session-tabs"]')!.getAttribute('aria-expanded'),
  ).toBe('true');
  expect(document.querySelector('#session-tabs')!.getAttribute('aria-hidden')).toBe('false');
});

test('child requests reuse exact carrier tabs and only the visible selected child owns a reader', async () => {
  childMounted = childClosed = 0;
  childChanges.length = 0;
  released.length = 0;
  const first = {
    requestId: 1,
    sessionId: 'child',
    executionId: 'original',
    title: 'First task',
    childAgentIdentity: JSON.stringify(['store', 'child']),
  };
  await render('s', false, false, first);
  expect(document.querySelector('#session-tabs')!.getAttribute('aria-hidden')).toBe('false');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(browserIds()).toHaveLength(0);
  const icon = document.querySelector('[role="tab"] [data-child-icon]')!;
  const appearance = childAgentAppearance(first.childAgentIdentity);
  expect(icon.getAttribute('data-child-icon')).toBe(String(appearance.icon));
  expect(icon.getAttribute('data-child-color')).toBe(String(appearance.color));
  expect(document.querySelector('.session-tab-child')!.textContent).toBe('Child child / original');
  expect(childMounted - childClosed).toBe(1);
  expect(childChanges.at(-1)).toEqual({ sessionId: 'child', executionId: 'original' });
  await render('s', false, false, { ...first, requestId: 2, title: 'Updated task' });
  expect(document.querySelector('[role="tab"] [data-child-icon]')).toBe(icon);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(childMounted).toBe(1);

  await render('s', false, false, {
    ...first,
    requestId: 3,
    executionId: 'later',
    title: 'Later task',
  });
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  for (const decoration of document.querySelectorAll('[role="tab"] [data-child-icon]')) {
    expect(decoration.getAttribute('data-child-icon')).toBe(String(appearance.icon));
    expect(decoration.getAttribute('data-child-color')).toBe(String(appearance.color));
  }
  expect(childMounted - childClosed).toBe(1);
  expect(childChanges.at(-1)).toEqual({ sessionId: 'child', executionId: 'later' });
  await click('新建标签页');
  expect(childMounted - childClosed).toBe(0);
  expect(childChanges.at(-1)).toBeUndefined();
  await selectTab('Updated task');
  expect(childChanges.at(-1)).toEqual({ sessionId: 'child', executionId: 'original' });
  expect(document.querySelector('.session-tab-child')!.textContent).toBe('Child child / original');
  await render('s', false, true);
  expect(childMounted - childClosed).toBe(0);
  expect(childChanges.at(-1)).toBeUndefined();
  await render();
  expect(childMounted - childClosed).toBe(1);
  await click('收起标签栏');
  expect(childMounted - childClosed).toBe(0);
  await click('标签页');
  expect(childMounted - childClosed).toBe(1);
  await click('关闭标签页：Updated task');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(childChanges.at(-1)).toEqual({ sessionId: 'child', executionId: 'later' });
  await render('other');
  expect(childMounted - childClosed).toBe(0);
  expect(childChanges.at(-1)).toBeUndefined();
  expect(released).toHaveLength(0);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
});

test('child navigation after closing the final tab does not create an empty browser page', async () => {
  childMounted = childClosed = 0;
  released.length = 0;
  const child = { requestId: 1, sessionId: 'child', executionId: 'task', title: 'Child task' };
  await render();
  expect(browserIds()).toHaveLength(0);
  for (const requestId of [1, 2]) {
    await render('s', false, false, { ...child, requestId });
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(browserIds()).toHaveLength(0);
    expect(childMounted - childClosed).toBe(1);
    await click('关闭标签页：Child task');
    expect(document.querySelector('#session-tabs')!.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(childMounted - childClosed).toBe(0);
  }
  expect(released).toHaveLength(0);
  await click('标签页');
  expect(browserIds()).toHaveLength(1);
  await render('s', false, false, { ...child, requestId: 3 });
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(browserIds()).toHaveLength(1);
});

test('full tabs reject a new child with feedback while an existing child can still be selected', async () => {
  childMounted = childClosed = 0;
  const first = { requestId: 10, sessionId: 'child', executionId: 'original', title: 'First task' };
  await render('s', false, false, first);
  for (let i = 0; i < 7; i++) await click('新建标签页');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  expect(childMounted - childClosed).toBe(0);
  await render('s', false, false, {
    requestId: 11,
    sessionId: 'other-child',
    executionId: 'other-task',
    title: 'Other task',
  });
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  expect(document.body.textContent).toContain('标签页已满，请关闭一个标签页后重试。');
  expect(childMounted - childClosed).toBe(0);
  await render('s', false, false, { ...first, requestId: 12 });
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  expect(childMounted - childClosed).toBe(1);
  expect(document.body.textContent).not.toContain('标签页已满');
});

test('managed browser is one retained tab in the existing strip; switching and collapsing only revoke observation', async () => {
  workspaceMounts = workspaceUnmounts = 0;
  let closedWorkspace = 0;
  const request = {
    requestId: 1,
    onClose: () => {
      closedWorkspace++;
    },
  };
  await render('a', false, false, undefined, request);
  expect(document.querySelectorAll('[aria-label="右侧栏标签页"]')).toHaveLength(1);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  const frame = document.querySelector('[data-workspace-visible]')!;
  expect(frame.closest('#session-tabs')).not.toBeNull();
  expect(frame.getAttribute('data-workspace-visible')).toBe('true');
  await click('新建标签页');
  expect(frame.getAttribute('data-workspace-visible')).toBe('false');
  expect(workspaceMounts).toBe(1);
  expect(workspaceUnmounts).toBe(0);
  await selectTab('Agent 浏览器');
  expect(frame.getAttribute('data-workspace-visible')).toBe('true');
  await click('收起标签栏');
  expect(frame.getAttribute('data-workspace-visible')).toBe('false');
  await render('a', false, false, undefined, { ...request, requestId: 2 });
  expect(document.querySelector('[data-workspace-visible]')).toBe(frame);
  expect(frame.getAttribute('data-workspace-visible')).toBe('true');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(closedWorkspace).toBe(0);
  await click('关闭标签页：Agent 浏览器');
  expect(closedWorkspace).toBe(1);
  expect(workspaceUnmounts).toBe(1);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  await render('b');
  expect(document.querySelector('[data-workspace-visible]')).toBeNull();
});

test('managed browser shares the eight-tab limit and an explicit request reselects it without duplicating', async () => {
  let refused = 0;
  const request = {
    requestId: 1,
    onClose: () => {
      refused++;
    },
  };
  await render();
  await click('标签页');
  for (let i = 0; i < 7; i++) await click('新建标签页');
  await render('s', false, false, undefined, request);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  expect(refused).toBe(1);
  expect(document.body.textContent).toContain('标签页已满');
  await click('关闭标签页：新标签页');
  await render('s', false, false, undefined, { ...request, requestId: 2 });
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  expect(document.querySelectorAll('[data-workspace-visible]')).toHaveLength(1);
  await selectTab('新标签页');
  await render('s', false, false, undefined, { ...request, requestId: 3 });
  expect(
    document.querySelector('[data-workspace-visible]')?.getAttribute('data-workspace-visible'),
  ).toBe('true');
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  expect(refused).toBe(1);
});

test('same-commit workspace and child requests reserve a shared final tab slot', async () => {
  let workspaceRefused = 0;
  await render();
  await click('标签页');
  for (let i = 0; i < 6; i++) await click('新建标签页');
  await render(
    's',
    false,
    false,
    { requestId: 20, sessionId: 'late-child', title: 'Concurrent child' },
    {
      requestId: 20,
      onClose: () => {
        workspaceRefused++;
      },
    },
  );
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
  // Child navigation uses the layout phase and reserves the final slot first.
  expect(document.querySelectorAll('[data-workspace-visible]')).toHaveLength(0);
  expect(document.querySelector('[role="tab"][title="Concurrent child"]')).not.toBeNull();
  expect(document.body.textContent).toContain('标签页已满');
  expect(workspaceRefused).toBe(1);
});

test('a verified retained browser key survives background renders while a new reading scope must restore again', async () => {
  const calls: string[] = [];
  let confirm!: (page: { id: string; title: string }) => void;
  const nextPage = new Promise<{ id: string; title: string }>((resolve) => {
    confirm = resolve;
  });
  root = createRoot(document.body);
  const tree = (loading: boolean, scope = 'original') => (
    <SessionPage
      workspaces={[]}
      selected={scope}
      readingKey={scope}
      sessionLabel="Conversation"
      messages={[]}
      connected
      connectionLabel=""
      loading={loading}
      actions={{}}
      browserRestoreKey={scope}
      restoreBrowser={async () => {
        calls.push(scope);
        return scope === 'original' ? { id: 'retained', title: 'Original page' } : nextPage;
      }}
      renderBrowser={({ id }) => <section data-browser-id={id}>Retained page</section>}
    />
  );
  await act(async () => {
    root!.render(tree(false));
    await Bun.sleep(10);
  });
  const retained = document.querySelector('[data-browser-id="retained"]');
  const originalTab = document.querySelector('[role="tab"]');
  expect(retained).not.toBeNull();
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const loading of [true, false]) {
      await act(async () => {
        root!.render(tree(loading));
        await Bun.sleep(5);
      });
      expect(calls).toEqual(['original']);
      expect(document.body.textContent).not.toContain('正在核对保留页面');
      expect(document.querySelector('[data-browser-id="retained"]')).toBe(retained);
      expect(document.querySelector('[role="tab"]')).toBe(originalTab);
    }
  }
  await act(async () => {
    root!.render(tree(false, 'next'));
    await Bun.sleep(5);
  });
  expect(calls).toEqual(['original', 'next']);
  expect(document.querySelector('[data-browser-id="retained"]')).toBeNull();
  expect(document.body.textContent).toContain('正在核对保留页面');
  await act(async () => {
    confirm({ id: 'next-page', title: 'Next page' });
    await Bun.sleep(5);
  });
  expect(document.querySelector('[data-browser-id="next-page"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('正在核对保留页面');
});

test('a new browser restore key rechecks the retained tab without inserting a status into its existing layout', async () => {
  const reads: string[] = [];
  let resolve!: (page: { id: string; title: string }) => void;
  const pending = new Promise<{ id: string; title: string }>((done) => {
    resolve = done;
  });
  const tree = (key: string) => (
    <SessionPage
      workspaces={[]}
      selected="session-a"
      readingKey="session-a"
      sessionLabel="Conversation"
      messages={[]}
      connected
      connectionLabel=""
      loading={false}
      actions={{}}
      browserRestoreKey={key}
      restoreBrowser={async () => {
        reads.push(key);
        if (key === 'failed-browser-request') throw Error('retained_page_unconfirmed');
        return key === 'first-browser-request'
          ? { id: 'retained-page', title: 'Existing ordinary page' }
          : pending;
      }}
      renderBrowser={({ id }) => (
        <section data-browser-id={id}>
          <div className="native-browser-toolbar">Existing toolbar</div>
          <div className="native-browser-viewport">Existing page</div>
        </section>
      )}
    />
  );
  root = createRoot(document.body);
  await act(async () => {
    root!.render(tree('first-browser-request'));
    await Bun.sleep(5);
  });
  const page = document.querySelector('[data-browser-id="retained-page"]')!;
  const toolbar = page.querySelector('.native-browser-toolbar')!;
  const viewport = page.querySelector('.native-browser-viewport')!;
  const tab = document.querySelector('[role="tab"]')!;
  const layout = document.querySelector('.session-tabs-root')!;
  const children = [...layout.children];
  expect(reads).toEqual(['first-browser-request']);
  expect(page).not.toBeNull();

  await act(async () => {
    root!.render(tree('new-task-browser-request'));
    await Bun.sleep(5);
  });
  // A changed request key still performs its real read and closes allocation
  // while the exact retained page stays mounted. Only its layout remains quiet.
  expect(reads).toEqual(['first-browser-request', 'new-task-browser-request']);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')!.disabled).toBe(
    true,
  );
  expect(document.querySelector('[data-browser-id="retained-page"]')).toBe(page);
  expect(page.querySelector('.native-browser-toolbar')).toBe(toolbar);
  expect(page.querySelector('.native-browser-viewport')).toBe(viewport);
  expect(document.querySelector('[role="tab"]')).toBe(tab);
  expect(layout.children).toHaveLength(children.length);
  for (const [index, child] of children.entries()) expect(layout.children[index]).toBe(child);
  expect([...layout.children].some((node) => node.textContent === '正在核对保留页面…')).toBe(false);

  await act(async () => {
    resolve({ id: 'retained-page', title: 'Existing ordinary page' });
    await Bun.sleep(5);
  });
  expect(document.querySelector('[data-browser-id="retained-page"]')).toBe(page);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')!.disabled).toBe(
    false,
  );
  expect(layout.children).toHaveLength(children.length);
  for (const [index, child] of children.entries()) expect(layout.children[index]).toBe(child);

  await act(async () => {
    root!.render(tree('failed-browser-request'));
    await Bun.sleep(5);
  });
  expect(reads).toEqual([
    'first-browser-request',
    'new-task-browser-request',
    'failed-browser-request',
  ]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('保留页面尚未核实');
  expect(document.querySelector('[data-browser-id="retained-page"]')).toBe(page);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')!.disabled).toBe(
    true,
  );
  expect(
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent === '重查保留页面',
    ),
  ).toBe(true);
});

test('a fresh browser task adds its restored page beside the original tab and scope restoration keeps the selected page', async () => {
  released.length = 0;
  let pages = [{ id: 'original-page', title: 'Original page' }];
  let activeId = 'original-page';
  let targetId = 'original-page';
  const tree = (scope: string, key: number, request = true) => (
    <SessionPage
      workspaces={[]}
      selected={scope}
      readingKey={scope}
      sessionLabel="Conversation"
      messages={[]}
      connected
      connectionLabel=""
      loading={false}
      actions={{}}
      closeBrowser={(id) => released.push(id)}
      renderBrowser={({ id, visible }) => <section data-browser-id={id} data-visible={visible} />}
      restoreBrowser={async () => {
        if (scope !== 'original') return null;
        const target = pages.find((page) => page.id === targetId)!;
        return { ...target, pages, activeId };
      }}
      browserRestoreKey={`${scope}:${key}`}
      browserTabRequest={request ? { requestId: key, createIfMissing: false } : undefined}
    />
  );
  root = createRoot(document.body);
  await act(async () => root!.render(tree('original', 1)));
  const original = document.querySelector('[data-browser-id="original-page"]');
  expect(original).not.toBeNull();
  pages = [...pages, { id: 'new-task-page', title: 'New task page' }];
  targetId = 'new-task-page';
  await act(async () => root!.render(tree('original', 2)));
  expect(document.querySelector('[data-browser-id="original-page"]')).toBe(original);
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(
    document.querySelector('[role="tab"][title="New task page"]')?.getAttribute('aria-selected'),
  ).toBe('true');
  activeId = 'new-task-page';
  await act(async () => root!.render(tree('other', 3, false)));
  expect(browserIds()).toEqual([]);
  expect(released).toEqual([]);
  await act(async () => root!.render(tree('original', 4, false)));
  expect(browserIds()).toEqual(['original-page', 'new-task-page']);
  expect(
    document.querySelector('[role="tab"][title="New task page"]')?.getAttribute('aria-selected'),
  ).toBe('true');
  await click('关闭标签页：New task page');
  expect(released).toEqual(['new-task-page']);
  await act(() => root!.unmount());
  root = undefined;
  pages = pages.filter((page) => page.id !== 'new-task-page');
  activeId = 'original-page';
  targetId = 'original-page';
  root = createRoot(document.body);
  await act(async () => root!.render(tree('original', 5)));
  expect(browserIds()).toEqual(['original-page']);
  expect(released).toEqual(['new-task-page']);
});

test('browser toolbar keeps navigation separate from portalled annotation forms and agent control', async () => {
  const host = document.createElement('div');
  const popup = document.createElement('div');
  document.body.append(host, popup);
  root = createRoot(host);
  let navigated = 0;
  let annotated = 0;
  const toolbar = (canNavigate: boolean) => (
    <SessionBrowserToolbar
      address="https://example.test"
      loading={false}
      hasPage
      canGoBack
      canGoForward
      canNavigate={canNavigate}
      onAddressChange={() => {}}
      onAddressFocus={() => {}}
      onNavigate={() => navigated++}
      onBack={() => {}}
      onForward={() => {}}
      onReload={() => {}}
      tools={createPortal(
        <form
          aria-label="注释说明"
          onSubmit={(event) => {
            event.preventDefault();
            annotated++;
          }}
        >
          <button type="submit">加入提示词</button>
        </form>,
        popup,
      )}
    />
  );
  await act(() => root!.render(toolbar(true)));
  const submit = (node: Element) =>
    node.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await act(() => {
    submit(popup.querySelector('form')!);
  });
  expect(annotated).toBe(1);
  expect(navigated).toBe(0);
  expect(document.querySelector('form form')).toBeNull();
  await act(() => {
    host.querySelector<HTMLInputElement>('input')!.focus();
    submit(host.querySelector('form')!);
  });
  expect(navigated).toBe(1);
  await act(() => root!.render(toolbar(false)));
  expect(host.querySelector<HTMLInputElement>('input')!.readOnly).toBe(true);
  expect([...host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  await act(() => {
    submit(host.querySelector('form')!);
  });
  expect(navigated).toBe(1);
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('https://example.test');
});

test('the original tab header retains document panel associations and keyboard selection', async () => {
  await render();
  await click('标签页');
  await click('新建标签页');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs).toHaveLength(2);
  for (const tab of tabs) {
    const target = tab.getAttribute('aria-controls');
    expect(target).not.toBeNull();
    const panel = document.getElementById(target!);
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
  }
  await act(() => tabs[0]!.focus());
  await act(async () => {
    tabs[0]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await Bun.sleep(10);
  });
  expect(document.activeElement).toBe(tabs[1]!);
  expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
  expect(document.querySelectorAll('.session-tab-content')).toHaveLength(2);
});
