import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect, useLayoutEffect, useState } from 'react';
import { childAgentAppearance } from '../../src/desktop/ApprovalHeader';
import type { SessionPageProps } from '../../src/desktop/SessionPage';
import type {
  SessionChildTabRequest,
  SessionChildTarget,
  SessionTabsModel,
} from '../../src/desktop/SessionTabs';
import type {
  SessionTabsChromeAction,
  SessionTabsChromePresentation,
} from '../../src/desktop/types';

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
const { SessionBrowserToolbar, SessionTabs, SessionTabsChrome, useSessionTabs } = await import(
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
  chrome?: Pick<SessionPageProps, 'onTabsChromePresentation' | 'tabsChromeHosted'>,
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
        {...chrome}
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

function preparationFixture(withClose = false, failClose = false) {
  let model!: SessionTabsModel;
  let presentation: SessionTabsChromePresentation | null = null;
  const calls: {
    from: string;
    target: string;
    cancelled: number;
    resolve(value?: { cancel(): void } | null): void;
    reject(): void;
  }[] = [];
  const closed: { id: string; visible?: string; committed?: string }[] = [];
  const collapsed: number[] = [],
    closePreparations: { cancelled: number; resolve(value?: { cancel(): void } | null): void }[] =
      [];
  const prepareClose = () =>
    new Promise<{ cancel(): void } | null>((resolve) => {
      const call = {
        cancelled: 0,
        resolve(value?: { cancel(): void } | null) {
          resolve(value === undefined ? { cancel: () => call.cancelled++ } : value);
        },
      };
      closePreparations.push(call);
    });
  let afterCommit: (() => void) | undefined;
  let replaceScope!: (scope: string) => void;
  let removeOwner!: () => void;
  const prepare = (from: string, target: string) =>
    new Promise<{ cancel(): void } | null>((resolve, reject) => {
      const call = {
        from,
        target,
        cancelled: 0,
        resolve: (value?: { cancel(): void } | null) =>
          resolve(value === undefined ? { cancel: () => call.cancelled++ } : value),
        reject: () => reject(Error('preparation_unavailable')),
      };
      calls.push(call);
    });
  function Harness({ scope, enabled }: { scope: string; enabled: boolean }) {
    model = useSessionTabs(
      scope,
      (id) => {
        closed.push({
          id,
          visible: document.querySelector<HTMLElement>('[data-browser-id][data-visible="true"]')
            ?.dataset.browserId,
          committed: presentation?.data.active,
        });
        return failClose ? Promise.reject(Error('close_unconfirmed')) : undefined;
      },
      undefined,
      undefined,
      false,
      enabled ? prepare : undefined,
      withClose ? prepareClose : undefined,
    );
    useLayoutEffect(() => afterCommit?.());
    return (
      <SessionTabs
        model={model}
        visible
        changes={null}
        onClose={() => {
          collapsed.push(model.tabs.length);
        }}
        scopeKey={scope}
        onChromePresentation={(next) => {
          presentation = next;
        }}
        renderBrowser={({ id, visible }) => <section data-browser-id={id} data-visible={visible} />}
      />
    );
  }
  function Shell({ scope, enabled }: { scope: string; enabled: boolean }) {
    const [replacement, setReplacement] = useState<string>();
    const [visible, setVisible] = useState(true);
    replaceScope = setReplacement;
    removeOwner = () => setVisible(false);
    return visible ? <Harness scope={replacement ?? scope} enabled={enabled} /> : null;
  }
  return {
    calls,
    closed,
    collapsed,
    closePreparations,
    get model() {
      return model;
    },
    raceAfterCommit(id: string, boundary: 'scope' | 'unmount') {
      afterCommit = () => {
        if (model.tabs.some((tab) => tab.id === id)) return;
        afterCommit = undefined;
        if (boundary === 'scope') replaceScope('after-committed-close');
        else removeOwner();
      };
    },
    render(scope = 'original', enabled = true) {
      root ??= createRoot(document.body);
      return act(() => root!.render(<Shell scope={scope} enabled={enabled} />));
    },
    async twoPages() {
      await this.render();
      await act(() => model.addBrowser());
      const first = model.active;
      await act(() => model.addBrowser());
      return { first, second: model.active };
    },
  };
}

test('last browser close keeps its UI until prepared and dispatches only after the empty DOM commit', async () => {
  const f = preparationFixture(true);
  await f.render();
  await act(() => f.model.addBrowser());
  const id = f.model.active;
  await click('关闭标签页：新标签页');
  expect(f.model.tabs).toHaveLength(1);
  expect(f.closed).toHaveLength(0);
  expect(f.collapsed).toHaveLength(0);
  await act(() => f.closePreparations[0]!.resolve());
  expect(f.model.tabs).toHaveLength(0);
  expect(f.closed).toEqual([{ id, visible: undefined, committed: '' }]);
  expect(f.collapsed).toHaveLength(1);
});

test('closing the final active browser prepares Root changes as its successor without collapsing the sidebar', async () => {
  const f = preparationFixture(true);
  await f.render();
  await act(() => f.model.openChanges());
  const changes = f.model.active;
  await act(() => f.model.addBrowser());
  const browser = f.model.active;
  await click('关闭标签页：新标签页');
  expect(f.model.active).toBe(browser);
  expect(f.closed).toHaveLength(0);
  await act(() => f.closePreparations[0]!.resolve());
  expect(f.model.active).toBe(changes);
  expect(f.closed).toEqual([{ id: browser, visible: undefined, committed: changes }]);
  expect(f.collapsed).toHaveLength(0);
});

test('an unconfirmed browser close restores the same tab only under its original intent', async () => {
  const f = preparationFixture(true, true);
  await f.render();
  await act(() => f.model.addBrowser());
  const id = f.model.active;
  await click('关闭标签页：新标签页');
  await act(() => f.closePreparations[0]!.resolve());
  expect(f.model.active).toBe(id);
  expect(f.model.tabs).toHaveLength(1);
  expect(f.model.closeIssue).toContain('未能确认');
  expect(f.model.closeReveal).toBe(1);
  expect(f.closed).toHaveLength(1);
});

test('a late last-close preparation is cancelled after its scope changes without collapsing or closing', async () => {
  const f = preparationFixture(true);
  await f.render();
  await act(() => f.model.addBrowser());
  await click('关闭标签页：新标签页');
  await f.render('replacement');
  await act(() => f.closePreparations[0]!.resolve());
  expect(f.closePreparations[0]!.cancelled).toBe(1);
  expect(f.closed).toHaveLength(0);
  expect(f.collapsed).toHaveLength(0);
});

test('browser selection and current close await preparation; close is sent after its successor commit', async () => {
  const f = preparationFixture();
  const { first, second } = await f.twoPages();
  const original = document.querySelector(`[data-browser-id="${first}"]`);
  await act(() => f.model.select(first));
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ from: second, target: first });
  expect(f.model.active).toBe(second);
  await act(() => f.calls[0]!.resolve());
  expect(f.model.active).toBe(first);
  expect(f.calls[0]!.cancelled).toBe(0);
  expect(document.querySelector(`[data-browser-id="${first}"]`)).toBe(original);
  await act(() => f.model.closeTab(first));
  expect(f.calls).toHaveLength(2);
  expect(f.closed).toEqual([]);
  expect(f.model.active).toBe(first);
  await act(() => f.calls[1]!.resolve());
  expect(f.closed).toEqual([{ id: first, visible: second, committed: second }]);
  expect(f.model.active).toBe(second);
});

test('a newer intent, target closure or scope replacement cancels late browser preparation without replay', async () => {
  const f = preparationFixture();
  const { first, second } = await f.twoPages();
  await act(() => f.model.select(first));
  expect(f.calls).toHaveLength(1);
  await act(() => f.model.select(second));
  await act(() => f.calls[0]!.resolve());
  expect(f.model.active).toBe(second);
  expect(f.calls[0]!.cancelled).toBe(1);
  await act(() => f.model.select(first));
  await act(() => f.model.closeTab(first));
  expect(f.closed.map(({ id }) => id)).toEqual([first]);
  await act(() => f.calls[1]!.resolve());
  expect(f.calls[1]!.cancelled).toBe(1);
  expect(f.model.active).toBe(second);
  await act(() => f.model.addBrowser());
  await act(() => f.model.select(second));
  expect(f.calls).toHaveLength(3);
  await f.render('replacement');
  await act(() => f.calls[2]!.resolve());
  expect(f.calls[2]!.cancelled).toBe(1);
  expect(f.model.tabs).toEqual([]);
  expect(f.closed.map(({ id }) => id)).toEqual([first]);
});

test('failed preparation falls back once; a late receipt after unmount is cancelled', async () => {
  const f = preparationFixture();
  const { first, second } = await f.twoPages();
  await act(() => f.model.select(first));
  expect(f.calls).toHaveLength(1);
  await act(() => f.calls[0]!.reject());
  expect(f.model.active).toBe(first);
  await act(() => f.model.select(second));
  await act(() => root!.unmount());
  root = undefined;
  await act(() => f.calls[1]!.resolve());
  expect(f.calls[1]!.cancelled).toBe(1);
  expect(f.closed).toEqual([]);
});

for (const intent of ['select', 'close'] as const)
  for (const order of ['old-first', 'latest-first'] as const)
    test(`repeated preparation for the same target keeps the latest ${intent} intent when receipts return ${order}`, async () => {
      const f = preparationFixture();
      const { first, second } = await f.twoPages();
      await act(() => f.model.select(first));
      await act(() => {
        if (intent === 'select') f.model.select(first);
        else f.model.closeTab(second);
      });
      expect(f.calls).toHaveLength(2);
      expect(f.calls.map(({ from, target }) => ({ from, target }))).toEqual([
        { from: second, target: first },
        { from: second, target: first },
      ]);
      expect(f.model.active).toBe(second);
      expect(f.closed).toEqual([]);
      const firstReceipt = order === 'old-first' ? 0 : 1;
      await act(() => f.calls[firstReceipt]!.resolve());
      expect(f.model.active).toBe(order === 'old-first' ? second : first);
      if (order === 'old-first') expect(f.closed).toEqual([]);
      await act(() => f.calls[1 - firstReceipt]!.resolve());
      expect(f.calls.map(({ cancelled }) => cancelled)).toEqual([1, 0]);
      expect(f.model.active).toBe(first);
      expect(f.closed).toEqual(
        intent === 'close' ? [{ id: second, visible: first, committed: first }] : [],
      );
      expect(f.model.tabs.map((tab) => tab.id)).toEqual(
        intent === 'close' ? [first] : [first, second],
      );
    });

for (const boundary of ['scope', 'unmount'] as const)
  test(`an already committed close is dispatched once before an ancestor ${boundary} change`, async () => {
    const f = preparationFixture();
    const { first, second } = await f.twoPages();
    await act(() => f.model.closeTab(second));
    expect(f.closed).toEqual([]);
    f.raceAfterCommit(second, boundary);
    await act(() => f.calls[0]!.resolve());
    expect(f.closed).toEqual([{ id: second, visible: first, committed: first }]);
    await act(() => {});
    expect(f.closed).toHaveLength(1);
  });

test('current close chooses the next then previous array neighbor; background and final closes do not prepare', async () => {
  const f = preparationFixture();
  const { first, second } = await f.twoPages();
  await act(() => f.model.addBrowser());
  const third = f.model.active;
  await act(() => f.model.select(second));
  await act(() => f.calls[0]!.resolve());
  await act(() => f.model.closeTab(second));
  expect(f.calls[1]).toMatchObject({ from: second, target: third });
  await act(() => f.calls[1]!.resolve());
  expect(f.model.active).toBe(third);
  await act(() => f.model.closeTab(third));
  expect(f.calls[2]).toMatchObject({ from: third, target: first });
  await act(() => f.calls[2]!.resolve());
  expect(f.model.active).toBe(first);
  await act(() => f.model.addBrowser());
  const last = f.model.active;
  const prepared = f.calls.length;
  await act(() => f.model.closeTab(first));
  expect(f.model.active).toBe(last);
  expect(f.calls).toHaveLength(prepared);
  await act(() => f.model.closeTab(last));
  expect(f.model.tabs).toEqual([]);
  expect(f.calls).toHaveLength(prepared);
  expect(f.closed.map(({ id }) => id)).toEqual([second, third, first, last]);
});

test('same-event ABA never sends obsolete preparation and a timed-out late receipt cannot change the adopted target', async () => {
  const f = preparationFixture();
  const { first, second } = await f.twoPages();
  await act(() => {
    f.model.select(first);
    f.model.select(second);
  });
  expect(f.calls).toEqual([]);
  expect(f.model.active).toBe(second);
  await act(() => f.model.select(first));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 280));
  });
  expect(f.model.active).toBe(first);
  const page = document.querySelector(`[data-browser-id="${first}"]`);
  await act(() => f.calls[0]!.resolve());
  expect(f.calls[0]!.cancelled).toBe(1);
  expect(f.model.active).toBe(first);
  expect(document.querySelector(`[data-browser-id="${first}"]`)).toBe(page);
});
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

test('the Chrome port retains one bounded tab model and visually hides only the hosted header', async () => {
  let presentation: SessionTabsChromePresentation | null = null;
  const port = (value: SessionTabsChromePresentation | null) => {
    presentation = value;
  };
  const current = () => presentation!;
  const options = { onTabsChromePresentation: port };
  released.length = 0;
  await render('original', false, false, undefined, undefined, options);
  expect(current().data).toMatchObject({
    scopeKey: 'original',
    tabs: [],
    visible: false,
    restoring: false,
    restoreIssue: false,
  });
  await click('标签页');
  const first = current().data.active;
  const originalDispatch = current().dispatch;
  const header = document.querySelector<HTMLElement>('.session-tabs-heading')!;
  const browser = document.querySelector(`[data-browser-id="${first}"]`)!;
  const originalTabs = current().data.tabs;
  expect(header.hasAttribute('inert')).toBe(false);
  expect(getComputedStyle(header).visibility).toBe('visible');
  await render('original', false, false, undefined, undefined, {
    ...options,
    tabsChromeHosted: true,
  });
  expect(document.querySelector('.session-tabs-heading')).toBe(header);
  expect(header.hasAttribute('inert')).toBe(true);
  expect(header.getAttribute('aria-hidden')).toBe('true');
  expect(header.hasAttribute('hidden')).toBe(false);
  expect(getComputedStyle(header).visibility).toBe('hidden');
  expect(getComputedStyle(header).display).toBe('block');
  expect(header.style.pointerEvents).toBe('none');
  expect(document.querySelector(`[data-browser-id="${first}"]`)).toBe(browser);
  expect(browser.closest('[inert], [aria-hidden="true"]')).toBeNull();
  expect(getComputedStyle(browser).visibility).toBe('visible');
  expect(current().data.tabs).toBe(originalTabs);
  expect(current().data.active).toBe(first);
  expect(released).toEqual([]);
  await render('original', false, false, undefined, undefined, options);
  expect(document.querySelector('.session-tabs-heading')).toBe(header);
  expect(header.hasAttribute('inert')).toBe(false);
  expect(header.hasAttribute('aria-hidden')).toBe(false);
  expect(getComputedStyle(header).visibility).toBe('visible');
  expect(header.style.pointerEvents).toBe('');
  expect(current().data.tabs).toBe(originalTabs);
  expect(current().data.active).toBe(first);
  await click('新建标签页');
  expect(current().data.tabs).toHaveLength(2);
  expect(current().data.active).not.toBe(first);
  expect(document.querySelector(`[data-browser-id="${first}"]`)).toBe(browser);
  expect(released).toEqual([]);
  expect(current().dispatch).toBe(originalDispatch);
  for (let i = 0; i < 9; i++) await act(() => current().dispatch({ type: 'add' }));
  expect(current().data.tabs).toHaveLength(8);
  expect(browserIds()).toHaveLength(8);
  expect(JSON.parse(JSON.stringify(current().data))).toEqual(current().data);
  await act(() => originalDispatch({ type: 'select', id: first }));
  expect(current().data.active).toBe(first);
  await render('original', false, true, undefined, undefined, options);
  expect(current().data.visible).toBe(false);
  const ids = current().data.tabs.map((tab) => tab.id);
  await act(() => originalDispatch({ type: 'close', id: first }));
  expect(current().data.tabs.map((tab) => tab.id)).toEqual(ids);
  expect(released).toEqual([]);
  await render('next', false, false, undefined, undefined, options);
  await click('标签页');
  const next = current().data.active;
  await act(() => originalDispatch({ type: 'close', id: next }));
  expect(current().data.tabs.map((tab) => tab.id)).toEqual([next]);
  expect(released).toEqual([]);
  const retired = current().dispatch;
  await act(() => root!.unmount());
  root = undefined;
  expect(presentation).toBeNull();
  await act(() => retired({ type: 'add' }));
  expect(presentation).toBeNull();
});

test('Chrome actions reuse original mixed-tab handlers, reader lifetime and final-close focus', async () => {
  let presentation: SessionTabsChromePresentation | null = null;
  const options = {
    onTabsChromePresentation: (value: SessionTabsChromePresentation | null) => {
      presentation = value;
    },
  };
  const current = () => presentation!;
  const dispatch = (action: SessionTabsChromeAction) => act(() => current().dispatch(action));
  let workspaceClosed = 0;
  const workspace = {
    requestId: 1,
    onClose: () => {
      workspaceClosed++;
    },
  };
  mounted = closed = childMounted = childClosed = 0;
  childChanges.length = 0;
  released.length = 0;
  await render('scope', false, false, undefined, workspace, options);
  await dispatch({ type: 'add' });
  const browser = current().data.active;
  await dispatch({ type: 'openChanges' });
  expect(mounted - closed).toBe(1);
  await render(
    'scope',
    false,
    false,
    {
      requestId: 1,
      sessionId: 'child-source',
      executionId: 'child-task',
      title: 'Child',
      childAgentIdentity: 'code',
    },
    workspace,
    options,
  );
  const child = current().data.tabs.find((tab) => tab.kind === 'child')!;
  expect(child).toMatchObject({
    sessionId: 'child-source',
    executionId: 'child-task',
    childAgentIdentity: 'code',
  });
  expect(current().data.tabs.map((tab) => tab.kind)).toEqual([
    'workspace',
    'browser',
    'changes',
    'child',
  ]);
  expect(childMounted - childClosed).toBe(1);
  expect(mounted - closed).toBe(0);
  await dispatch({ type: 'select', id: 'workspace' });
  expect(childMounted - childClosed).toBe(0);
  expect(childChanges.at(-1)).toBeUndefined();
  await dispatch({ type: 'close', id: 'workspace' });
  expect(workspaceClosed).toBe(1);
  await dispatch({ type: 'select', id: 'changes' });
  expect(mounted - closed).toBe(1);
  await dispatch({ type: 'close', id: browser });
  expect(released).toEqual([browser]);
  await dispatch({ type: 'close', id: child.id });
  await dispatch({ type: 'close', id: 'changes' });
  expect(current().data.tabs).toEqual([]);
  expect(current().data.visible).toBe(false);
  expect(mounted - closed).toBe(0);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('标签页');
});

test('the controlled Chrome view emits original actions and retains Radix keyboard focus without readers', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const actions: SessionTabsChromeAction[] = [];
  const presentation: SessionTabsChromePresentation = {
    data: {
      scopeKey: 'display',
      tabs: [
        { id: 'one', kind: 'browser', title: 'Original page' },
        { id: 'changes', kind: 'changes', title: '变更' },
        {
          id: 'child',
          kind: 'child',
          title: 'Child',
          sessionId: 'child-source',
          childAgentIdentity: 'code',
        },
        { id: 'workspace', kind: 'workspace', title: 'Managed' },
      ],
      active: 'one',
      visible: true,
      present: true,
      restoring: false,
      restoreIssue: false,
    },
    dispatch: (action) => actions.push(action),
  };
  await act(() => root!.render(<SessionTabsChrome {...presentation} />));
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(4);
  expect(host.querySelector('.session-tab-content')).toBeNull();
  expect(host.querySelector('[role="tabpanel"]')).toBeNull();
  expect(host.querySelector('[data-browser-id]')).toBeNull();
  const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  for (const tab of tabs) expect(tab.hasAttribute('aria-controls')).toBe(false);
  await act(() => tabs[0]!.focus());
  actions.length = 0;
  await act(async () => {
    tabs[0]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await Bun.sleep(10);
  });
  expect(document.activeElement).toBe(tabs[1]!);
  expect(actions).toContainEqual({ type: 'select', id: 'changes' });
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  await click('关闭标签页：Managed');
  await click('新建标签页');
  await click('收起标签栏');
  expect(actions.slice(-3)).toEqual([
    { type: 'close', id: 'workspace' },
    { type: 'add' },
    { type: 'collapse' },
  ]);
});

test('the Chrome port reports restore failure and retries only through the original restore owner', async () => {
  let presentation: SessionTabsChromePresentation | null = null;
  const reads: {
    resolve(page: { id: string; title: string }): void;
    reject(error: Error): void;
  }[] = [];
  root = createRoot(document.body);
  await act(() =>
    root!.render(
      <SessionPage
        workspaces={[]}
        readingKey="restore"
        sessionLabel="Restore"
        messages={[]}
        connected
        connectionLabel=""
        loading={false}
        actions={{}}
        onTabsChromePresentation={(value) => {
          presentation = value;
        }}
        restoreBrowser={() => new Promise((resolve, reject) => reads.push({ resolve, reject }))}
        renderBrowser={({ id }) => <section data-browser-id={id} />}
      />,
    ),
  );
  const current = () => presentation!;
  await click('标签页');
  expect(current().data.restoring).toBe(true);
  expect(current().data.tabs).toEqual([]);
  expect(reads).toHaveLength(1);
  await act(() => reads[0]!.reject(Error('original unavailable')));
  expect(current().data.restoreIssue).toBe(true);
  await act(() => current().dispatch({ type: 'add' }));
  expect(current().data.tabs).toEqual([]);
  await act(() => current().dispatch({ type: 'retryRestore' }));
  expect(reads).toHaveLength(2);
  expect(current().data.restoring).toBe(true);
  await act(() => reads[1]!.resolve({ id: 'original-page', title: 'Original retained page' }));
  expect(current().data).toMatchObject({
    restoring: false,
    restoreIssue: false,
    active: 'original-page',
  });
  expect(current().data.tabs).toHaveLength(1);
  expect(browserIds()).toEqual(['original-page']);
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
