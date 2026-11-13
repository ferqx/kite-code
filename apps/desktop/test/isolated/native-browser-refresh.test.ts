import { dirname, join } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { expect, test } from '#kite-test';
import type { NativeBrowserRequest, NativeBrowserState } from '../../src/native-browser-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('the installed React refresh runtime preserves the real Pane while accepting unchanged re-exports and rejecting changed helpers', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const previous = {
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
  const restore = prepareDesktopDom(dom);
  let root: ReturnType<typeof import('react-dom/client')['createRoot']> | undefined;
  try {
    const plugin = dirname(fileURLToPath(import.meta.resolve('@vitejs/plugin-react')));
    const runtime = (await import(pathToFileURL(join(plugin, 'refresh-runtime.js')).href)) as {
      default: { injectIntoGlobalHook(target: typeof globalThis): void };
      registerExportsForReactRefresh(id: string, exports: object): void;
      validateRefreshBoundaryAndEnqueueUpdate(
        id: string,
        previous: object,
        next: object,
      ): string | undefined;
    };
    runtime.default.injectIntoGlobalHook(globalThis);
    const { createRoot } = await import('react-dom/client');
    const path = '../../src/native-browser-pane.tsx';
    const first = (await import(
      `${path}?refresh-boundary-first`
    )) as typeof import('../../src/native-browser-pane');
    const next = (await import(
      `${path}?refresh-boundary-next`
    )) as typeof import('../../src/native-browser-pane');
    expect(first.NativeBrowserPane).not.toBe(next.NativeBrowserPane);
    const id = 'native-browser-pane';
    const adaptersPath = '../../src/native-browser-session.tsx';
    const oldAdapters = (await import(
      `${adaptersPath}?refresh-boundary-first`
    )) as typeof import('../../src/native-browser-session');
    const nextAdapters = (await import(
      `${adaptersPath}?refresh-boundary-next`
    )) as typeof import('../../src/native-browser-session');
    const unchanged: string[] = [],
      changed: string[] = [];
    for (const key of Object.keys(oldAdapters) as (keyof typeof oldAdapters)[]) {
      const result = runtime.validateRefreshBoundaryAndEnqueueUpdate(
        id,
        { ...first, [key]: oldAdapters[key] },
        { ...next, [key]: nextAdapters[key] },
      );
      if (oldAdapters[key] === nextAdapters[key]) {
        // Vite accepts a stable re-export. Reevaluating its importing module
        // does not reevaluate the function's defining module or change identity.
        unchanged.push(key);
        expect(result).toBeUndefined();
      } else {
        changed.push(key);
        expect(result).toContain(`"${key}" export is incompatible`);
      }
    }
    expect(unchanged).toContain('nativeBrowserDisplayHint');
    expect(changed).toContain('closeNativeBrowserTab');
    expect(Object.keys(next)).toEqual(['NativeBrowserPane']);

    const page: NativeBrowserState = {
      id: 'page',
      url: 'https://example.test/original',
      title: 'Original page',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      display: 'ready',
      pageToken: 'exact-main-page-token',
      control: {
        phase: 'human',
        incarnation: 'original-document',
        navigation: 1,
        browserId: 'browser',
        sessionId: 'session',
      },
    };
    const requests: NativeBrowserRequest[] = [];
    Object.assign(dom.window, {
      kiteNative: {
        async browserRequest(request: NativeBrowserRequest) {
          requests.push(request);
          return page;
        },
        watchBrowser() {
          return () => {};
        },
        presentBrowserLayout() {
          return page;
        },
        async presentBrowserLayoutAsync() {
          return page;
        },
      },
    });
    const originalDocument = document;
    const host = document.getElementById('root')!;
    runtime.registerExportsForReactRefresh(id, first);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(first.NativeBrowserPane, {
          id: page.id,
          visible: true,
          tools: null,
          initialHint: page,
          scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 },
          onTitleChange() {},
          annotate: (_state, showing) =>
            createElement('p', { 'data-notes-showing': showing }, 'Original notes'),
        }),
      );
      await fixtureDelay(25);
    });
    const input = host.querySelector<HTMLInputElement>('.native-browser-address')!;
    const pane = host.querySelector('.native-browser-page');
    const viewport = host.querySelector('.native-browser-viewport');
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="指向注释"]')!.click());
    expect(host.querySelector('[data-notes-showing="true"]')).not.toBeNull();
    await act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'https://example.test/unsent-draft',
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.setSelectionRange(8, 15);
    });
    expect(input.value).toBe('https://example.test/unsent-draft');
    runtime.registerExportsForReactRefresh(id, next);
    let queued = false;
    const completed = new Promise<void>((resolve) => {
      const register = Reflect.get(window, '__registerBeforePerformReactRefresh') as (
        callback: () => void,
      ) => void;
      register(() => {
        queued = true;
        resolve();
      });
    });
    await act(async () => {
      expect(runtime.validateRefreshBoundaryAndEnqueueUpdate(id, first, next)).toBeUndefined();
      await completed;
      // The installed runtime invokes its registered renderer after the before
      // hooks settle. Let that real refresh, effects and state read complete.
      await fixtureDelay(25);
    });
    expect(queued).toBe(true);
    expect(document).toBe(originalDocument);
    expect(host.querySelector('.native-browser-page')).toBe(pane);
    expect(host.querySelector('.native-browser-viewport')).toBe(viewport);
    expect(host.querySelector('.native-browser-address')).toBe(input);
    expect(input.value).toBe('https://example.test/unsent-draft');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([8, 15]);
    expect(host.querySelector('[data-notes-showing="true"]')).not.toBeNull();
    expect(
      requests.filter((request) =>
        ['navigate', 'reload', 'close', 'grant'].includes(request.action),
      ),
    ).toEqual([]);
  } finally {
    if (root) await act(() => root!.unmount());
    restore();
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

for (const boundary of ['scope', 'page', 'host', 'document'] as const) {
  test(`a real ${boundary} replacement retires the previous editor and notes instead of retaining HMR state`, async () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    });
    const previous = {
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
    const restore = prepareDesktopDom(dom);
    let other: JSDOM | undefined, restoreOther: (() => void) | undefined;
    let root: ReturnType<typeof import('react-dom/client')['createRoot']> | undefined;
    try {
      const { createRoot } = await import('react-dom/client');
      const { NativeBrowserPane } = await import('../../src/native-browser-pane');
      let state: NativeBrowserState = {
        id: 'page',
        url: 'https://example.test/original',
        title: 'Original',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        display: 'ready',
        pageToken: 'original-main-token',
        control: {
          phase: 'human',
          incarnation: 'original-document',
          navigation: 1,
          browserId: 'browser',
          sessionId: 'session',
        },
      };
      const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
      const bridge = {
        async browserRequest() {
          return state;
        },
        watchBrowser() {
          return () => {};
        },
        presentBrowserLayout() {
          return state;
        },
        async presentBrowserLayoutAsync() {
          return state;
        },
      };
      Object.assign(dom.window, { kiteNative: bridge });
      let host = document.getElementById('root')!;
      root = createRoot(host);
      const render = () =>
        act(async () => {
          root!.render(
            createElement(NativeBrowserPane, {
              id: state.id,
              visible: true,
              tools: null,
              initialHint: state,
              scope,
              onTitleChange() {},
              annotate: (_page, showing) =>
                createElement('p', { 'data-notes-showing': showing }, 'Notes'),
            }),
          );
          await fixtureDelay(25);
        });
      await render();
      const originalInput = host.querySelector<HTMLInputElement>('.native-browser-address')!;
      await act(() => host.querySelector<HTMLButtonElement>('[aria-label="指向注释"]')!.click());
      await act(() => {
        originalInput.focus();
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
          originalInput,
          'https://example.test/retired-draft',
        );
        originalInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      expect(originalInput.value).toBe('https://example.test/retired-draft');
      expect(host.querySelector('[data-notes-showing="true"]')).not.toBeNull();
      if (boundary === 'scope') scope.generation++;
      if (boundary === 'page')
        state = {
          ...state,
          id: 'successor-page',
          url: 'https://example.test/successor',
          pageToken: 'successor-main-token',
        };
      if (boundary === 'host') Object.assign(dom.window, { kiteNative: { ...bridge } });
      if (boundary === 'document') {
        await act(() => root!.unmount());
        other = new JSDOM('<!doctype html><div id="root"></div>', {
          url: 'http://localhost/',
          pretendToBeVisual: true,
        });
        Object.assign(globalThis, {
          window: other.window,
          document: other.window.document,
          navigator: other.window.navigator,
        });
        restoreOther = prepareDesktopDom(other);
        Object.assign(other.window, { kiteNative: bridge });
        host = document.getElementById('root')!;
        root = createRoot(host);
      }
      await render();
      const input = host.querySelector<HTMLInputElement>('.native-browser-address')!;
      expect(input.value).toBe(state.url);
      expect(document.activeElement).not.toBe(input);
      expect(host.querySelector('[data-notes-showing="true"]')).toBeNull();
      if (boundary === 'document') expect(input).not.toBe(originalInput);
      else expect(input).toBe(originalInput);
    } finally {
      if (root) await act(() => root!.unmount());
      restoreOther?.();
      other?.window.close();
      restore();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });
}
