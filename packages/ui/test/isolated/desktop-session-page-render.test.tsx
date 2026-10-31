import { afterAll, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { SessionPageProps } from '../../src/desktop/SessionPage';

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
