import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBrowserRequest, NativeBrowserState } from '../../src/native-browser-bridge';
import { NativeBrowserPane } from '../../src/native-browser-pane';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('native page geometry follows the animated panel intersection and stops presenting at zero width or close', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayout = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let panelWidth = 150;
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'clip-panel') return new dom.window.DOMRect(100, 50, panelWidth, 500);
    if (this.classList.contains('native-browser-viewport'))
      return new dom.window.DOMRect(100, 100, 300, 700);
    return originalRect.call(this);
  };
  const observers: PanelResizeObserver[] = [];
  class PanelResizeObserver {
    targets = new Set<Element>();
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(element: Element) {
      this.targets.add(element);
    }
    unobserve(element: Element) {
      this.targets.delete(element);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  Object.assign(globalThis, { ResizeObserver: PanelResizeObserver });
  const requests: NativeBrowserRequest[] = [];
  const state: NativeBrowserState = {
    id: 'browser',
    url: 'http://localhost/page',
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  Object.assign(window, {
    kiteNative: {
      async browserRequest(request: NativeBrowserRequest) {
        requests.push(request);
        return request.action === 'state' ? state : null;
      },
      watchBrowser() {
        return () => {};
      },
    },
  });
  const root = createRoot(document.getElementById('root')!);
  const render = (visible: boolean) =>
    root.render(
      <div id="clip-panel" data-panel>
        <NativeBrowserPane id="browser" visible={visible} tools={null} onTitleChange={() => {}} />
      </div>,
    );
  const latest = () =>
    requests
      .filter(
        (request): request is Extract<NativeBrowserRequest, { action: 'present' }> =>
          request.action === 'present',
      )
      .at(-1)!.bounds;
  const resize = async (width: number) => {
    panelWidth = width;
    await act(async () => {
      const panel = document.getElementById('clip-panel')!;
      for (const observer of observers)
        if (observer.targets.has(panel))
          observer.callback([], observer as unknown as ResizeObserver);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };
  try {
    await act(async () => render(true));
    expect(latest()).toEqual({ x: 100, y: 100, width: 150, height: 450, radius: 0 });
    await resize(80);
    expect(latest()?.width).toBe(80);
    await resize(0);
    expect(latest()).toBeNull();
    await resize(300);
    expect(latest()?.width).toBe(300);
    await act(() => render(false));
    expect(latest()).toBeNull();
    expect(requests.some((request) => request.action === 'close')).toBe(false);
  } finally {
    await act(() => root.unmount());
    restoreLayout();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
