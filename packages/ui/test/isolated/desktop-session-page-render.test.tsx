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
  try {
    await show('a');
    const header = host.querySelector('.session-header');
    const sidebar = host.querySelector('.sidebar');
    const originalBrowser = [...browsers][0]!;
    directoryEvaluations = 0;
    await show('b');
    expect(directoryEvaluations).toBe(1);
    expect(host.querySelector('.session-header')).toBe(header);
    expect(host.querySelector('.sidebar')).toBe(sidebar);
    expect(closed).toEqual([originalBrowser]);
    expect(browsers.size).toBe(2);
    const secondBrowser = [...browsers][1]!;
    directoryEvaluations = 0;
    await show('c');
    expect(directoryEvaluations).toBe(1);
    expect(host.querySelector('.session-header')).toBe(header);
    expect(host.querySelector('.sidebar')).toBe(sidebar);
    expect(closed).toEqual([originalBrowser, secondBrowser]);
    expect(browsers.size).toBe(3);
    await act(async () => root.unmount());
    unmounted = true;
    expect(closed).toEqual([...browsers]);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
  }
});
