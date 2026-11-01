import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useCallback, useState } from 'react';
import type {
  NativeBrowserMenuAction,
  NativeBrowserMenuRequest,
  NativeBrowserRequest,
  NativeBrowserRestoreScope,
  NativeBrowserState,
} from '../../src/native-browser-bridge';
import type {
  NativeBrowserControlPort,
  NativeBrowserToolbarPort,
} from '../../src/native-browser-chrome-types';
import { browserFixture, browserScope } from '../agent-browser.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restore = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const { NativeBrowserPane } = await import('../../src/native-browser-pane');
  const { NativeBrowserLeaseControls } = await import('../../src/native-browser-lease-controls');
  const { NativeBrowserChromeToolbar, NativeBrowserChromeControl } = await import(
    '../../src/native-browser-chrome-presentation'
  );
  const root = createRoot(document.getElementById('root')!);
  const browser = browserFixture();
  browser.view = { ...browser.view, state: 'human' };
  const requests: NativeBrowserRequest[] = [],
    menus: NativeBrowserMenuRequest[] = [],
    cancels: string[] = [];
  let watches = 0,
    unwatches = 0;
  let watch: (state: NativeBrowserState) => void = () => {};
  let choose!: (action: NativeBrowserMenuAction | null) => void;
  let state: NativeBrowserState = {
    id: 'page',
    title: 'Example',
    url: 'https://example.com/original',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    control: {
      browserId: 'browser',
      sessionId: 'session',
      phase: 'human',
      incarnation: 'original-page',
      navigation: 2,
    },
  };
  Object.assign(dom.window, {
    kiteNative: {
      async browserRequest(request: NativeBrowserRequest) {
        requests.push(request);
        return request.action === 'state' ? state : null;
      },
      watchBrowser(listener: typeof watch) {
        watches++;
        watch = listener;
        return () => unwatches++;
      },
      showBrowserMenu(input: NativeBrowserMenuRequest) {
        menus.push(input);
        return new Promise<NativeBrowserMenuAction | null>((resolve) => {
          choose = resolve;
        });
      },
      cancelBrowserMenu(id: string) {
        cancels.push(id);
      },
    },
  });
  let toolbarPort: NativeBrowserToolbarPort | undefined,
    controlPort: NativeBrowserControlPort | undefined;
  const toolbarPublications: (NativeBrowserToolbarPort | undefined)[] = [];
  function Harness({
    hosted = true,
    visible = true,
    scope = browserScope,
  }: {
    hosted?: boolean;
    visible?: boolean;
    scope?: NativeBrowserRestoreScope;
  }) {
    const [toolbar, setToolbar] = useState<NativeBrowserToolbarPort>();
    const [control, setControl] = useState<NativeBrowserControlPort>();
    const publishToolbar = useCallback((port: NativeBrowserToolbarPort | undefined) => {
      toolbarPublications.push(port);
      setToolbar(port);
    }, []);
    toolbarPort = toolbar;
    controlPort = control;
    return (
      <>
        <div id="owner">
          <NativeBrowserPane
            id="page"
            visible={visible}
            tools={<span>Start tools</span>}
            onTitleChange={() => {}}
            scope={scope}
            chromeHosted={hosted}
            onChromePresentation={publishToolbar}
            annotate={(_, notesVisible) => (
              <span data-note-visible={notesVisible}>Original annotations</span>
            )}
            controlTools={(page) => (
              <NativeBrowserLeaseControls
                bridge={browser.bridge}
                scope={{ ...browserScope, ...scope }}
                page={page}
                visible={visible}
                canRead
                canInvoke
                chromeHosted={hosted}
                onChromePresentation={setControl}
              />
            )}
          />
        </div>
        <div id="chrome">
          {toolbar && (
            <NativeBrowserChromeToolbar
              {...toolbar}
              tools={control && <NativeBrowserChromeControl {...control} />}
            />
          )}
        </div>
      </>
    );
  }
  const flush = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(35);
    });
  return {
    browser,
    requests,
    menus,
    cancels,
    toolbarPublications,
    get toolbar() {
      return toolbarPort;
    },
    get control() {
      return controlPort;
    },
    get watches() {
      return watches;
    },
    get unwatches() {
      return unwatches;
    },
    flush,
    render: (props: Parameters<typeof Harness>[0] = {}) =>
      flush(() => root.render(<Harness {...props} />)),
    update: (next: Partial<NativeBrowserState>) =>
      flush(() => {
        state = { ...state, ...next };
        watch(state);
      }),
    choose: (action: NativeBrowserMenuAction | null) => flush(() => choose(action)),
    async close() {
      await act(() => root.unmount());
      restore();
      dom.window.close();
      Object.assign(globalThis, prior);
    },
  };
}

const anchor = { x: 410, y: 48, width: 32, height: 28 };
test('hosted Chrome publishes plain state while Root retains the only page and control owners', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush();
    expect(f.watches).toBe(1);
    expect(f.requests.filter((request) => request.action === 'state')).toHaveLength(1);
    expect(f.toolbar?.data).toMatchObject({
      id: 'page',
      address: 'https://example.com/original',
      readonlyURL: 'https://example.com/original',
      canNavigate: true,
      canGoBack: true,
      canGoForward: false,
      notesAvailable: true,
      notesOpen: false,
      optionsAvailable: true,
    });
    expect(f.control?.data).toMatchObject({
      id: 'page',
      label: '人工',
      detail: '由你控制',
      handoffAvailable: false,
      closeAvailable: true,
      pending: false,
    });
    expect(JSON.parse(JSON.stringify(f.toolbar?.data))).toEqual(f.toolbar?.data);
    const pane = document.querySelector('#owner .native-browser-page')!;
    expect(pane.hasAttribute('inert')).toBe(false);
    expect(pane.querySelector('.native-browser-viewport')?.closest('[inert]')).toBeNull();
    expect(pane.querySelector('.native-browser-toolbar')?.closest('[inert]')).not.toBeNull();
    const queryCount = f.browser.calls.filter((call) => call.method === 'extensions.query').length;
    await f.flush(() => f.toolbar!.dispatch({ type: 'toggle-notes' }));
    expect(f.toolbar?.data.notesOpen).toBe(true);
    expect(f.toolbarPublications.every(Boolean)).toBe(true);
    expect(pane.querySelector('[data-note-visible="true"]')).not.toBeNull();
    expect(f.watches).toBe(1);
    expect(f.browser.calls.filter((call) => call.method === 'extensions.query')).toHaveLength(
      queryCount,
    );
    await f.flush(() => f.control!.dispatch({ type: 'show-menu', anchor }));
    expect(f.menus.at(-1)?.items).toEqual([
      { action: 'handoff', enabled: false },
      { action: 'close', enabled: true },
    ]);
    await f.choose('close');
    expect(f.browser.submitted).toHaveLength(1);
    expect(f.browser.submitted[0]).toMatchObject({
      actionId: 'browser.close',
      input: { browserId: 'browser', generation: 'browser-generation' },
    });
  } finally {
    await f.close();
  }
});

test('Chrome events use current Root handlers and enforce address and navigation admission', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush();
    await f.flush(() => f.toolbar!.dispatch({ type: 'address-focus', focused: true }));
    await f.flush(() =>
      f.toolbar!.dispatch({ type: 'address-change', value: 'https://example.com/new' }),
    );
    expect(f.toolbar?.data.address).toBe('https://example.com/new');
    await f.flush(() => f.toolbar!.dispatch({ type: 'address-change', value: 'x'.repeat(2049) }));
    expect(f.toolbar?.data.address).toBe('https://example.com/new');
    await f.flush(() => f.toolbar!.dispatch({ type: 'navigate' }));
    expect(f.requests.filter((request) => request.action === 'navigate')).toEqual([
      { action: 'navigate', id: 'page', input: 'https://example.com/new' },
    ]);
    await f.flush(() => f.toolbar!.dispatch({ type: 'show-options', anchor }));
    expect(f.menus.at(-1)).toMatchObject({ id: 'page', x: 442, y: 76 });
    await f.choose('back');
    expect(f.requests.filter((request) => request.action === 'back')).toHaveLength(1);
    await f.update({
      control: {
        browserId: 'browser',
        sessionId: 'session',
        phase: 'agent',
        incarnation: 'original-page',
        navigation: 2,
      },
      loading: true,
      error: 'load_failed',
    });
    expect(f.toolbar?.data).toMatchObject({ canNavigate: false, loading: true });
    expect(f.toolbar?.data.error).toContain('网页未能打开');
    for (const type of ['navigate', 'back', 'forward', 'reload'] as const)
      await f.flush(() => f.toolbar!.dispatch({ type }));
    expect(
      f.requests.filter((request) =>
        ['navigate', 'back', 'forward', 'reload', 'stop'].includes(request.action),
      ),
    ).toHaveLength(2);
    expect(document.querySelector<HTMLInputElement>('#chrome input')?.readOnly).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#chrome input')?.maxLength).toBe(2048);
  } finally {
    await f.close();
  }
});

test('ports retained outside an unmounted owner cannot submit navigation or open a menu', async () => {
  const f = await fixture();
  await f.render();
  await f.flush();
  const toolbar = f.toolbar!,
    control = f.control!;
  await f.close();
  toolbar.dispatch({ type: 'navigate' });
  control.dispatch({ type: 'show-menu', anchor });
  expect(f.requests.some((request) => request.action === 'navigate')).toBe(false);
  expect(f.menus).toHaveLength(0);
  expect(f.watches).toBe(1);
  expect(f.unwatches).toBe(1);
});

test('scope and host changes revoke old dispatches, cancel menus and release local focus', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush();
    const oldToolbar = f.toolbar!,
      oldControl = f.control!;
    await f.flush(() => oldControl.dispatch({ type: 'show-menu', anchor }));
    expect(f.menus).toHaveLength(1);
    await f.render({ hosted: false });
    expect(f.cancels).toEqual([f.menus[0]!.requestId]);
    await f.choose('close');
    expect(f.browser.submitted).toHaveLength(0);
    await f.flush(() => {
      oldToolbar.dispatch({ type: 'navigate' });
      oldControl.dispatch({ type: 'show-menu', anchor });
    });
    expect(f.requests.some((request) => request.action === 'navigate')).toBe(false);
    expect(f.menus).toHaveLength(1);
    const input = document.querySelector<HTMLInputElement>('#owner input')!;
    await f.flush(() => input.focus());
    expect(document.activeElement).toBe(input);
    await f.render({ hosted: true, scope: { ...browserScope, generation: 2 } });
    expect(document.activeElement).not.toBe(input);
    await f.flush(() => {
      oldToolbar.dispatch({ type: 'navigate' });
      oldControl.dispatch({ type: 'show-menu', anchor });
    });
    expect(f.requests.some((request) => request.action === 'navigate')).toBe(false);
    expect(f.menus).toHaveLength(1);
    const retainedToolbar = f.toolbar!;
    await f.render({ visible: false });
    // Inactive page facts stay registered for the next exact selection;
    // retaining the port must not retain its action admission.
    expect(f.toolbar?.data.id).toBe(retainedToolbar.data.id);
    expect(f.control).toBeUndefined();
    const requests = f.requests.length;
    await f.flush(() => {
      retainedToolbar.dispatch({ type: 'navigate' });
      retainedToolbar.dispatch({ type: 'reload' });
      retainedToolbar.dispatch({ type: 'show-options', anchor });
    });
    expect(f.requests).toHaveLength(requests);
    expect(f.menus).toHaveLength(1);
  } finally {
    await f.close();
  }
});
