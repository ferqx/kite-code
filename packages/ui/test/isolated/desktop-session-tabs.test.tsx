import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect, useState } from 'react';
import { childAgentAppearance } from '../../src/desktop/ApprovalHeader';
import type { SessionChildTabRequest, SessionChildTarget } from '../../src/desktop/SessionTabs';

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
async function render(
  scope = 's',
  hostDetails = false,
  covered = false,
  childTabRequest?: SessionChildTabRequest,
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
test('responsive resize retains tabs; switching session releases their native resources and reader', async () => {
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
  expect(released.sort()).toEqual(ids.sort());
  expect(mounted - closed).toBe(0);
  expect(browserIds()).toHaveLength(0);
  await click('标签页');
  expect(browserIds()).toHaveLength(1);
  expect(ids).not.toContain(browserIds()[0]);
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
  expect(released).toHaveLength(1);
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
