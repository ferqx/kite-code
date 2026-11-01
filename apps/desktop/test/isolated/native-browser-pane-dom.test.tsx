import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { act, Component, type ComponentProps, type ReactNode } from 'react';
import { createBrowserDisplayBootstrap } from '../../electron/browser-display-bootstrap';
import {
  type NativeBrowserLayoutFrameAck,
  type NativeBrowserPresentationRequest,
  type NativeBrowserRequest,
  type NativeBrowserRestoreScope,
  type NativeBrowserState,
  nativeBrowserWitnessColors,
  projectNativeBrowserBounds,
  projectNativeBrowserLayout,
} from '../../src/native-browser-bridge';
import type { NativeBrowserToolbarPort } from '../../src/native-browser-chrome-types';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const initialGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const refresh = (await import(
  pathToFileURL(
    join(dirname(fileURLToPath(import.meta.resolve('@vitejs/plugin-react'))), 'refresh-runtime.js'),
  ).href
)) as {
  injectIntoGlobalHook(target: typeof globalThis): void;
  registerExportsForReactRefresh(id: string, exports: object): void;
  validateRefreshBoundaryAndEnqueueUpdate(
    id: string,
    previous: object,
    next: object,
  ): string | undefined;
};
refresh.injectIntoGlobalHook(globalThis);
const { createRoot } = await import('react-dom/client');
const { createPortal } = await import('react-dom');
const { NativeBrowserPane } = await import('../../src/native-browser-pane');
const { ResizablePanelGroup, ResizablePanel, ResizableHandle } = await import(
  '../../../../packages/ui/src/desktop/components/ui/resizable'
);
Object.assign(globalThis, initialGlobals);
bootstrap.window.close();

test('native geometry retries a rejected ACK only on a new layout event and follows every clipping ancestor', async () => {
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
  let clipWidth = 200;
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'clip-panel') return new dom.window.DOMRect(100, 50, panelWidth, 500);
    if (this.id === 'collapsible-viewport') return new dom.window.DOMRect(100, 50, clipWidth, 500);
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
  const accepted: NativeBrowserRequest[] = [];
  let rejectFirstPresent = true;
  let holdNext = false;
  let releaseHeld: (() => void) | undefined;
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
        if (request.action === 'present' && request.bounds) {
          if (rejectFirstPresent) {
            rejectFirstPresent = false;
            throw Error('browser_page_scope_denied');
          }
          if (holdNext) {
            holdNext = false;
            await new Promise<void>((resolve) => {
              releaseHeld = resolve;
            });
          }
          accepted.push(request);
        }
        return request.action === 'state' ? state : null;
      },
      watchBrowser() {
        return () => {};
      },
    },
  });
  const root = createRoot(document.getElementById('root')!);
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const render = (visible: boolean, presentationScope = scope) =>
    root.render(
      <div id="collapsible-viewport" style={{ overflow: 'hidden' }}>
        <div id="clip-panel" data-panel>
          <NativeBrowserPane
            id="browser"
            visible={visible}
            tools={null}
            scope={presentationScope}
            onTitleChange={() => {}}
          />
        </div>
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
    expect(accepted).toHaveLength(0);
    const rejectedCount = requests.length;
    await act(async () => {
      await Bun.sleep(80);
    });
    expect(requests).toHaveLength(rejectedCount); // no timed or recursive retry
    await resize(150); // the same bounds are eligible again after a new observation
    expect(accepted).toHaveLength(1);
    holdNext = true;
    await resize(80);
    expect(latest()?.width).toBe(80);
    const heldCount = requests.length;
    await resize(150); // returning to acknowledged bounds must supersede pending 80px
    expect(requests.length).toBe(heldCount + 1);
    expect(latest()?.width).toBe(150);
    await act(async () => {
      releaseHeld!();
      await Bun.sleep(40);
    });
    const settledCount = requests.length;
    await resize(150);
    expect(requests).toHaveLength(settledCount); // the old 80px ACK cannot replace 150px
    await resize(0);
    expect(latest()).toBeNull();
    await resize(300);
    expect(latest()?.width).toBe(200);
    clipWidth = 0;
    await act(async () => {
      const clip = document.getElementById('collapsible-viewport')!;
      for (const observer of observers)
        if (observer.targets.has(clip))
          observer.callback([], observer as unknown as ResizeObserver);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(latest()).toBeNull();
    await act(() => render(false));
    expect(latest()).toBeNull();
    expect(requests.some((request) => request.action === 'close')).toBe(false);
    const previousRevision = requests.at(-1)!;
    const boundary = requests.length;
    const nextScope = { ...scope, generation: 2, viewSelection: 3 };
    clipWidth = 200;
    await act(async () => render(true, nextScope));
    const afterScopeChange = requests
      .slice(boundary)
      .filter(
        (request): request is Extract<NativeBrowserRequest, { action: 'present' }> =>
          request.action === 'present',
      );
    // The previous visible owner already hid when render(false) committed.
    // Reactivating an inactive Pane must not revoke its new scope first.
    expect(afterScopeChange).toHaveLength(1);
    expect(afterScopeChange.at(-1)).toMatchObject({
      scope: nextScope,
      bounds: { x: 100, y: 100, width: 200, height: 450, radius: 0 },
    });
    expect(afterScopeChange.at(-1)!.presentationRevision!).toBeGreaterThan(
      previousRevision.action === 'present' ? previousRevision.presentationRevision! : 0,
    );
  } finally {
    releaseHeld?.();
    await act(() => root.unmount());
    restoreLayout();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});

test('measured Native layout follows the production Panel resize policy and refuses unsupported ancestry', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayout = prepareDesktopDom(dom);
  const paints: { fillStyle: string; x: number; width: number; height: number }[] = [];
  const context = {
    fillStyle: '',
    clearRect() {},
    fillRect(x: number, _y: number, width: number, height: number) {
      paints.push({ fillStyle: this.fillStyle, x, width, height });
    },
  };
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
    value: () => context,
  });
  let layoutAck!: (ack: NativeBrowserLayoutFrameAck) => void;
  let frameUnsubscribed = false,
    useFrozenReceipt = false;
  const frozen = {
    key: '00112233445566778899aabbccddeeff',
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgo=',
    width: 1,
    height: 1,
    cssWidth: 449,
    cssHeight: 739,
    rootZoom: 1,
  };
  let receiptFrame = frozen;
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
  let width = 1400,
    height = 839;
  let heldDom: { width: number; height: number } | undefined;
  let heldRootChildren: { width: number; height: number } | undefined;
  let innerInset = 0,
    detailsShift = 0,
    separatorWidth = 1;
  Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => height });
  const observers: LayoutObserver[] = [];
  class LayoutObserver {
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
  Object.assign(window, { ResizeObserver: LayoutObserver });
  Object.assign(globalThis, { ResizeObserver: LayoutObserver });
  // JSDOM has no layout engine. Give the real Panels their CSS flex allocation;
  // all constraint/preserve/collapse decisions still run in the production library.
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  const rect = (element: HTMLElement): DOMRect => {
    if (element.id === 'layout-outer')
      return new dom.window.DOMRect(0, 0, heldDom?.width ?? width, heldDom?.height ?? height);
    if (element.id === 'layout-inner') {
      const box = rect(document.getElementById('workspace')!);
      return new dom.window.DOMRect(box.x + innerInset, box.y, box.width - innerInset, box.height);
    }
    if (element.hasAttribute('data-panel')) {
      const group = element.parentElement!;
      const observed = rect(group);
      const box =
        group.id === 'layout-outer' && heldRootChildren
          ? new dom.window.DOMRect(
              observed.x,
              observed.y,
              heldRootChildren.width,
              heldRootChildren.height,
            )
          : observed;
      const panels = [...group.children].filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.hasAttribute('data-panel'),
      );
      const weights = panels.map((node) => Number(node.style.flexGrow) || 0);
      const sum = weights[0]! + weights[1]!;
      const gap =
        group.querySelector<HTMLElement>(':scope > [data-slot="resizable-handle"]')?.dataset
          .open === 'false'
          ? 0
          : 1;
      const left = ((box.width - gap) * weights[0]!) / sum;
      return element === panels[0]
        ? new dom.window.DOMRect(box.x, 0, left, box.height)
        : new dom.window.DOMRect(
            box.x + left + gap + (element.id === 'details' ? detailsShift : 0),
            0,
            box.width - left - gap,
            box.height,
          );
    }
    if (element.dataset.slot === 'resizable-handle') {
      const group = element.parentElement!;
      const left = group.querySelector<HTMLElement>(':scope > [data-panel]')!;
      return new dom.window.DOMRect(
        rect(left).right,
        0,
        element.dataset.open === 'false' ? 0 : separatorWidth,
        rect(left).height,
      );
    }
    if (element.classList.contains('native-browser-viewport')) {
      const box = rect(document.getElementById('details')!);
      return new dom.window.DOMRect(
        box.x + 0.45,
        92,
        Math.max(0, box.width - 0.7),
        box.height - 152,
      );
    }
    const panel = element.closest<HTMLElement>('[data-panel]');
    if (panel) return rect(panel);
    return originalRect.call(element);
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rect(this);
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return Math.round(rect(this).width);
    },
  });
  const requests: Extract<NativeBrowserRequest, { action: 'present' }>[] = [];
  let syncCommits = 0,
    asyncPositive = 0;
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
      presentBrowserLayout(request: Extract<NativeBrowserRequest, { action: 'present' }>) {
        syncCommits++;
        requests.push(request);
        return useFrozenReceipt
          ? {
              state,
              waiting: true,
              frozenKey: receiptFrame.key,
              frozenWidth: receiptFrame.cssWidth,
              frozenHeight: receiptFrame.cssHeight,
            }
          : null;
      },
      watchBrowserLayoutFrame(listener: typeof layoutAck) {
        layoutAck = listener;
        return () => {
          frameUnsubscribed = true;
        };
      },
      async browserRequest(request: NativeBrowserRequest) {
        if (request.action === 'present') {
          if (request.bounds) asyncPositive++;
          requests.push(request);
        }
        return request.action === 'state' ? state : null;
      },
      watchBrowser() {
        return () => {};
      },
    },
  });
  const detailsRef: Extract<
    NonNullable<ComponentProps<typeof ResizablePanel>['panelRef']>,
    { current: unknown }
  > = { current: null };
  const nav = {
    minSize: '200px',
    maxSize: '420px',
    groupResizeBehavior: 'preserve-pixel-size' as const,
    collapsible: false,
  };
  const workspace = {
    minSize: '200px',
    maxSize: '100%',
    groupResizeBehavior: 'preserve-relative-size' as const,
    collapsible: false,
  };
  const content = { ...workspace, minSize: '360px' };
  const details = { ...workspace, minSize: '240px', maxSize: '85%', collapsible: true };
  const root = createRoot(document.getElementById('root')!);
  const render = (navigationOpen = true, chromeHosted = false) => {
    const navigation = navigationOpen ? nav : { ...nav, minSize: '0px', maxSize: '0px' };
    root.render(
      <ResizablePanelGroup
        id="layout-outer"
        className="client-panels"
        orientation="horizontal"
        defaultLayout={{ navigation: (200 / 1399) * 100, workspace: (1199 / 1399) * 100 }}
      >
        <ResizablePanel
          id="navigation"
          {...navigation}
          data-native-browser-layout={JSON.stringify(navigation)}
        />
        <ResizableHandle disabled={!navigationOpen} data-open={navigationOpen ? 'true' : 'false'} />
        <ResizablePanel
          id="workspace"
          {...workspace}
          data-native-browser-layout={JSON.stringify(workspace)}
        >
          <ResizablePanelGroup
            id="layout-inner"
            className="client-content-panels"
            orientation="horizontal"
            defaultLayout={{ content: (749 / 1198) * 100, details: (449 / 1198) * 100 }}
          >
            <ResizablePanel
              id="content"
              {...content}
              data-native-browser-layout={JSON.stringify(content)}
            />
            <ResizableHandle />
            <ResizablePanel
              id="details"
              {...details}
              panelRef={detailsRef}
              data-native-browser-layout={JSON.stringify(details)}
            >
              <NativeBrowserPane
                id="browser"
                chromeHosted={chromeHosted}
                visible
                tools={null}
                scope={{ storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 }}
                onTitleChange={() => {}}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>,
    );
  };
  const measure = async () => {
    // Native and both actual Group observers see the same real resize, outer
    // first. A second pass delivers the nested Group's changed allocation.
    for (let pass = 0; pass < 2; pass++)
      await act(async () => {
        for (const id of ['layout-outer', 'layout-inner']) {
          const target = document.getElementById(id)!;
          for (const observer of observers)
            if (observer.targets.has(target))
              observer.callback(
                [
                  {
                    target,
                    borderBoxSize: [{ inlineSize: rect(target).width, blockSize: height }],
                  },
                ] as unknown as ResizeObserverEntry[],
                observer as unknown as ResizeObserver,
              );
        }
        await Bun.sleep(40);
      });
    return requests.filter((request) => request.bounds).at(-1)!;
  };
  try {
    await act(async () => render());
    let previous = await measure();
    expect(previous.layout?.groups).toHaveLength(2);
    expect(previous.layout!.groups[0]!.panels[0]!.preserve).toBe('pixel');
    const beforeMetadata = requests.length;
    await act(async () => {
      document.getElementById('navigation')!.dataset.nativeBrowserLayout = JSON.stringify({
        ...nav,
        maxSize: '421px',
      });
      await Bun.sleep(40);
    });
    expect(requests.length).toBe(beforeMetadata + 1);
    expect(requests.at(-1)!.bounds).toEqual(previous.bounds);
    expect(requests.at(-1)!.layout!.groups[0]!.panels[0]!.max).toBe(421);
    await act(async () => {
      document.getElementById('navigation')!.dataset.nativeBrowserLayout = JSON.stringify(nav);
      await Bun.sleep(40);
    });

    // The real Panels first settle at 820; Main then has a 1400 viewport while
    // this renderer still exposes the old 820 DOM. It must not invent a 580px margin.
    width = 820;
    height = 700;
    await measure();
    heldDom = { width, height };
    width = 1400;
    height = 839;
    const beforeMixed = requests.length;
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('resize'));
      await Bun.sleep(80);
    });
    expect(requests.length).toBe(beforeMixed);
    heldDom = undefined;
    heldRootChildren = { width: 820, height: 700 };
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('resize'));
      await Bun.sleep(80);
    });
    // A new full-width Group with old child boxes must not fabricate a 581px gap.
    expect(requests.length).toBe(beforeMixed);
    heldRootChildren = undefined;
    previous = await measure();
    expect(previous.layout!.groups[0]!.right).toBe(0);
    heldDom = { width, height };
    width = 820;
    height = 700;
    const beforeShrinking = requests.length;
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('resize'));
      await Bun.sleep(80);
    });
    // Even when old wide DOM places the viewport beyond the new window edge,
    // its empty clip is pending geometry, not a qualified request to hide Main.
    expect(requests.length).toBe(beforeShrinking);
    heldDom = undefined;
    previous = await measure();
    width = 1400;
    height = 839;
    previous = await measure();
    for (const mismatch of ['inner-group', 'panel-join'] as const) {
      const count = requests.length;
      if (mismatch === 'inner-group') innerInset = 12;
      else detailsShift = 12;
      await act(async () => {
        window.dispatchEvent(new dom.window.Event('resize'));
        await Bun.sleep(80);
      });
      expect(requests.length).toBe(count);
      innerInset = 0;
      detailsShift = 0;
      previous = await measure();
      expect(previous.layout).toBeDefined();
    }
    separatorWidth = 4;
    await measure();
    expect(requests.at(-1)!.bounds).toBeNull();
    separatorWidth = 1;
    previous = await measure();

    // A native resize can cross a min-size constraint before Root supplies a
    // new accepted measurement. The actual Panel library keeps that changed
    // relative allocation when expanding again; one old anchor cannot replay it.
    await act(async () => detailsRef.current!.resize('240px'));
    const nativeAnchor = await measure();
    width = 820;
    const narrowActual = await measure();
    expect(Math.abs(narrowActual.bounds!.width - 240)).toBeLessThan(1.5);
    const narrowPrediction = projectNativeBrowserLayout(
      nativeAnchor.bounds!,
      nativeAnchor.layout!,
      width,
      height,
    )!;
    expect(Math.abs(narrowActual.bounds!.x - narrowPrediction.bounds.x)).toBeLessThan(1.5);
    width = 1800;
    const expandedActual = await measure();
    const withoutHistory = projectNativeBrowserBounds(
      nativeAnchor.bounds!,
      nativeAnchor.layout!,
      width,
      height,
    )!;
    expect(Math.abs(expandedActual.bounds!.x - withoutHistory.x)).toBeGreaterThan(200);
    const expandedPrediction = projectNativeBrowserLayout(
      narrowPrediction.bounds,
      narrowPrediction.layout,
      width,
      height,
    )!;
    expect(Math.abs(expandedActual.bounds!.x - expandedPrediction.bounds.x)).toBeLessThan(1.5);
    expect(Math.abs(expandedActual.bounds!.width - expandedPrediction.bounds.width)).toBeLessThan(
      1.5,
    );
    previous = expandedActual;

    for (const nextWidth of [1100, 800, 1800, 1400]) {
      const predicted = projectNativeBrowserBounds(
        previous.bounds!,
        previous.layout!,
        nextWidth,
        height,
      )!;
      width = nextWidth;
      const actual = await measure();
      expect(actual.layout).toBeDefined();
      expect(Math.abs(actual.bounds!.x - predicted.x)).toBeLessThan(1.5);
      expect(Math.abs(actual.bounds!.width - predicted.width)).toBeLessThan(1.5);
      expect(Math.abs(rect(document.getElementById('navigation')!).width - 200)).toBeLessThan(1.5);
      previous = actual;
    }
    await act(async () => detailsRef.current!.resize('85%'));
    previous = await measure();
    expect(previous.layout!.groups[1]!.panels[0]!.size).toBeGreaterThanOrEqual(359);
    const predicted = projectNativeBrowserBounds(previous.bounds!, previous.layout!, 1100, height)!;
    width = 1100;
    const maxBound = await measure();
    expect(Math.abs(maxBound.bounds!.x - predicted.x)).toBeLessThan(1.5);
    expect(Math.abs(maxBound.bounds!.width - predicted.width)).toBeLessThan(1.5);
    await act(async () => detailsRef.current!.collapse());
    await measure();
    expect(requests.at(-1)!.bounds).toBeNull();
    await act(async () => {
      detailsRef.current!.expand();
      render(false);
    });
    previous = await measure();
    expect(previous.layout!.groups[0]!.panels[0]!.size).toBe(0);
    expect(previous.layout!.groups[0]!.gap).toBe(0);
    const closedPrediction = projectNativeBrowserBounds(
      previous.bounds!,
      previous.layout!,
      1400,
      height,
    )!;
    width = 1400;
    const closedNav = await measure();
    expect(Math.abs(closedNav.bounds!.x - closedPrediction.x)).toBeLessThan(1.5);
    // A cache receipt is preloaded while hidden. Only a subsequent resize may
    // display it, before the first Root paint, beneath the live Native overlap.
    expect(closedNav.witness?.step).toBe(1);
    const ack = {
      id: 'browser',
      scope: closedNav.scope!,
      presentationRevision: closedNav.presentationRevision!,
      key: closedNav.witness!.key,
      step: 0 as const,
      frozen,
    };
    await act(async () => {
      layoutAck(ack);
    });
    const image = document.querySelector<HTMLImageElement>('.native-browser-viewport img')!;
    expect(image.hidden).toBe(true);
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${frozen.data}`);
    useFrozenReceipt = true;
    width = 1410;
    const resizing = await measure();
    expect(image.hidden).toBe(false);
    expect(image.style.width).toBe('449px');
    expect(image.style.height).toBe('739px');
    const beforeAck = requests.length;
    await act(async () => {
      layoutAck({ ...ack, step: 1 }); // old geometry key
      layoutAck({
        ...ack,
        key: resizing.witness!.key,
        step: 1,
        scope: { ...ack.scope, viewSelection: 999 },
      });
    });
    expect(requests.length).toBe(beforeAck);
    const currentAck = { ...ack, key: resizing.witness!.key, step: 1 as const };
    await act(async () => {
      layoutAck(currentAck);
    });
    expect(requests.length).toBe(beforeAck + 1);
    expect(requests.at(-1)).toMatchObject({
      bounds: resizing.bounds,
      witness: { key: resizing.witness!.key, step: 2 },
    });
    expect(paints.slice(-40).map((paint) => paint.fillStyle)).toEqual(
      nativeBrowserWitnessColors({ ...resizing.witness!, step: 2 }).map(
        (color) => `rgb(${color.join(',')})`,
      ),
    );
    await act(async () => {
      layoutAck({ ...currentAck, step: 2 });
    });
    expect(image.hidden).toBe(false);
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${frozen.data}`);
    // Main may withdraw the Native sibling before the next Root resize event.
    // The previously painted image remains underneath it after the ACK.
    const newer = { ...frozen, key: 'new-current-page-image', data: `${frozen.data}AA` };
    await act(async () => {
      layoutAck({ ...currentAck, step: 0, frozen: newer });
    });
    expect(image.hidden).toBe(false);
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${newer.data}`);
    await act(async () => {
      layoutAck({ ...ack, step: 0, frozen }); // late old layout cannot replace it
    });
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${newer.data}`);
    receiptFrame = { ...frozen, key: 'awaited-current-frame', data: `${frozen.data}BB` };
    width = 1420;
    const delayed = await measure();
    expect(image.hidden).toBe(true); // old pixels cannot fill an uncached receipt
    await act(async () => {
      layoutAck({ ...ack, step: 0, frozen });
    });
    expect(image.hidden).toBe(true);
    await act(async () => {
      layoutAck({ ...ack, key: delayed.witness!.key, step: 0, frozen: receiptFrame });
    });
    expect(image.hidden).toBe(false);
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${receiptFrame.data}`);
    // Native-owned presentation must retire the old PNG without withdrawing
    // the original page or restarting its measurement/observation effect.
    const withdrawals = requests.filter((request) => !request.bounds).length;
    await act(async () => render(false, true));
    expect(image.hidden).toBe(true);
    expect(image.hasAttribute('src')).toBe(false);
    expect(requests.filter((request) => !request.bounds)).toHaveLength(withdrawals);
    await act(async () => {
      layoutAck({ ...ack, key: delayed.witness!.key, step: 0, frozen: receiptFrame });
    });
    expect(image.hidden).toBe(true);
    expect(image.hasAttribute('src')).toBe(false);
    // A truly unsupported Group withdraws presentation; it cannot downgrade to raw bounds.
    await act(async () => {
      document.getElementById('layout-inner')!.style.flexDirection = 'column';
      window.dispatchEvent(new dom.window.Event('resize'));
      await Bun.sleep(40);
    });
    expect(requests.at(-1)!.bounds).toBeNull();
    expect(requests.at(-1)!.layout).toBeUndefined();
    expect(image.hidden).toBe(true);
    expect(image.hasAttribute('src')).toBe(false);
    expect(syncCommits).toBeGreaterThan(5);
    expect(asyncPositive).toBe(0);
  } finally {
    await act(() => root.unmount());
    expect(frameUnsubscribed).toBe(true);
    restoreLayout();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});

type MeasuredPresent = Extract<NativeBrowserRequest, { action: 'present' }>;
type LayoutReply =
  | NativeBrowserState
  | import('../../src/native-browser-bridge').NativeBrowserLayoutReceipt
  | null;

function measuredLayoutPortFixture(asyncPort = true, initialBlank = false, recoveryPort = false) {
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
  let width = 1400,
    height = 800,
    fraction = 0.6,
    unmounted = false;
  Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => height });
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const left = Math.round((width - 1) * fraction);
    if (this.id === 'port-group') return new dom.window.DOMRect(0, 0, width, height);
    if (this.id === 'port-content') return new dom.window.DOMRect(0, 0, left, height);
    if (this.id === 'port-handle') return new dom.window.DOMRect(left, 0, 1, height);
    if (this.id === 'port-details')
      return new dom.window.DOMRect(left + 1, 0, width - left - 1, height);
    if (this.classList.contains('native-browser-viewport'))
      return new dom.window.DOMRect(left + 1, 74, width - left - 1, height - 74);
    return originalRect.call(this);
  };
  const observers: LayoutObserver[] = [];
  class LayoutObserver {
    targets = new Set<Element>();
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  Object.assign(window, { ResizeObserver: LayoutObserver });
  Object.assign(globalThis, { ResizeObserver: LayoutObserver });
  let state: NativeBrowserState = {
    id: 'browser',
    url: initialBlank ? '' : 'https://example.test/original',
    title: 'Original page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  let notify: ((page: NativeBrowserState) => void) | undefined;
  let frameAck: ((ack: NativeBrowserLayoutFrameAck) => void) | undefined;
  let observe: ((request: NativeBrowserPresentationRequest) => void) | undefined;
  let waiting = true;
  let syncReply: ((input: MeasuredPresent) => LayoutReply) | undefined;
  const requests: NativeBrowserRequest[] = [];
  const cleared: number[][] = [];
  if (initialBlank)
    dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
      fillStyle: '',
      fillRect() {},
      clearRect(...rect: number[]) {
        cleared.push(rect);
      },
    })) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  const events: { port: 'sync' | 'async' | 'legacy'; input: MeasuredPresent }[] = [];
  const pending: {
    input: MeasuredPresent;
    resolve(reply?: LayoutReply): void;
    reject(error?: Error): void;
  }[] = [];
  Object.assign(window, {
    kiteNative: {
      ...(recoveryPort
        ? {
            watchBrowserPresentation(receive: (request: NativeBrowserPresentationRequest) => void) {
              observe = receive;
              return () => {
                observe = undefined;
              };
            },
          }
        : {}),
      presentBrowserLayout(input: MeasuredPresent) {
        events.push({ port: 'sync', input });
        if (syncReply) return syncReply(input);
        return initialBlank ? { state, waiting } : null;
      },
      ...(asyncPort
        ? {
            presentBrowserLayoutAsync(input: MeasuredPresent) {
              events.push({ port: 'async', input });
              return new Promise<LayoutReply>((resolve, reject) => {
                pending.push({
                  input,
                  resolve: (reply = null) => resolve(reply),
                  reject: (error = Error('browser_layout_failed')) => reject(error),
                });
              });
            },
          }
        : {}),
      async browserRequest(input: NativeBrowserRequest) {
        requests.push(input);
        if (input.action === 'present') events.push({ port: 'legacy', input });
        if (input.action === 'navigate') {
          state = { ...state, url: input.input, loading: true, error: undefined };
          notify?.(state);
          return state;
        }
        if (input.action === 'stop') {
          state = { ...state, loading: false };
          notify?.(state);
          return state;
        }
        return input.action === 'state' ? state : null;
      },
      watchBrowser(receive: (page: NativeBrowserState) => void) {
        notify = receive;
        return () => {
          notify = undefined;
        };
      },
      ...(initialBlank
        ? {
            watchBrowserLayoutFrame(receive: (ack: NativeBrowserLayoutFrameAck) => void) {
              frameAck = receive;
              return () => {
                frameAck = undefined;
              };
            },
          }
        : {}),
    },
  });
  const root = createRoot(document.getElementById('root')!);
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const policy = JSON.stringify({
    minSize: '200px',
    maxSize: '100%',
    groupResizeBehavior: 'preserve-relative-size',
    collapsible: false,
  });
  const flush = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(40);
    });
  const unmount = () =>
    flush(() => {
      if (!unmounted) root.unmount();
      unmounted = true;
    });
  return {
    events,
    pending,
    requests,
    cleared,
    document: dom.window.document,
    scope,
    flush,
    set waiting(value: boolean) {
      waiting = value;
    },
    set syncReply(value: (input: MeasuredPresent) => LayoutReply) {
      syncReply = value;
    },
    get frameAck() {
      return frameAck!;
    },
    get observe() {
      return observe!;
    },
    updatePage(patch: Partial<NativeBrowserState>) {
      return flush(() => {
        state = { ...state, ...patch };
        notify?.(state);
      });
    },
    navigate(url: string) {
      return flush(() => {
        const address = document.querySelector<HTMLInputElement>('.native-browser-address')!;
        address.focus();
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
          address,
          url,
        );
        address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        address
          .closest('form')!
          .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });
    },
    stop() {
      return flush(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="停止加载"]')!.click(),
      );
    },
    ack(input: MeasuredPresent, patch: Partial<NativeBrowserLayoutFrameAck> = {}) {
      return flush(() =>
        frameAck?.({
          id: input.id,
          scope: input.scope!,
          ...(input.draft ? { draft: input.draft } : {}),
          presentationRevision: input.presentationRevision!,
          key: input.witness!.key,
          step: 2,
          ...patch,
        }),
      );
    },
    positive(port: 'sync' | 'async' | 'legacy') {
      return events.filter((event) => event.port === port && event.input.bounds);
    },
    render(
      chromeHosted = true,
      currentScope: NativeBrowserRestoreScope | null = scope,
      draft?: string,
      visible = true,
      initialHint?: NativeBrowserState,
    ) {
      return flush(() =>
        root.render(
          <div
            id="port-group"
            className="client-panels"
            data-slot="resizable-panel-group"
            style={{ display: 'flex', flexDirection: 'row' }}
          >
            <div id="port-content" data-panel data-native-browser-layout={policy} />
            <div id="port-handle" data-slot="resizable-handle" />
            <div id="port-details" data-panel data-native-browser-layout={policy}>
              <NativeBrowserPane
                id="browser"
                visible={visible}
                chromeHosted={chromeHosted}
                tools={null}
                scope={currentScope ?? undefined}
                draft={draft}
                initialHint={initialHint}
                onTitleChange={() => {}}
              />
            </div>
          </div>,
        ),
      );
    },
    resize(nextWidth: number, nextHeight = height) {
      return flush(() => {
        width = nextWidth;
        height = nextHeight;
        window.dispatchEvent(new dom.window.Event('resize'));
      });
    },
    setGeometry(nextWidth: number, nextHeight = height) {
      width = nextWidth;
      height = nextHeight;
    },
    split(nextFraction: number) {
      return flush(() => {
        fraction = nextFraction;
        const details = document.getElementById('port-details')!;
        for (const observer of observers)
          if (observer.targets.has(details))
            observer.callback([], observer as unknown as ResizeObserver);
      });
    },
    unmount,
    async close() {
      await unmount();
      await flush(() => {
        for (const item of pending) item.resolve();
      });
      restoreLayout();
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}

test('a retained page uses accurate restoration metadata without showing new-tab tools or bypassing adoption', async () => {
  const f = measuredLayoutPortFixture(false, true),
    draft = '00112233445566778899aabbccddeeff',
    hint: NativeBrowserState = {
      id: 'browser',
      title: 'Retained',
      url: 'https://example.test/retained',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
  try {
    await f.updatePage(hint);
    await f.render(false, null, draft, true, hint);
    const viewport = f.document.querySelector('.native-browser-viewport'),
      first = f.positive('sync').at(-1)!.input;
    expect(f.document.querySelector('[role="status"][aria-label="网页加载中"]')).not.toBeNull();
    expect(f.document.body.textContent).not.toContain('正在显示原网页');
    expect(f.document.querySelector<HTMLInputElement>('.native-browser-address')!.value).toBe(
      hint.url,
    );
    expect(
      f.requests.some((request) => request.action === 'navigate' || request.action === 'grant'),
    ).toBe(false);
    await f.ack(first, { step: 1 });
    const second = f.positive('sync').at(-1)!.input;
    await f.ack(second, { presented: false });
    expect(!!f.document.querySelector('.native-browser-start')).toBe(true);
    await f.ack(second, { presented: true });
    expect(f.document.querySelector('.native-browser-start')).toBeNull();
    expect(f.document.querySelector('.native-browser-viewport') === viewport).toBe(true);
  } finally {
    await f.close();
  }
});

for (const kind of ['session', 'draft'] as const)
  for (const sequence of [
    'missing-visibility',
    'hidden-delivery',
    'old-owner',
    'late-calibration',
  ] as const) {
    test(`Main reconciliation converges ${kind}/${sequence} without replaying page actions`, async () => {
      const f = measuredLayoutPortFixture(true, true, true),
        draft = kind === 'draft' ? '00112233445566778899aabbccddeeff' : undefined,
        hint: NativeBrowserState = {
          id: 'browser',
          url: 'https://example.test/original',
          title: 'Original',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        };
      const signal: NativeBrowserPresentationRequest = {
        id: 'browser',
        key: '112233445566778899aabbccddeeff00',
        ...(draft ? { draft } : { scope: f.scope }),
      };
      const settle = async () => {
        await f.ack(f.positive('sync').at(-1)!.input, { step: 1 });
        await f.ack(f.positive('sync').at(-1)!.input, { presented: true });
      };
      try {
        await f.updatePage(hint);
        await f.render(true, draft ? null : f.scope, draft, true, hint);
        await settle();
        const originalViewport = f.document.querySelector('.native-browser-viewport'),
          oldAck = f.frameAck,
          oldInput = f.positive('sync').at(-1)!.input,
          oldObserver = f.observe;
        let count = f.positive('sync').length;
        if (sequence === 'old-owner') {
          const replacement = draft ? 'ffeeddccbbaa99887766554433221100' : undefined,
            scope = { ...f.scope, generation: 2, viewSelection: 2 };
          await f.render(true, replacement ? null : scope, replacement, true, hint);
          count = f.positive('sync').length;
          await f.flush(() => {
            oldObserver(signal);
            f.observe(signal);
          });
          expect(f.positive('sync')).toHaveLength(count);
          await f.flush(() =>
            f.observe({ ...signal, ...(replacement ? { draft: replacement } : { scope }) }),
          );
        } else if (sequence === 'hidden-delivery') {
          Object.defineProperty(f.document, 'hidden', { configurable: true, value: true });
          await f.flush(() => {
            f.observe(signal);
            f.observe(signal);
          });
          expect(f.positive('sync')).toHaveLength(count);
          await f.flush(() => {
            Object.defineProperty(f.document, 'hidden', { configurable: true, value: false });
            f.document.dispatchEvent(new Event('visibilitychange'));
          });
        } else {
          if (sequence === 'late-calibration') await f.resize(1200);
          // Main's native lifecycle notification works even when no DOM
          // visibilitychange was delivered to this still-mounted component.
          await f.flush(() => f.observe(signal));
          const after = f.positive('sync').length;
          await f.flush(() => {
            f.observe(signal);
            f.observe(signal);
          });
          expect(f.positive('sync')).toHaveLength(after);
          if (sequence === 'late-calibration')
            await f.flush(() => f.pending[0]!.resolve({ state: hint, waiting: false }));
        }
        expect(f.positive('sync').length).toBeGreaterThan(count);
        expect(f.positive('sync').at(-1)!.input.presentationRevision!).toBeGreaterThan(
          oldInput.presentationRevision!,
        );
        await f.flush(() =>
          oldAck({
            id: oldInput.id,
            scope: oldInput.scope,
            draft: oldInput.draft,
            presentationRevision: oldInput.presentationRevision!,
            key: oldInput.witness!.key,
            step: 2,
            presented: true,
          }),
        );
        expect(f.document.querySelector('.native-browser-start')).not.toBeNull();
        await settle();
        expect(f.document.querySelector('.native-browser-start')).toBeNull();
        expect(f.document.querySelector('.native-browser-viewport')).toBe(originalViewport);
        expect(
          f.requests.some((r) => ['navigate', 'reload', 'grant', 'close'].includes(r.action)),
        ).toBe(false);
        const receiver = f.observe;
        await f.unmount();
        const retired = f.positive('sync').length;
        await f.flush(() => receiver({ ...signal, key: '00ffeeddccbbaa998877665544332211' }));
        expect(f.positive('sync')).toHaveLength(retired);
      } finally {
        await f.close();
      }
    });
  }

for (const kind of ['session', 'draft'] as const) {
  test(`window visibility resumes the exact ${kind} page through fresh bootstrap, fencing hidden-frame work and late calibration`, async () => {
    const f = measuredLayoutPortFixture(true, true),
      draft = kind === 'draft' ? '00112233445566778899aabbccddeeff' : undefined,
      hint: NativeBrowserState = {
        id: 'browser',
        url: 'https://example.test/original',
        title: 'Original page',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
    const raf = globalThis.requestAnimationFrame,
      cancel = globalThis.cancelAnimationFrame;
    const paused = new Map<number, FrameRequestCallback>();
    let next = -1;
    globalThis.requestAnimationFrame = (callback) => {
      if (!f.document.hidden) return raf(callback);
      const id = next--;
      paused.set(id, callback);
      return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
      if (id < 0) paused.delete(id);
      else cancel(id);
    };
    const visibility = (hidden: boolean) =>
      f.flush(() => {
        Object.defineProperty(f.document, 'hidden', { configurable: true, value: hidden });
        f.document.dispatchEvent(new Event('visibilitychange'));
      });
    try {
      await f.updatePage(hint);
      await f.render(true, draft ? null : f.scope, draft);
      await f.ack(f.positive('sync').at(-1)!.input, { step: 1 });
      const adopted = f.positive('sync').at(-1)!.input,
        oldAck = f.frameAck;
      await f.ack(adopted, { presented: true });
      expect(f.document.querySelector('.native-browser-start')).toBeNull();
      await f.resize(1200);
      const calibration = f.pending[0]!;
      expect(calibration).toBeDefined();
      const syncCount = f.positive('sync').length;
      await visibility(true);
      expect(paused.size).toBeGreaterThan(0);
      await visibility(false);
      expect(paused.size).toBe(0);
      expect(f.positive('sync').length).toBeGreaterThan(syncCount);
      const fresh = f.positive('sync').at(-1)!.input;
      expect(fresh.presentationRevision! > adopted.presentationRevision!).toBe(true);
      expect(fresh.witness!.key).not.toBe(adopted.witness!.key);
      await f.flush(() => {
        calibration.resolve({ state: hint, waiting: false });
        oldAck({
          id: adopted.id,
          scope: adopted.scope,
          draft: adopted.draft,
          presentationRevision: adopted.presentationRevision!,
          key: adopted.witness!.key,
          step: 2,
          presented: true,
        });
      });
      expect(f.document.querySelector('.native-browser-start')).not.toBeNull();
      expect(f.document.querySelector('[role="status"][aria-label="网页加载中"]')).not.toBeNull();
      await f.ack(fresh, { step: 1 });
      await f.ack(f.positive('sync').at(-1)!.input, { presented: true });
      expect(f.document.querySelector('.native-browser-start')).toBeNull();
      expect(
        f.requests.some((request) =>
          ['navigate', 'reload', 'grant', 'close'].includes(request.action),
        ),
      ).toBe(false);
      await f.resize(1300);
      expect(f.positive('async')).toHaveLength(2);
    } finally {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = cancel;
      await f.close();
    }
  });
}

test('a new draft page navigates without Session scope and adopts only its current draft proof before async resize', async () => {
  const f = measuredLayoutPortFixture(true, true),
    draft = '00112233445566778899aabbccddeeff';
  try {
    await f.render(false, null, draft);
    await f.navigate('https://www.baidu.com/');
    expect(f.requests.find((request) => request.action === 'navigate')).toMatchObject({ draft });
    expect(
      f.requests.every(
        (request) => !('scope' in request) && 'draft' in request && request.draft === draft,
      ),
    ).toBe(true);
    const first = f.positive('sync').at(-1)!.input,
      source = f.document.querySelector('.native-browser-start');
    expect(first.draft).toBe(draft);
    expect(first.scope).toBeUndefined();
    await f.ack(first, { draft: 'ffeeddccbbaa99887766554433221100', presented: true });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    await f.ack(first);
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    await f.ack(first, { step: 1 });
    const second = f.positive('sync').at(-1)!.input;
    await f.ack(second, { presented: false });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    await f.ack(second, { presented: true });
    expect(f.document.querySelector('.native-browser-start')).toBeNull();
    expect(
      f.document.querySelector<HTMLElement>('.native-browser-toolbar')?.style.visibility,
    ).not.toBe('hidden');
    const syncCount = f.positive('sync').length;
    await f.resize(1200);
    expect(f.positive('sync')).toHaveLength(syncCount);
    expect(f.positive('async')).toHaveLength(1);
    expect(f.pending[0]!.input.draft).toBe(draft);
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
    expect(f.requests.some((request) => request.action === 'grant')).toBe(false);
    await f.unmount();
    expect(
      f.requests.some(
        (request) => request.action === 'present' && !request.bounds && request.draft === draft,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('a draft display revision survives a new document counter and rejects the old confirmation', async () => {
  const f = measuredLayoutPortFixture(false, true),
    draft = '00112233445566778899aabbccddeeff';
  try {
    await f.render(false, null, draft);
    await f.navigate('https://www.baidu.com/');
    const old = f.positive('sync').at(-1)!.input;
    await f.render(false, null, draft, false);
    Reflect.deleteProperty(f.document, Symbol.for('kite.native.browser.presentationRevision'));
    await f.render(false, null, draft);
    const current = f.positive('sync').at(-1)!.input;
    expect(current.presentationRevision! > old.presentationRevision!).toBe(true);
    expect(window.sessionStorage.getItem(`kite.browserDraftRevision:${draft}`)).toBe(
      String(current.presentationRevision),
    );
    await f.ack(old, { presented: true });
    expect(!!f.document.querySelector('.native-browser-start')).toBe(true);
    await f.ack(current, { presented: true });
    expect(f.document.querySelector('.native-browser-start')).toBeNull();
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a late navigation reply from an old draft cannot overwrite the replacement address', async () => {
  const f = measuredLayoutPortFixture(false, true),
    draft = '00112233445566778899aabbccddeeff',
    replacement = 'ffeeddccbbaa99887766554433221100',
    host = window.kiteNative!,
    original = host.browserRequest!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(host, 'browserRequest', {
    value: async (input: NativeBrowserRequest) => {
      const result = await original(input);
      if (input.action === 'navigate') await gate;
      return result;
    },
  });
  try {
    await f.render(false, null, draft);
    await f.navigate('https://www.baidu.com/');
    await f.render(false, null, replacement);
    await f.updatePage({ url: 'https://example.test/replacement', title: 'Replacement page' });
    await f.flush(() => release());
    expect(f.document.querySelector<HTMLInputElement>('.native-browser-address')!.value).toBe(
      'https://example.test/replacement',
    );
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
});

test('draft replacement retires the old display owner and its late confirmation cannot clear the new source', async () => {
  const f = measuredLayoutPortFixture(false, true),
    draft = '00112233445566778899aabbccddeeff',
    replacement = 'ffeeddccbbaa99887766554433221100';
  try {
    await f.render(false, null, draft);
    await f.navigate('https://www.baidu.com/');
    const old = f.positive('sync').at(-1)!.input,
      oldCallback = f.frameAck;
    await f.render(false, null, replacement);
    const current = f.positive('sync').at(-1)!.input;
    expect(current.draft).toBe(replacement);
    expect(current.presentationRevision! > old.presentationRevision!).toBe(true);
    await f.flush(() =>
      oldCallback({
        id: old.id,
        draft,
        presentationRevision: old.presentationRevision!,
        key: old.witness!.key,
        step: 2,
        presented: true,
      }),
    );
    await f.ack(old, { presented: true });
    expect(!!f.document.querySelector('.native-browser-start')).toBe(true);
    expect(
      f.requests.some(
        (request) => request.action === 'present' && !request.bounds && request.draft === draft,
      ),
    ).toBe(true);
    await f.ack(current, { presented: true });
    expect(f.document.querySelector('.native-browser-start')).toBeNull();
  } finally {
    await f.close();
  }
});

for (const owner of ['session', 'draft'] as const)
  test(`Main reobserves a rejected ${owner} preflight without withdrawing its newly prepared native cover`, async () => {
    const f = measuredLayoutPortFixture(false, true, true);
    const present = window.kiteNative!.presentBrowserLayout;
    const draft = owner === 'draft' ? '00112233445566778899aabbccddeeff' : undefined;
    let reject = true;
    try {
      await f.render(false, draft ? null : f.scope, draft);
      Object.assign(window.kiteNative!, {
        presentBrowserLayout(input: MeasuredPresent) {
          if (reject) {
            f.events.push({ port: 'sync', input });
            throw Error('browser_presentation_unavailable');
          }
          return present!(input);
        },
      });
      await f.navigate('https://example.test/preflight');
      const old = f.positive('sync').at(-1)!.input;
      const start = f.events.length;
      expect(f.document.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
      expect(f.cleared.length).toBeGreaterThan(0);
      const signal: NativeBrowserPresentationRequest = {
        id: 'browser',
        key: '112233445566778899aabbccddeeff00',
        ...(draft ? { draft } : { scope: f.scope }),
      };
      reject = false;
      await f.flush(() => f.observe(signal));
      const fresh = f.positive('sync').at(-1)!.input;
      expect(fresh.presentationRevision!).toBeGreaterThan(old.presentationRevision!);
      expect(fresh.witness!.key).not.toBe(old.witness!.key);
      expect(f.events.slice(start)).toHaveLength(1);
      expect(f.events[start]).toMatchObject({ port: 'sync', input: fresh });
      expect(f.events.slice(start).some(({ input }) => !input.bounds)).toBe(false);
      const count = f.events.length;
      await f.flush(async () => {
        f.observe(signal);
        f.observe(signal);
        await Bun.sleep(80);
      });
      expect(f.events).toHaveLength(count);
      await f.ack(fresh, { step: 1 });
      await f.ack(f.positive('sync').at(-1)!.input, { presented: true });
      expect(f.document.querySelector('.native-browser-start')).toBeNull();
      expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
      expect(
        f.requests.some((request) => ['reload', 'grant', 'close'].includes(request.action)),
      ).toBe(false);
    } finally {
      Object.assign(window.kiteNative!, { presentBrowserLayout: present });
      await f.close();
    }
  });

for (const boundary of ['hide', 'scope', 'unmount', 'error'] as const)
  test(`a Main preflight reobservation still withdraws on a genuine ${boundary}`, async () => {
    const f = measuredLayoutPortFixture(false, true, true);
    const present = window.kiteNative!.presentBrowserLayout;
    let reject = true;
    try {
      await f.render(false);
      Object.assign(window.kiteNative!, {
        presentBrowserLayout(input: MeasuredPresent) {
          if (reject) throw Error('browser_presentation_unavailable');
          return present!(input);
        },
      });
      await f.navigate('https://example.test/preflight');
      reject = false;
      const signal: NativeBrowserPresentationRequest = {
        id: 'browser',
        key: '112233445566778899aabbccddeeff00',
        scope: f.scope,
      };
      await f.flush(() => f.observe(signal));
      const current = f.positive('sync').at(-1)!.input;
      const receiver = f.observe;
      const before = f.requests.length;
      if (boundary === 'hide') await f.render(false, f.scope, undefined, false);
      if (boundary === 'scope') await f.render(false, { ...f.scope, viewSelection: 2 });
      if (boundary === 'unmount') await f.unmount();
      if (boundary === 'error') await f.updatePage({ error: 'process_gone' });
      expect(
        f.requests
          .slice(before)
          .some(
            (request) =>
              request.action === 'present' &&
              request.bounds === null &&
              request.presentationRevision === current.presentationRevision,
          ),
      ).toBe(true);
      const count = f.positive('sync').length;
      await f.flush(() => receiver({ ...signal, key: '00ffeeddccbbaa998877665544332211' }));
      expect(f.positive('sync')).toHaveLength(count);
      expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
      expect(
        f.requests.some((request) => ['reload', 'grant', 'close'].includes(request.action)),
      ).toBe(false);
    } finally {
      Object.assign(window.kiteNative!, { presentBrowserLayout: present });
      await f.close();
    }
  });

for (const boundary of ['hidden', 'inert', 'overlay', 'zero'] as const)
  test(`a Main prepared handoff cannot retain a rejected proof behind a ${boundary} DOM measurement`, async () => {
    const f = measuredLayoutPortFixture(false, true, true);
    const present = window.kiteNative!.presentBrowserLayout;
    const rejected: MeasuredPresent[] = [];
    try {
      await f.render(false);
      Object.assign(window.kiteNative!, {
        presentBrowserLayout(input: MeasuredPresent) {
          rejected.push(input);
          throw Error('browser_presentation_unavailable');
        },
      });
      await f.navigate('https://example.test/preflight');
      const old = rejected.at(-1)!;
      Object.assign(window.kiteNative!, { presentBrowserLayout: present });
      const before = f.requests.length;
      const positives = f.positive('sync').length;
      await f.flush(() => {
        const details = f.document.getElementById('port-details')!;
        if (boundary === 'hidden') details.hidden = true;
        if (boundary === 'inert') details.setAttribute('inert', '');
        if (boundary === 'zero')
          f.document.querySelector<HTMLElement>('.native-browser-viewport')!.getBoundingClientRect =
            () => new window.DOMRect(0, 0, 0, 0);
        if (boundary === 'overlay') {
          const overlay = f.document.createElement('div');
          overlay.setAttribute('data-native-browser-overlay', '');
          overlay.getBoundingClientRect = () => new window.DOMRect(0, 0, 1400, 800);
          f.document.body.append(overlay);
        }
        f.observe({
          id: 'browser',
          key: '112233445566778899aabbccddeeff00',
          scope: f.scope,
        });
      });
      expect(
        f.requests
          .slice(before)
          .some(
            (request) =>
              request.action === 'present' &&
              request.bounds === null &&
              request.presentationRevision === old.presentationRevision,
          ),
      ).toBe(true);
      expect(f.positive('sync')).toHaveLength(positives);
      expect(f.document.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
      expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
    } finally {
      Object.assign(window.kiteNative!, { presentBrowserLayout: present });
      await f.close();
    }
  });

test('a Main prepared handoff withdraws before reporting an old frame unsubscribe failure', async () => {
  const order: string[] = [];
  const f = measuredLayoutPortFixture(false, true, true);
  const host = window.kiteNative!;
  const present = host.presentBrowserLayout;
  const watch = host.watchBrowserLayoutFrame!;
  const request = host.browserRequest!;
  const failure = Error('old frame unsubscribe failed');
  let failCleanup = false;
  try {
    Object.assign(host, {
      watchBrowserLayoutFrame(receive: Parameters<typeof watch>[0]) {
        const unwatch = watch(receive);
        return () => {
          unwatch();
          if (failCleanup) {
            failCleanup = false;
            throw failure;
          }
        };
      },
      presentBrowserLayout() {
        throw Error('browser_presentation_unavailable');
      },
      browserRequest(input: NativeBrowserRequest) {
        if (input.action === 'present' && input.bounds === null) order.push('withdraw');
        return request(input);
      },
    });
    await f.render(false);
    await f.navigate('https://example.test/preflight');
    order.length = 0;
    failCleanup = true;
    Object.assign(host, { presentBrowserLayout: present });
    let reported: unknown;
    try {
      await f.flush(() =>
        f.observe({
          id: 'browser',
          key: '112233445566778899aabbccddeeff00',
          scope: f.scope,
        }),
      );
    } catch (cause) {
      order.push('error');
      reported = cause;
    }
    expect(reported).toBe(failure);
    expect(order.indexOf('withdraw')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('withdraw')).toBeLessThan(order.indexOf('error'));
    expect(f.frameAck).toBeUndefined();
    expect(f.document.querySelector('.native-browser-viewport')).toBeNull();
    expect(f.requests.filter((input) => input.action === 'navigate')).toHaveLength(1);
  } finally {
    Object.assign(host, {
      presentBrowserLayout: present,
      watchBrowserLayoutFrame: watch,
      browserRequest: request,
    });
    await f.close();
  }
});

test('a rejected initial presentation clears its proof pixels while keeping normal loading for a fresh retry', async () => {
  const f = measuredLayoutPortFixture(false, true);
  const present = window.kiteNative!.presentBrowserLayout;
  let rejected = 0;
  try {
    await f.render(false);
    Object.assign(window.kiteNative!, {
      presentBrowserLayout() {
        rejected++;
        throw Error('browser_page_scope_denied');
      },
    });
    await f.navigate('https://example.test/first');
    expect(f.document.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
    expect(f.cleared.length).toBeGreaterThan(0);
    expect(f.document.querySelector('[aria-label="网页加载中"]')).not.toBeNull();
    const attempts = rejected;
    await f.flush(() => Bun.sleep(80));
    expect(rejected).toBe(attempts);
    Object.assign(window.kiteNative!, { presentBrowserLayout: present });
    await f.resize(1200);
    const first = f.positive('sync').at(-1)!.input;
    await f.ack(first, { step: 1 });
    await f.ack(f.positive('sync').at(-1)!.input, { presented: true });
    expect(f.document.querySelector('[aria-label="网页加载中"]')).toBeNull();
    expect(f.document.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
    expect(f.requests.some((request) => ['reload', 'grant'].includes(request.action))).toBe(false);
  } finally {
    Object.assign(window.kiteNative!, { presentBrowserLayout: present });
    await f.close();
  }
});

for (const owner of ['session', 'draft'] as const)
  test(`a rejected ${owner} draw accepts only its exact late error and never a success receipt`, async () => {
    const f = measuredLayoutPortFixture(false, true);
    const present = window.kiteNative!.presentBrowserLayout;
    const rejected: MeasuredPresent[] = [];
    const draft = owner === 'draft' ? '00112233445566778899aabbccddeeff' : undefined;
    try {
      await f.render(false, draft ? null : f.scope, draft);
      const source = f.document.querySelector('.native-browser-start');
      Object.assign(window.kiteNative!, {
        presentBrowserLayout(input: MeasuredPresent) {
          rejected.push(input);
          throw Error('browser_presentation_unavailable');
        },
      });
      await f.navigate('https://example.test/rejected');
      const first = rejected.at(-1)!;
      expect(first.witness?.step).toBe(1);
      const error = { presented: false, error: 'browser_presentation_unavailable' } as const;
      const issue = () => f.document.querySelector('[aria-label="页面状态与选项"]');
      expect(issue()).toBeNull();
      for (const patch of [
        { id: 'other-page' },
        { key: 'f'.repeat(24) },
        { presentationRevision: first.presentationRevision! + 1 },
        draft
          ? { draft: 'f'.repeat(32) }
          : { scope: { ...f.scope, viewSelection: f.scope.viewSelection + 1 } },
        draft ? { scope: f.scope } : { draft: 'f'.repeat(32) },
      ]) {
        await f.ack(first, { ...error, ...patch });
        expect(issue()).toBeNull();
      }
      await f.ack(first, { presented: true });
      expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
      expect(f.document.querySelector('[aria-label="网页加载中"]')).not.toBeNull();
      await f.ack(first, error);
      expect(issue()?.getAttribute('title')).toContain('网页显示尚未确认');
      await f.ack(first, { presented: true });
      expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
      expect(f.document.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
      expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
      expect(f.requests.some((request) => ['reload', 'grant'].includes(request.action))).toBe(
        false,
      );
    } finally {
      Object.assign(window.kiteNative!, { presentBrowserLayout: present });
      await f.close();
    }
  });

for (const owner of ['session', 'draft'] as const)
  test(`a new ${owner} draw retires an older rejected witness even at the same presentation revision`, async () => {
    const f = measuredLayoutPortFixture(false, true);
    const present = window.kiteNative!.presentBrowserLayout;
    const rejected: MeasuredPresent[] = [];
    const draft = owner === 'draft' ? '00112233445566778899aabbccddeeff' : undefined;
    try {
      await f.render(false, draft ? null : f.scope, draft);
      Object.assign(window.kiteNative!, {
        presentBrowserLayout(input: MeasuredPresent) {
          rejected.push(input);
          throw Error('browser_presentation_unavailable');
        },
      });
      await f.navigate('https://example.test/rejected');
      const old = rejected.at(-1)!;
      Object.assign(window.kiteNative!, { presentBrowserLayout: present });
      await f.resize(1200);
      const current = f.positive('sync').at(-1)!.input;
      expect(current.presentationRevision).toBe(old.presentationRevision);
      expect(current.witness!.key).not.toBe(old.witness!.key);
      const oldError = { presented: false, error: 'browser_presentation_unavailable' } as const;
      await f.ack(old, oldError);
      expect(f.document.querySelector('[aria-label="页面状态与选项"]')).toBeNull();
      await f.ack(current, { step: 1 });
      const second = f.positive('sync').at(-1)!.input;
      await f.ack(old, oldError);
      expect(f.document.querySelector('[aria-label="页面状态与选项"]')).toBeNull();
      await f.ack(second, { presented: true });
      expect(f.document.querySelector('.native-browser-start')).toBeNull();
      await f.ack(old, oldError);
      expect(f.document.querySelector('.native-browser-start')).toBeNull();
      expect(f.document.querySelector('[aria-label="页面状态与选项"]')).toBeNull();
      expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
      expect(f.requests.some((request) => ['reload', 'grant'].includes(request.action))).toBe(
        false,
      );
    } finally {
      Object.assign(window.kiteNative!, { presentBrowserLayout: present });
      await f.close();
    }
  });

test('first navigation keeps the original Root source until its exact native presentation completes', async () => {
  const f = measuredLayoutPortFixture(false, true);
  try {
    await f.render(false);
    const source = f.document.querySelector('.native-browser-start')!;
    const viewport = f.document.querySelector('.native-browser-viewport');
    expect(source).not.toBeNull();
    expect(f.document.querySelector('[aria-label="网页加载中"]')).toBeNull();
    await f.navigate('https://example.test/first');
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    expect(f.document.querySelector('[role="status"][aria-label="网页加载中"]')).not.toBeNull();
    expect(f.document.body.textContent).not.toContain('正在显示原网页');
    expect(f.document.querySelector('.native-browser-viewport') === viewport).toBe(true);
    const first = f.positive('sync').at(-1)!.input;
    await f.render(true);
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    await f.ack(first, { step: 1 });
    const second = f.positive('sync').at(-1)!.input;
    expect(second.witness!.step).toBe(2);
    const clears = f.cleared.length;
    await f.ack(second, { presented: false });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    expect(f.document.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
    expect(f.cleared.slice(clears)).toEqual([[0, 0, 120, 3]]);
    expect(f.document.querySelector('[role="status"][aria-label="网页加载中"]')).not.toBeNull();
    await f.ack(second, { presented: true });
    expect(f.document.querySelector('.native-browser-start')).toBeNull();
    expect(f.document.querySelector('[aria-label="网页加载中"]')).toBeNull();
    expect(f.document.querySelector('.native-browser-viewport') === viewport).toBe(true);
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
    expect(f.requests.some((request) => ['grant', 'reload'].includes(request.action))).toBe(false);
    await f.navigate('https://example.test/later-navigation');
    expect(f.document.querySelector('.native-browser-start')).toBeNull();
  } finally {
    await f.close();
  }
});

test('first navigation ignores wrong identity, superseded navigation, stop and scope proofs', async () => {
  const f = measuredLayoutPortFixture(false, true);
  try {
    await f.render(false);
    const source = f.document.querySelector('.native-browser-start');
    await f.navigate('https://example.test/first');
    const first = f.positive('sync').at(-1)!.input;
    for (const patch of [
      { key: 'retired-key' },
      { presentationRevision: first.presentationRevision! + 1 },
      { scope: { ...f.scope, generation: 2 } },
    ]) {
      await f.ack(first, { presented: true, ...patch });
      expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    }
    await f.navigate('https://example.test/second');
    const second = f.positive('sync').at(-1)!.input;
    expect(second.presentationRevision!).toBeGreaterThan(first.presentationRevision!);
    await f.ack(first, { presented: true });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    await f.stop();
    const stopped = f.positive('sync').at(-1)!.input;
    expect(stopped.presentationRevision!).toBeGreaterThan(second.presentationRevision!);
    await f.ack(second, { presented: true });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    await f.render(false, { ...f.scope, generation: 2 });
    await f.ack(stopped, { presented: true });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    const receive = f.frameAck;
    await f.unmount();
    const events = f.events.length;
    await f.flush(() =>
      receive({
        id: stopped.id,
        scope: stopped.scope!,
        presentationRevision: stopped.presentationRevision!,
        key: stopped.witness!.key,
        step: 2,
        presented: true,
      }),
    );
    expect(f.events).toHaveLength(events);
    expect(f.document.querySelector('.native-browser-start')).toBeNull();
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(2);
    expect(f.requests.filter((request) => request.action === 'stop')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('initial presentation errors retain the source and expose a readable failure without retrying navigation', async () => {
  const f = measuredLayoutPortFixture(false, true);
  try {
    await f.render(false);
    const source = f.document.querySelector('.native-browser-start');
    await f.navigate('https://example.test/first');
    const first = f.positive('sync').at(-1)!.input;
    await f.ack(first, { presented: false, error: 'browser_presentation_unavailable' });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    expect(
      f.document.querySelector('[aria-label="页面状态与选项"]')?.getAttribute('title'),
    ).toContain('网页显示尚未确认');
    await f.ack(first, { presented: true });
    expect(f.document.querySelector('.native-browser-start') === source).toBe(true);
    expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
    expect(f.requests.some((request) => ['grant', 'reload'].includes(request.action))).toBe(false);
  } finally {
    await f.close();
  }
});

for (const completion of ['legacy-ack', 'receipt'] as const)
  test(`first navigation accepts a current ${completion} completion without manufacturing a page grant`, async () => {
    const f = measuredLayoutPortFixture(false, true);
    try {
      await f.render(false);
      await f.navigate('https://example.test/first');
      const first = f.positive('sync').at(-1)!.input;
      if (completion === 'legacy-ack') await f.ack(first);
      else {
        f.waiting = false;
        await f.split(0.58);
      }
      expect(f.document.querySelector('.native-browser-start')).toBeNull();
      expect(f.document.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true);
      expect(f.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
      expect(f.requests.some((request) => request.action === 'grant')).toBe(false);
    } finally {
      await f.close();
    }
  });

test('a successful hosted receipt retires only its own palette when newer DOM geometry prevents adoption', async () => {
  const f = measuredLayoutPortFixture(false, true);
  try {
    await f.render(true);
    await f.navigate('https://example.test/original');
    const source = f.document.querySelector('.native-browser-start');
    expect(source).not.toBeNull();
    const canvas = f.document.querySelector<HTMLCanvasElement>('canvas')!;
    expect(canvas.hidden).toBe(false);
    const cleared = f.cleared.length;
    // The accepted input was real. At reply time a newer DOM layout exists,
    // before its ResizeObserver delivery; it is not permission to adopt it.
    f.syncReply = (input) => {
      expect(input.witness).toBeDefined();
      f.setGeometry(1200, 740);
      return {
        state: {
          id: 'browser',
          url: 'https://example.test/original',
          title: 'Original page',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
        waiting: false,
      };
    };
    await f.resize(1100, 760);
    expect(canvas.hidden).toBe(true);
    expect(f.cleared.length).toBeGreaterThan(cleared);
    expect(f.document.querySelector('.native-browser-start')).toBe(source);
    expect(f.pending).toHaveLength(0); // Compatibility uses its real synchronous port.
    expect(f.requests.filter((r) => r.action === 'navigate')).toHaveLength(1);
    expect(f.requests.some((r) => r.action === 'grant')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a hosted receipt for another page cannot retire the current palette or adopt the source', async () => {
  const f = measuredLayoutPortFixture(false, true);
  try {
    await f.render(true);
    await f.navigate('https://example.test/original');
    const canvas = f.document.querySelector<HTMLCanvasElement>('canvas')!,
      source = f.document.querySelector('.native-browser-start'),
      cleared = f.cleared.length;
    expect(canvas.hidden).toBe(false);
    f.syncReply = () => ({
      state: {
        id: 'another-page',
        url: 'https://example.test/original',
        title: 'Other page',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
      waiting: false,
    });
    await f.resize(1100, 760);
    expect(canvas.hidden).toBe(false);
    expect(f.cleared).toHaveLength(cleared);
    expect(f.document.querySelector('.native-browser-start')).toBe(source);
    expect(f.requests.some((r) => r.action === 'grant')).toBe(false);
  } finally {
    await f.close();
  }
});

for (const boundary of ['scope', 'stop'] as const)
  test(`a successful old hosted reply after ${boundary} cannot clear the successor palette or adopt its source`, async () => {
    const f = measuredLayoutPortFixture(true, true);
    try {
      await f.render(true);
      await f.navigate('https://example.test/original');
      const original = f.positive('sync').at(-1)!.input;
      await f.resize(1100, 760);
      const pending = f.pending[0]!;
      expect(pending.input.witness).toBeUndefined();
      if (boundary === 'scope') await f.render(true, { ...f.scope, viewSelection: 2 });
      else await f.stop();
      const current = f.positive('sync').at(-1)!.input,
        canvas = f.document.querySelector<HTMLCanvasElement>('canvas')!,
        source = f.document.querySelector('.native-browser-start');
      expect(current.witness!.key).not.toBe(original.witness!.key);
      expect(canvas.hidden).toBe(false);
      expect(source).not.toBeNull();
      const cleared = f.cleared.length;
      await f.ack(current, { scope: { ...f.scope, viewSelection: 999 }, presented: true });
      expect(canvas.hidden).toBe(false);
      expect(f.cleared).toHaveLength(cleared);
      await f.flush(() =>
        pending.resolve({
          state: {
            id: 'browser',
            url: 'https://example.test/original',
            title: 'Original page',
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
          waiting: false,
        }),
      );
      expect(canvas.hidden).toBe(false);
      expect(f.cleared).toHaveLength(cleared);
      expect(f.document.querySelector('.native-browser-start')).toBe(source);
      expect(f.pending).toHaveLength(1);
      expect(f.requests.filter((r) => r.action === 'navigate')).toHaveLength(1);
      expect(f.requests.some((r) => r.action === 'grant')).toBe(false);
    } finally {
      await f.close();
    }
  });

test('stable hosted measurements including same-window splitter changes use one asynchronous port and remeasure the latest layout', async () => {
  const f = measuredLayoutPortFixture(true, true);
  try {
    await f.render();
    await f.navigate('https://example.test/original');
    const first = f.positive('sync').at(-1)!.input;
    expect(first.witness?.step).toBe(1);
    await f.ack(first, { step: 1 });
    const second = f.positive('sync').at(-1)!.input;
    expect(second.witness).toEqual({ key: first.witness!.key, step: 2 });
    await f.ack(second, { presented: true });
    const canvas = f.document.querySelector<HTMLCanvasElement>('canvas')!,
      cleared = f.cleared.length;
    expect(canvas.hidden).toBe(true);
    expect(f.positive('sync').length).toBeGreaterThan(0);
    expect(f.pending).toHaveLength(0); // bootstrap still establishes layout synchronously
    const sync = f.positive('sync').length;
    await f.resize(1100, 760);
    expect(f.pending).toHaveLength(1);
    expect(f.pending[0]!.input.witness).toBeUndefined();
    expect(canvas.hidden).toBe(true);
    expect(f.cleared).toHaveLength(cleared);
    expect(f.pending[0]!.input.layout).toMatchObject({ windowWidth: 1100, windowHeight: 760 });
    expect(f.positive('sync')).toHaveLength(sync);
    await f.resize(1000, 720);
    await f.resize(1200, 740);
    await f.split(0.5); // latest DOM is read after the in-flight result, not queued now
    expect(f.pending).toHaveLength(1);
    expect(f.positive('sync')).toHaveLength(sync);
    await f.flush(() => f.pending[0]!.resolve());
    expect(f.pending).toHaveLength(2);
    expect(f.pending[1]!.input.layout).toMatchObject({ windowWidth: 1200, windowHeight: 740 });
    expect(f.pending[1]!.input.bounds).toMatchObject({ x: 601, width: 599, height: 666 });
    expect(f.pending.some((item) => item.input.layout?.windowWidth === 1000)).toBe(false);
    expect(f.positive('sync')).toHaveLength(sync);
    await f.flush(() => f.pending[1]!.resolve());
    expect(f.pending).toHaveLength(2);
    await f.split(0.55);
    expect(f.pending).toHaveLength(3);
    expect(f.positive('sync')).toHaveLength(sync);
    expect(f.pending[2]!.input.layout).toMatchObject({ windowWidth: 1200, windowHeight: 740 });
    expect(f.pending[2]!.input.bounds).toMatchObject({ x: 660, width: 540 });
    await f.resize(1200, 740); // a same-window resize notification cannot reenter sync IPC
    expect(f.positive('sync')).toHaveLength(sync);
    expect(f.pending).toHaveLength(3);
    await f.flush(() => f.pending[2]!.resolve());
    expect(f.pending.every(({ input }) => input.witness === undefined)).toBe(true);
    expect(canvas.hidden).toBe(true);
    expect(f.cleared).toHaveLength(cleared);
    expect(f.positive('legacy')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('returning to the last committed window size while another size is in flight still restores its latest layout', async () => {
  const f = measuredLayoutPortFixture();
  try {
    await f.render();
    const sync = f.positive('sync').length;
    await f.resize(1100, 760);
    expect(f.pending).toHaveLength(1);
    await f.resize(1400, 800);
    expect(f.pending).toHaveLength(1);
    await f.flush(() => f.pending[0]!.resolve());
    expect(f.pending).toHaveLength(2);
    expect(f.pending[1]!.input.layout).toMatchObject({ windowWidth: 1400, windowHeight: 800 });
    expect(f.positive('sync')).toHaveLength(sync);
    await f.flush(() => f.pending[1]!.resolve());
    expect(f.pending).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const fallback of ['not-hosted', 'missing-async-port'] as const)
  test(`window measurements keep the synchronous compatibility path when ${fallback}`, async () => {
    const f = measuredLayoutPortFixture(fallback !== 'missing-async-port');
    try {
      await f.render(fallback !== 'not-hosted');
      const count = f.positive('sync').length;
      expect(count).toBeGreaterThan(0);
      await f.resize(1100, 760);
      expect(f.positive('sync')).toHaveLength(count + 1);
      expect(f.positive('sync').at(-1)!.input.layout).toMatchObject({
        windowWidth: 1100,
        windowHeight: 760,
      });
      expect(f.pending).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

for (const boundary of ['unmount', 'scope'] as const)
  for (const outcome of ['reply', 'rejection'] as const)
    test(`a pending hosted layout ${outcome} after ${boundary} cannot revive the old measurement or suppress hide`, async () => {
      const f = measuredLayoutPortFixture();
      try {
        await f.render();
        await f.resize(1100, 760);
        expect(f.pending).toHaveLength(1);
        await f.resize(1200, 740);
        expect(f.pending).toHaveLength(1);
        const nextScope = { ...f.scope, generation: 2, viewSelection: 3 };
        const beforeBoundary = f.events.length;
        if (boundary === 'unmount') await f.unmount();
        else await f.render(true, nextScope);
        expect(
          f.events
            .slice(beforeBoundary)
            .filter(
              ({ port, input }) =>
                port === 'legacy' &&
                !input.bounds &&
                input.scope?.generation === f.scope.generation &&
                input.presentationRevision === f.pending[0]!.input.presentationRevision,
            ),
        ).toHaveLength(1);
        const afterBoundary = f.events.length;
        await f.flush(() => {
          if (outcome === 'reply') f.pending[0]!.resolve();
          else f.pending[0]!.reject();
        });
        expect(f.events).toHaveLength(afterBoundary);
        expect(f.pending).toHaveLength(1);
        if (boundary === 'scope') {
          await f.resize(1150, 730);
          expect(f.pending).toHaveLength(2);
          expect(f.pending[1]!.input.scope).toEqual(nextScope);
          await f.flush(() => f.pending[1]!.resolve());
        }
      } finally {
        await f.close();
      }
    });

test('redirects preserve a focused address edit, then show the latest page URL on blur', async () => {
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
  const state: NativeBrowserState = {
    id: 'browser',
    url: 'https://example.com/start',
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  let notify!: (state: NativeBrowserState) => void;
  Object.assign(window, {
    kiteNative: {
      async browserRequest(request: NativeBrowserRequest) {
        return request.action === 'state' ? state : null;
      },
      watchBrowser(listener: typeof notify) {
        notify = listener;
        return () => {};
      },
    },
  });
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () =>
      root.render(<NativeBrowserPane id="browser" visible tools={null} onTitleChange={() => {}} />),
    );
    const address = document.querySelector('input')!;
    expect(address.value).toBe(state.url);
    await act(async () => address.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        address,
        'https://example.com/editing',
      );
      address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => notify({ ...state, url: 'https://example.com/redirect' }));
    expect(address.value).toBe('https://example.com/editing');
    await act(async () => notify({ ...state, url: 'https://example.com/final' }));
    expect(address.value).toBe('https://example.com/editing');
    await act(async () => address.blur());
    expect(address.value).toBe('https://example.com/final');
    await act(async () => notify({ ...state, url: 'https://example.com/next' }));
    expect(address.value).toBe('https://example.com/next');
  } finally {
    await act(async () => root.unmount());
    restoreLayout();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});

function paneFixture(initial: NativeBrowserState, onCaughtError?: (cause: unknown) => void) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
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
  let state = initial,
    notify!: (next: NativeBrowserState) => void;
  const requests: NativeBrowserRequest[] = [];
  Object.assign(dom.window, {
    kiteNative: {
      async browserRequest(request: NativeBrowserRequest) {
        requests.push(request);
        if (request.action === 'present') return null;
        if (request.action === 'grant' && state.control)
          state = { ...state, control: { ...state.control, phase: 'armed' } };
        if (request.action === 'reload') state = { ...state, error: undefined, loading: true };
        return state;
      },
      watchBrowser(listener: typeof notify) {
        notify = listener;
        return () => {};
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById('root')!, { onCaughtError });
  const flush = async (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(35);
    });
  return {
    document: dom.window.document,
    window: dom.window,
    requests,
    flush,
    button(label: string) {
      return [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.getAttribute('aria-label') === label || node.textContent === label,
      )!;
    },
    render(
      props: Partial<ComponentProps<typeof NativeBrowserPane>> = {},
      Pane = NativeBrowserPane,
    ) {
      return flush(() =>
        root.render(<Pane id="browser" visible tools={null} onTitleChange={() => {}} {...props} />),
      );
    },
    update(next: NativeBrowserState) {
      return flush(() => {
        state = next;
        notify(next);
      });
    },
    async until(check: () => boolean) {
      const end = Date.now() + 2000;
      while (!check()) {
        if (Date.now() > end) throw Error('native_pane_state_timeout');
        await flush();
      }
    },
    async close() {
      await act(() => root.unmount());
      restore();
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}

test('reevaluating the pane module keeps document presentation ordering; a new Root document starts a new sequence', async () => {
  const path = '../../src/native-browser-pane.tsx';
  const initial = (await import(
    `${path}?presentation-before-refresh`
  )) as typeof import('../../src/native-browser-pane');
  const refreshed = (await import(`${path}?presentation-after-refresh`)) as typeof initial;
  expect(initial.NativeBrowserPane).not.toBe(refreshed.NativeBrowserPane);
  const page: NativeBrowserState = {
    id: 'browser',
    url: 'https://example.test/original',
    title: 'Original page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const f = paneFixture(page);
  let latestRevision = 0,
    visible = false,
    deferCleanup = false,
    lateCleanup: (() => void) | undefined;
  const rejected: number[] = [];
  const rect = () => new f.window.DOMRect(100, 100, 400, 400);
  f.window.HTMLElement.prototype.getBoundingClientRect = rect;
  Object.assign(f.window.kiteNative!, {
    browserRequest(request: NativeBrowserRequest) {
      f.requests.push(request);
      if (request.action !== 'present') return Promise.resolve(page);
      const present = () => {
        const revision = request.presentationRevision!;
        if (revision < latestRevision) {
          rejected.push(revision);
          throw Error('invalid_browser_request');
        }
        latestRevision = revision;
        visible = !!request.bounds;
        return page;
      };
      if (deferCleanup && !request.bounds) {
        deferCleanup = false;
        return new Promise((resolve, reject) => {
          lateCleanup = () => {
            try {
              resolve(present());
            } catch (cause) {
              reject(cause);
            }
          };
        });
      }
      return Promise.resolve().then(present);
    },
  });
  let beforeRefresh = 0;
  try {
    await f.render({ scope }, initial.NativeBrowserPane);
    await f.render({ scope, visible: false }, initial.NativeBrowserPane);
    await f.render({ scope }, initial.NativeBrowserPane);
    expect(visible).toBe(true);
    beforeRefresh = latestRevision;
    deferCleanup = true;
    await f.render({ scope }, refreshed.NativeBrowserPane);
    expect(latestRevision).toBeGreaterThan(beforeRefresh);
    expect(visible).toBe(true);
    expect(lateCleanup).toBeDefined();
    await f.flush(() => lateCleanup!());
    expect(rejected).toEqual([beforeRefresh]);
    expect(visible).toBe(true);
    expect(f.requests.every((request) => ['state', 'present'].includes(request.action))).toBe(true);
  } finally {
    lateCleanup?.();
    await f.close();
  }
  const replacement = paneFixture(page);
  try {
    await replacement.render({ scope: { ...scope, generation: 2 } }, refreshed.NativeBrowserPane);
    const revisions = replacement.requests.flatMap((request) =>
      request.action === 'present' ? [request.presentationRevision!] : [],
    );
    expect(revisions.length).toBeGreaterThan(0);
    expect(Math.max(...revisions)).toBeLessThan(beforeRefresh);
    expect(
      replacement.requests.every((request) => ['state', 'present'].includes(request.action)),
    ).toBe(true);
  } finally {
    await replacement.close();
  }
});

test('actual Fast Refresh preserves the live presentation only while the original DOM and presentation remain qualified', async () => {
  const path = '../../src/native-browser-pane.tsx';
  const first = (await import(
    `${path}?live-presentation-before-refresh`
  )) as typeof import('../../src/native-browser-pane');
  const next = (await import(`${path}?live-presentation-after-refresh`)) as typeof first;
  const page: NativeBrowserState = {
    id: 'browser',
    url: 'https://example.test/original',
    title: 'Original page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const f = paneFixture(page);
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const id = 'live-presentation-refresh';
  refresh.registerExportsForReactRefresh(id, first);
  f.window.HTMLElement.prototype.getBoundingClientRect = () =>
    new f.window.DOMRect(100, 100, 400, 400);
  const watchers = new Set<(ack: NativeBrowserLayoutFrameAck) => void>();
  Object.assign(f.window.kiteNative!, {
    watchBrowserLayoutFrame(listener: (ack: NativeBrowserLayoutFrameAck) => void) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  });
  try {
    await f.render({ scope }, first.NativeBrowserPane);
    const node = f.document.querySelector('.native-browser-viewport')!;
    const previous = f.requests.at(-1)!;
    expect(previous.action).toBe('present');
    expect(watchers.size).toBe(1);
    const oldWatcher = [...watchers][0]!;
    const boundary = f.requests.length;
    await f.flush(() => {
      refresh.registerExportsForReactRefresh(id, next);
      expect(refresh.validateRefreshBoundaryAndEnqueueUpdate(id, first, next)).toBeUndefined();
    });
    await f.until(() =>
      f.requests.some((request, index) => index >= boundary && request.action === 'present'),
    );
    expect(f.document.querySelector('.native-browser-viewport')).toBe(node);
    expect(watchers.size).toBe(1);
    expect(watchers.has(oldWatcher)).toBe(false);
    const presentations = f.requests
      .slice(boundary)
      .filter((request) => request.action === 'present');
    expect(presentations.length).toBeGreaterThan(0);
    expect(presentations.every((request) => !!request.bounds)).toBe(true);
    expect(presentations[0]!.presentationRevision!).toBeGreaterThan(
      previous.action === 'present' ? previous.presentationRevision! : 0,
    );
    expect(f.requests.every((request) => ['state', 'present'].includes(request.action))).toBe(true);
    const beforeHide = f.requests.length;
    await f.render({ scope, visible: false }, next.NativeBrowserPane);
    expect(
      f.requests
        .slice(beforeHide)
        .some((request) => request.action === 'present' && !request.bounds),
    ).toBe(true);
  } finally {
    await f.close();
  }
  expect(watchers.size).toBe(0);
  expect(f.requests.at(-1)).toMatchObject({ action: 'present', bounds: null });
});

test('Fast Refresh hides instead of retaining disconnected, hidden, covered, changed or unmeasurable viewports', async () => {
  for (const kind of [
    'detached',
    'hidden',
    'inert',
    'visibility',
    'overlay',
    'geometry',
    'unknown',
  ] as const) {
    const path = '../../src/native-browser-pane.tsx';
    const first = (await import(
      `${path}?negative-refresh-before-${kind}`
    )) as typeof import('../../src/native-browser-pane');
    const next = (await import(`${path}?negative-refresh-after-${kind}`)) as typeof first;
    const id = `negative-refresh-${kind}`;
    refresh.registerExportsForReactRefresh(id, first);
    const page: NativeBrowserState = {
      id: 'browser',
      url: 'https://example.test/original',
      title: 'Original page',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    const f = paneFixture(page);
    const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
    let width = 400,
      invalidate = false;
    f.window.HTMLElement.prototype.getBoundingClientRect = () =>
      new f.window.DOMRect(100, 100, width, 400);
    Object.assign(f.window.kiteNative!, {
      watchBrowser() {
        return () => {
          if (!invalidate) return;
          const node = f.document.querySelector<HTMLElement>('.native-browser-viewport')!;
          if (kind === 'detached') node.remove();
          if (kind === 'hidden') node.hidden = true;
          if (kind === 'inert') node.setAttribute('inert', '');
          if (kind === 'visibility') node.style.visibility = 'hidden';
          if (kind === 'overlay') {
            const overlay = f.document.createElement('div');
            overlay.setAttribute('data-native-browser-overlay', '');
            f.document.body.append(overlay);
          }
          if (kind === 'geometry') width = 401;
          if (kind === 'unknown') f.document.body.className = 'client-panels';
        };
      },
    });
    try {
      await f.render({ scope }, first.NativeBrowserPane);
      const last = f.requests.at(-1)!;
      expect(last).toMatchObject({ action: 'present', bounds: { width: 400 } });
      const boundary = f.requests.length;
      invalidate = true;
      await f.flush(() => {
        refresh.registerExportsForReactRefresh(id, next);
        expect(refresh.validateRefreshBoundaryAndEnqueueUpdate(id, first, next)).toBeUndefined();
      });
      await f.until(() => f.requests.length > boundary);
      expect(
        f.requests.slice(boundary).find((request) => request.action === 'present'),
      ).toMatchObject({
        bounds: null,
        presentationRevision: last.action === 'present' ? last.presentationRevision : -1,
        scope,
      });
    } finally {
      invalidate = false;
      await f.close();
    }
  }
});

test('presentation dependency changes and a genuine component replacement always hide the old presentation', async () => {
  for (const kind of [
    'id',
    'host',
    'scope',
    'visible',
    'external',
    'blocked',
    'replacement',
  ] as const) {
    const page: NativeBrowserState = {
      id: 'browser',
      url: 'https://example.test/original',
      title: 'Original page',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    const f = paneFixture(page);
    const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
    f.window.HTMLElement.prototype.getBoundingClientRect = () =>
      new f.window.DOMRect(100, 100, 400, 400);
    try {
      await f.render({ scope });
      const previous = f.requests.at(-1)!;
      const boundary = f.requests.length;
      if (kind === 'external') await f.update({ ...page, url: '' });
      else if (kind === 'blocked') await f.update({ ...page, error: 'process_gone' });
      else {
        if (kind === 'host') Object.assign(f.window, { kiteNative: { ...f.window.kiteNative } });
        const path = '../../src/native-browser-pane.tsx';
        const replacement =
          kind === 'replacement'
            ? (
                (await import(
                  `${path}?genuine-presentation-replacement`
                )) as typeof import('../../src/native-browser-pane')
              ).NativeBrowserPane
            : NativeBrowserPane;
        await f.render(
          {
            id: kind === 'id' ? 'other' : 'browser',
            visible: kind !== 'visible',
            scope: kind === 'scope' ? { ...scope, viewSelection: 2 } : scope,
          },
          replacement,
        );
      }
      expect(
        f.requests.slice(boundary).find((request) => request.action === 'present'),
      ).toMatchObject({
        id: 'browser',
        bounds: null,
        scope,
        presentationRevision: previous.action === 'present' ? previous.presentationRevision : -1,
      });
    } finally {
      await f.close();
    }
  }
});

class PaneEffectBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

test('a failed new effect compensates a retained presentation with its own hide and removes partial subscriptions', async () => {
  const path = '../../src/native-browser-pane.tsx';
  const first = (await import(
    `${path}?failed-effect-before-refresh`
  )) as typeof import('../../src/native-browser-pane');
  const next = (await import(`${path}?failed-effect-after-refresh`)) as typeof first;
  const id = 'failed-effect-refresh';
  refresh.registerExportsForReactRefresh(id, first);
  const page: NativeBrowserState = {
    id: 'browser',
    url: 'https://example.test/original',
    title: 'Original page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const errors: unknown[] = [];
  const failure = Error('new observation unavailable');
  const f = paneFixture(page, (cause) => errors.push(cause));
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  f.window.HTMLElement.prototype.getBoundingClientRect = () =>
    new f.window.DOMRect(100, 100, 400, 400);
  const watchers = new Set<unknown>();
  Object.assign(f.window.kiteNative!, {
    watchBrowserLayoutFrame(listener: unknown) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  });
  const GuardedPane = (props: ComponentProps<typeof NativeBrowserPane>) => (
    <PaneEffectBoundary>
      <first.NativeBrowserPane {...props} />
    </PaneEffectBoundary>
  );
  const OriginalMutationObserver = globalThis.MutationObserver;
  try {
    await f.render({ scope }, GuardedPane);
    const previous = f.requests.at(-1)!;
    const boundary = f.requests.length;
    Object.assign(globalThis, {
      MutationObserver: class {
        constructor() {
          throw failure;
        }
      },
    });
    await f.flush(() => {
      refresh.registerExportsForReactRefresh(id, next);
      expect(refresh.validateRefreshBoundaryAndEnqueueUpdate(id, first, next)).toBeUndefined();
    });
    await f.until(() => errors.length > 0);
    expect(errors).toEqual([failure]);
    expect(watchers.size).toBe(0);
    const cleanup = f.requests.slice(boundary).filter((request) => request.action === 'present');
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({ bounds: null, scope });
    expect(cleanup[0]!.presentationRevision!).toBeGreaterThan(
      previous.action === 'present' ? previous.presentationRevision! : 0,
    );
  } finally {
    Object.assign(globalThis, { MutationObserver: OriginalMutationObserver });
    await f.close();
  }
});

test('a failed old unsubscribe still disconnects the remaining observers and hides before surfacing the failure', async () => {
  const path = '../../src/native-browser-pane.tsx';
  const first = (await import(
    `${path}?failed-cleanup-before-refresh`
  )) as typeof import('../../src/native-browser-pane');
  const next = (await import(`${path}?failed-cleanup-after-refresh`)) as typeof first;
  const id = 'failed-cleanup-refresh';
  refresh.registerExportsForReactRefresh(id, first);
  const page: NativeBrowserState = {
    id: 'browser',
    url: 'https://example.test/original',
    title: 'Original page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const errors: unknown[] = [];
  const failure = Error('old observation unsubscribe failed');
  const f = paneFixture(page, (cause) => errors.push(cause));
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  f.window.HTMLElement.prototype.getBoundingClientRect = () =>
    new f.window.DOMRect(100, 100, 400, 400);
  const observers = new Set<unknown>();
  const Resize = globalThis.ResizeObserver;
  Object.assign(globalThis, {
    ResizeObserver: class {
      constructor() {
        observers.add(this);
      }
      observe() {}
      disconnect() {
        observers.delete(this);
      }
    },
  });
  let failCleanup = false;
  Object.assign(f.window.kiteNative!, {
    watchBrowserLayoutFrame() {
      return () => {
        if (failCleanup) {
          failCleanup = false;
          throw failure;
        }
      };
    },
  });
  const GuardedPane = (props: ComponentProps<typeof NativeBrowserPane>) => (
    <PaneEffectBoundary>
      <first.NativeBrowserPane {...props} />
    </PaneEffectBoundary>
  );
  try {
    await f.render({ scope }, GuardedPane);
    const previous = f.requests.at(-1)!;
    const boundary = f.requests.length;
    failCleanup = true;
    await f.flush(() => {
      refresh.registerExportsForReactRefresh(id, next);
      expect(refresh.validateRefreshBoundaryAndEnqueueUpdate(id, first, next)).toBeUndefined();
    });
    await f.until(() => errors.length > 0);
    expect(errors).toEqual([failure]);
    expect(observers.size).toBe(0);
    expect(f.requests.slice(boundary)).toContainEqual({
      action: 'present',
      id: 'browser',
      bounds: null,
      scope,
      presentationRevision: previous.action === 'present' ? previous.presentationRevision : -1,
    });
  } finally {
    Object.assign(globalThis, { ResizeObserver: Resize });
    await f.close();
  }
});

test('a staged real Pane measures the whole window and claims its restored slot before revealing and drawing', async () => {
  const page: NativeBrowserState = {
    id: 'browser',
    url: 'https://example.test/original',
    title: 'Original',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const f = paneFixture(page);
  Object.assign(f.window.HTMLCanvasElement.prototype, {
    getContext: () => ({ fillStyle: '', fillRect() {}, clearRect() {} }),
  });
  const scope = { storeId: 'store', sessionId: 'session', generation: 2, viewSelection: 2 };
  const bounds = { x: 602, y: 100, width: 421, height: 667, radius: 0 };
  const intent = {
    token: 'a'.repeat(32),
    id: 'browser',
    storeId: 'store',
    sessionId: 'session',
    bounds,
    width: 1024,
    height: 768,
    zoom: 1,
  };
  const events: string[] = [];
  let style!: HTMLStyleElement;
  const bootstrap = createBrowserDisplayBootstrap({
    document: f.document,
    insertCSS(css) {
      style = f.document.createElement('style');
      style.textContent = css;
      f.document.head.append(style);
      return 'stage';
    },
    removeCSS() {
      events.push('reveal');
      style.remove();
    },
    subscribe() {
      return () => {};
    },
    request(value) {
      const input = value as {
        action: string;
        request?: Extract<NativeBrowserRequest, { action: 'present' }>;
      };
      if (input.action === 'get') return intent;
      if (input.action === 'ready') return true;
      if (input.action === 'claim') {
        expect(f.window.getComputedStyle(f.document.getElementById('root')!).opacity).toBe('0');
        expect(input.request).toMatchObject({
          bounds,
          scope,
          layout: { windowWidth: 1024, windowHeight: 768 },
        });
        events.push('claim');
        return true;
      }
      throw Error('unexpected cancellation');
    },
  });
  Object.assign(f.window.kiteNative!, bootstrap, {
    watchBrowserLayoutFrame() {
      return () => {};
    },
    presentBrowserLayout(input: Extract<NativeBrowserRequest, { action: 'present' }>) {
      expect(f.window.getComputedStyle(f.document.getElementById('root')!).opacity).not.toBe('0');
      expect(input.layout!.windowWidth).toBe(1024);
      events.push('witness');
      return { state: page, waiting: true };
    },
  });
  f.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('client-panels')) return new f.window.DOMRect(0, 0, 1024, 768);
    if (this.id === 'left') return new f.window.DOMRect(0, 0, 600, 768);
    if (this.id === 'handle') return new f.window.DOMRect(600, 0, 1, 768);
    if (this.id === 'right') return new f.window.DOMRect(601, 0, 423, 768);
    if (this.classList.contains('native-browser-viewport'))
      return new f.window.DOMRect(602, 100, 421, 667);
    return new f.window.DOMRect();
  };
  const sizing = JSON.stringify({
    minSize: '0px',
    maxSize: '100%',
    groupResizeBehavior: 'preserve-relative-size',
    collapsible: false,
  });
  const LayoutPane = (props: ComponentProps<typeof NativeBrowserPane>) => (
    <div
      className="client-panels"
      data-animate-width="true"
      data-slot="resizable-panel-group"
      style={{ display: 'flex', flexDirection: 'row' }}
    >
      <div id="left" data-panel data-native-browser-layout={sizing} />
      <div id="handle" data-slot="resizable-handle" />
      <div id="right" data-panel data-native-browser-layout={sizing}>
        <NativeBrowserPane {...props} />
      </div>
    </div>
  );
  try {
    expect(f.window.getComputedStyle(f.document.getElementById('root')!).opacity).toBe('0');
    await f.render({ scope }, LayoutPane);
    expect(events).toEqual([]);
    expect(f.window.getComputedStyle(f.document.getElementById('root')!).opacity).toBe('0');
    await f.flush(() =>
      f.document.querySelector('.client-panels')!.removeAttribute('data-animate-width'),
    );
    expect(events).toEqual(['claim', 'reveal', 'witness']);
    expect(f.requests.filter((request) => request.action === 'present' && !request.bounds)).toEqual(
      [],
    );
    expect(f.document.querySelector('.native-browser-viewport')).not.toBeNull();
    expect(bootstrap.browserDisplayIntent!()).toBeNull();
  } finally {
    await f.close();
  }
});

test('annotation tools use the outer toolbar host and navigation is writable only in manual control phases', async () => {
  const page: NativeBrowserState = {
    id: 'browser',
    title: 'Fixture',
    url: 'http://localhost/page',
    loading: false,
    canGoBack: true,
    canGoForward: true,
    control: {
      phase: 'agent',
      browserId: 'browser',
      sessionId: 'session',
      incarnation: 'page-inc',
      navigation: 0,
    },
  };
  const f = paneFixture(page);
  let annotationVisible = false,
    annotationHost: HTMLElement | null = null;
  try {
    await f.render({
      annotate: (_page, visible, toolbarHost) => {
        annotationVisible = visible;
        annotationHost = toolbarHost;
        return (
          <>
            <section aria-label="注释画面">Fixture snapshot</section>
            {toolbarHost &&
              createPortal(
                <button type="button" aria-label="注释工具">
                  指向元素
                </button>,
                toolbarHost,
              )}
          </>
        );
      },
    });
    const toolbar = f.document.querySelector<HTMLFormElement>('.native-browser-toolbar')!,
      viewport = f.document.querySelector('.native-browser-viewport')!,
      surface = f.document.querySelector('.native-browser-surface')!;
    expect(annotationHost).not.toBeNull();
    expect(toolbar.contains(annotationHost)).toBe(true);
    expect(surface.contains(annotationHost)).toBe(false);
    expect(annotationVisible).toBe(false);
    expect(annotationHost!.hidden).toBe(true);
    await f.flush(() => f.button('指向注释').click());
    expect(annotationVisible).toBe(true);
    expect(annotationHost!.hidden).toBe(false);
    expect(f.button('注释工具').closest('form') === toolbar).toBe(true);
    const annotations = f.document.querySelector<HTMLElement>('.native-browser-annotations')!;
    expect(annotations.hidden).toBe(false);
    expect(annotations.querySelector('header, form, .agent-browser-toolbar')).toBeNull();
    expect(toolbar.querySelector('form')).toBeNull();
    await f.flush(() => f.button('返回网页').click());
    expect(annotationVisible).toBe(false);
    expect(annotations.hidden).toBe(true);
    expect(f.document.querySelector('.native-browser-viewport') === viewport).toBe(true);

    const address = toolbar.querySelector<HTMLInputElement>('.native-browser-address')!;
    for (const phase of ['agent', 'acquiring', 'revoking', 'unknown', 'human', 'armed'] as const) {
      await f.update({ ...page, control: { ...page.control!, phase } });
      const manual = phase === 'human' || phase === 'armed';
      expect(address.readOnly).toBe(!manual);
      for (const label of ['后退', '前进', '刷新网页'])
        expect(f.button(label).disabled).toBe(!manual);
      const before = f.requests.length;
      await f.flush(() => {
        f.button('后退').click();
        f.button('前进').click();
        f.button('刷新网页').click();
        toolbar.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(
        f.requests
          .slice(before)
          .filter((request) => ['back', 'forward', 'reload', 'navigate'].includes(request.action))
          .map((request) => request.action),
      ).toEqual(manual ? ['back', 'forward', 'reload', 'navigate'] : []);
      expect(surface.querySelector('button, input, header')).toBeNull();
      expect(f.document.querySelector('.native-browser-viewport') === viewport).toBe(true);
    }
  } finally {
    await f.close();
  }
});

test('a current options-menu failure stays readable without withdrawing the page or becoming a page error', async () => {
  const page: NativeBrowserState = {
    id: 'browser',
    title: 'Page',
    url: 'https://example.test/retained',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const f = paneFixture(page);
  let toolbar: NativeBrowserToolbarPort | undefined;
  let attempts = 0;
  Object.assign(f.window.kiteNative!, {
    async showBrowserMenu() {
      if (++attempts === 1) throw Error('native_menu_failed');
      return 'reload' as const;
    },
  });
  try {
    await f.render({
      scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 },
      onChromePresentation: (port) => {
        toolbar = port;
      },
    });
    const viewport = f.document.querySelector<HTMLElement>('.native-browser-viewport')!;
    viewport.getBoundingClientRect = () => new f.window.DOMRect(100, 100, 300, 400);
    await f.flush(() => f.window.dispatchEvent(new f.window.Event('resize')));
    const withdrawals = () => f.requests.filter((r) => r.action === 'present' && !r.bounds).length;
    const before = withdrawals();
    await f.flush(() => f.button('页面选项').click());
    expect(attempts).toBe(1);
    expect(toolbar?.data.error).toBeUndefined();
    expect(toolbar?.data.optionsIssue).toBe('页面选项暂不可用，请重试。');
    expect(f.button('页面状态与选项').title).toBe('页面选项暂不可用，请重试。');
    expect(withdrawals()).toBe(before);
    expect(f.document.querySelector('.native-browser-viewport')).toBe(viewport);
    expect(f.requests.some((r) => r.action === 'reload')).toBe(false);
    await f.flush(() => f.button('页面状态与选项').click());
    expect(attempts).toBe(2);
    expect(toolbar?.data.optionsIssue).toBeUndefined();
    expect(toolbar?.data.error).toBeUndefined();
    expect(f.requests.filter((r) => r.action === 'reload')).toHaveLength(1);
    expect(withdrawals()).toBe(before);
  } finally {
    await f.close();
  }
});

test('ordinary native options keep page pixels, retain error details and discard a late action after hiding', async () => {
  const page: NativeBrowserState = {
    id: 'browser',
    title: 'Page',
    url: 'http://localhost/page',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    control: { phase: 'human', sessionId: 'session', incarnation: 'page-inc', navigation: 0 },
  };
  const f = paneFixture(page);
  const menus: import('../../src/native-browser-bridge').NativeBrowserMenuRequest[] = [],
    cancelled: string[] = [];
  let resolve!: (
      action: import('../../src/native-browser-bridge').NativeBrowserMenuAction | null,
    ) => void,
    captures = 0;
  Object.assign(f.window.kiteNative!, {
    showBrowserMenu(input: import('../../src/native-browser-bridge').NativeBrowserMenuRequest) {
      menus.push(input);
      return new Promise((done) => {
        resolve = done;
      });
    },
    cancelBrowserMenu(id: string) {
      cancelled.push(id);
    },
    async captureBrowserPresentation() {
      captures++;
      throw Error('capture_unavailable');
    },
  });
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  try {
    await f.render({ scope });
    const viewport = f.document.querySelector<HTMLElement>('.native-browser-viewport')!;
    viewport.getBoundingClientRect = () => new f.window.DOMRect(100, 100, 300, 400);
    await f.flush(() => f.window.dispatchEvent(new f.window.Event('resize')));
    const before = f.requests.length;
    await f.flush(() => f.button('页面选项').click());
    expect(menus).toHaveLength(1);
    expect(menus[0]).toMatchObject({
      id: 'browser',
      scope,
      incarnation: 'page-inc',
      navigation: 0,
      items: [
        { action: 'back', enabled: true },
        { action: 'forward', enabled: false },
        { action: 'reload', enabled: true },
      ],
    });
    expect(captures).toBe(0);
    expect(
      f.requests.slice(before).filter((r) => r.action === 'present' && r.bounds === null),
    ).toHaveLength(0);
    expect(
      f.document.querySelector('[data-native-browser-menu-fallback], img[src], [role="dialog"]'),
    ).toBeNull();
    await f.render({ scope, visible: false });
    expect(cancelled).toEqual([menus[0]!.requestId]);
    await f.flush(() => resolve('back'));
    expect(f.requests.some((r) => r.action === 'back')).toBe(false);
    await f.render({ scope });
    await f.update({ ...page, error: 'load_failed' });
    await f.flush(() => f.button('页面状态与选项').click());
    expect(menus.at(-1)!.details.join('')).toContain('网页未能打开');
    await f.flush(() => resolve('reload'));
    expect(f.requests.filter((r) => r.action === 'reload')).toHaveLength(1);
    expect(captures).toBe(0);
    expect(f.document.querySelector('.native-browser-viewport')).toBe(viewport);
  } finally {
    await f.close();
  }
});
