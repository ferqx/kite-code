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

test('tab scope reconciliation does not repeat the retained page render or replace its shell and closes the original browser once', async () => {
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
    const originalBrowser = [...browsers][0]!;
    directoryEvaluations = 0;
    await show('b');
    expect(directoryEvaluations).toBe(1);
    expect(host.querySelector('.session-header')).toBe(header);
    expect(host.querySelector('.sidebar')).toBe(sidebar);
    expect(closed).toEqual([originalBrowser]);
    await openBrowser();
    expect(browsers.size).toBe(2);
    const secondBrowser = [...browsers][1]!;
    directoryEvaluations = 0;
    await show('c');
    expect(directoryEvaluations).toBe(1);
    expect(host.querySelector('.session-header')).toBe(header);
    expect(host.querySelector('.sidebar')).toBe(sidebar);
    expect(closed).toEqual([originalBrowser, secondBrowser]);
    await openBrowser();
    expect(browsers.size).toBe(3);
    await act(async () => root.unmount());
    unmounted = true;
    expect(closed).toEqual([...browsers]);
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
