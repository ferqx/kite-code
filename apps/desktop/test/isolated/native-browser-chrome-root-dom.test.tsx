import { expect, test } from 'bun:test';
import type { SessionTabsChromePresentation, SessionTabsModel } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type {
  NativeBrowserRequest,
  NativeBrowserRestoreScope,
  NativeBrowserState,
} from '../../src/native-browser-bridge';
import type {
  NativeBrowserChromeEnvelope,
  NativeBrowserChromeEvent,
  NativeBrowserChromeOwner,
  NativeBrowserChromeRootBridge,
  NativeBrowserChromeSnapshot,
} from '../../src/native-browser-chrome-bridge';
import type {
  NativeBrowserControlAction,
  NativeBrowserControlPort,
  NativeBrowserToolbarAction,
  NativeBrowserToolbarPort,
} from '../../src/native-browser-chrome-types';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
const ids = Array.from({ length: 8 }, (_, index) => `page-${index}`);
async function fixture(
  supported = true,
  strict = false,
  realPages = false,
  realModel = false,
  modernOwner?: NativeBrowserChromeOwner,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    KeyboardEvent: globalThis.KeyboardEvent,
  };
  const restore = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const viewportObservers = new Set<ResizeObserver>();
  if (realPages) {
    const Observer = globalThis.ResizeObserver;
    class PaneResizeObserver extends Observer {
      override observe(target: Element, options?: ResizeObserverOptions) {
        super.observe(target, options);
        if (target.classList.contains('native-browser-viewport')) viewportObservers.add(this);
      }
      override disconnect() {
        viewportObservers.delete(this);
        super.disconnect();
      }
    }
    Object.assign(dom.window, { ResizeObserver: PaneResizeObserver });
    Object.assign(globalThis, { ResizeObserver: PaneResizeObserver });
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (realPages && this.classList.contains('native-browser-viewport'))
      return new dom.window.DOMRect(600, 74, 400, 650);
    const box = JSON.parse(this.dataset.box ?? '[0,0,0,0]') as [number, number, number, number];
    return new dom.window.DOMRect(...box);
  };
  const { createRoot } = await import('react-dom/client');
  const { useNativeBrowserChromeRoot } = await import('../../src/native-browser-chrome-root');
  const production = realPages
    ? {
        Tabs: (await import('../../../../packages/ui/src/desktop/SessionTabs')).SessionTabs,
        useTabs: (await import('../../../../packages/ui/src/desktop/SessionTabs')).useSessionTabs,
        Pane: (await import('../../src/native-browser-pane')).NativeBrowserPane,
        session: await import('../../src/native-browser-session'),
      }
    : undefined;
  const root = createRoot(document.getElementById('root')!);
  const publications: (NativeBrowserChromeSnapshot | null)[] = [],
    commits: { snapshot: NativeBrowserChromeSnapshot; hostedDOM: string | undefined }[] = [],
    actions: { id: string; action: NativeBrowserToolbarAction | NativeBrowserControlAction }[] = [],
    tabsActions: Parameters<SessionTabsChromePresentation['dispatch']>[0][] = [],
    stateListeners: ((value: NativeBrowserChromeEnvelope | null) => void)[] = [],
    actionListeners: ((event: NativeBrowserChromeEvent) => boolean)[] = [];
  const contexts: { revision: number; owner: NativeBrowserChromeOwner | null }[] = [],
    publicationContexts: (number | undefined)[] = [];
  const timeline: (
    | { kind: 'snapshot'; value: NativeBrowserChromeSnapshot | null }
    | { kind: 'request'; value: NativeBrowserRequest }
    | { kind: 'prepare'; value: { fromId: string; targetId: string } }
    | { kind: 'cancel'; value: string }
  )[] = [];
  const pages = new Map<string, NativeBrowserState>([
    [
      ids[0]!,
      {
        id: ids[0]!,
        url: 'https://example.com/original',
        title: 'Original',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  ]);
  const pageListeners = new Set<(page: NativeBrowserState) => void>();
  const preparations: {
    fromId: string;
    targetId: string;
    resolve(value: { key: string } | null): void;
  }[] = [];
  let liveModel: SessionTabsModel | undefined;
  const ports = new Map<string, NativeBrowserToolbarPort>();
  let watches = 0,
    unwatches = 0,
    rejectPublish = false,
    holdNextPublication = false;
  let rejectHeld!: (cause: Error) => void;
  const rootBridge: NativeBrowserChromeRootBridge = {
    ...(modernOwner
      ? {
          async setBrowserPresentationContext(context: {
            revision: number;
            owner: NativeBrowserChromeOwner | null;
          }) {
            contexts.push(context);
          },
        }
      : {}),
    async publishBrowserChrome(snapshot, context) {
      publicationContexts.push(context);
      publications.push(snapshot);
      timeline.push({ kind: 'snapshot', value: snapshot });
      if (snapshot)
        commits.push({
          snapshot,
          hostedDOM: document.querySelector<HTMLElement>('#headers')?.dataset.hosted,
        });
      if (snapshot && holdNextPublication) {
        holdNextPublication = false;
        await new Promise<void>((_, reject) => {
          rejectHeld = reject;
        });
      }
      if (rejectPublish) throw Error('channel_failed');
    },
    watchBrowserChromeState(receive) {
      watches++;
      stateListeners.push(receive);
      return () => unwatches++;
    },
    watchBrowserChromeAction(receive) {
      watches++;
      actionListeners.push(receive);
      return () => unwatches++;
    },
  };
  Object.assign(window, {
    kiteNative: supported
      ? {
          ...rootBridge,
          ...(realPages
            ? {
                async browserRequest(
                  request: NativeBrowserRequest,
                ): Promise<NativeBrowserState | null> {
                  timeline.push({ kind: 'request', value: request });
                  if (realModel) {
                    if (request.action === 'navigate') {
                      const page = {
                        id: request.id,
                        url: request.input,
                        title: 'Navigating',
                        loading: true,
                        canGoBack: false,
                        canGoForward: false,
                      };
                      pages.set(request.id, page);
                      for (const receive of pageListeners) receive(page);
                    }
                    if (request.action === 'close') pages.delete(request.id);
                    return pages.get(request.id) ?? null;
                  }
                  return {
                    id: request.id,
                    url: `https://example.com/${request.id}`,
                    title: request.id,
                    loading: false,
                    canGoBack: false,
                    canGoForward: false,
                  };
                },
                watchBrowser: (receive: (page: NativeBrowserState) => void) => {
                  pageListeners.add(receive);
                  return () => pageListeners.delete(receive);
                },
                prepareBrowserPresentation(value: { fromId: string; targetId: string }) {
                  timeline.push({ kind: 'prepare', value });
                  return new Promise<{ key: string } | null>((resolve) =>
                    preparations.push({ ...value, resolve }),
                  );
                },
                async cancelBrowserPreparation(key: string) {
                  timeline.push({ kind: 'cancel', value: key });
                },
              }
            : {}),
        }
      : {},
  });
  const observed = new Map<
    string,
    {
      register: (port: NativeBrowserToolbarPort | undefined) => void;
      callback: (port: NativeBrowserToolbarPort | undefined) => void;
    }
  >();
  const restoreRetained = async () => ({ id: ids[0]!, title: 'Original' });
  function RetainedTabs({
    chrome,
    currentScope,
    covered,
    toolbar,
  }: {
    chrome: ReturnType<typeof useNativeBrowserChromeRoot>;
    currentScope: NativeBrowserRestoreScope;
    covered: boolean;
    toolbar(id: string): (port: NativeBrowserToolbarPort | undefined) => void;
  }) {
    if (!production) throw Error('production_components_missing');
    const model = production.useTabs(
      JSON.stringify([currentScope.storeId, currentScope.sessionId]),
      production.session.closeNativeBrowserTab,
      restoreRetained,
      JSON.stringify(currentScope),
      false,
      production.session.prepareNativeBrowserPresentation,
    );
    liveModel = model;
    return (
      <production.Tabs
        model={model}
        visible={!covered}
        present
        changes={null}
        onClose={() => {}}
        scopeKey={JSON.stringify(currentScope)}
        chromeHosted={chrome.tabsHosted}
        onChromePresentation={chrome.tabs}
        renderBrowser={(props) => (
          <production.Pane
            {...props}
            scope={currentScope}
            chromeHosted={chrome.hosted(props.id)}
            onChromePresentation={toolbar(props.id)}
          />
        )}
      />
    );
  }
  const callbacks = new Map<string, ((port: NativeBrowserToolbarPort | undefined) => void)[]>();
  function Page({
    id,
    hosted,
    notesOpen,
    title,
    registerToolbar,
    registerControl,
  }: {
    id: string;
    hosted: boolean;
    notesOpen: boolean;
    title: string;
    registerToolbar: (port: NativeBrowserToolbarPort | undefined) => void;
    registerControl: (port: NativeBrowserControlPort | undefined) => void;
  }) {
    const [address, setAddress] = useState(`https://example.com/${id}`);
    const toolbar = useMemo<NativeBrowserToolbarPort>(
      () => ({
        data: {
          id,
          address,
          readonlyURL: `https://example.com/${id}`,
          loading: false,
          hasPage: true,
          canGoBack: false,
          canGoForward: false,
          canNavigate: true,
          notesAvailable: !modernOwner || !('draft' in modernOwner),
          notesOpen: modernOwner && 'draft' in modernOwner ? false : notesOpen,
          optionsAvailable: true,
        },
        dispatch(action) {
          actions.push({ id, action });
          if (action.type === 'address-change') setAddress(action.value);
        },
      }),
      [id, address, notesOpen],
    );
    const control = useMemo<NativeBrowserControlPort>(
      () => ({
        data: {
          id,
          label: title,
          detail: 'Current control',
          handoffAvailable: false,
          closeAvailable: true,
          pending: false,
          details: [],
        },
        dispatch: (action) => actions.push({ id, action }),
      }),
      [id, title],
    );
    useEffect(() => {
      const previous = callbacks.get(id) ?? [];
      callbacks.set(id, [...previous, registerToolbar]);
      registerToolbar(toolbar);
    }, [id, registerToolbar, toolbar]);
    useEffect(
      () => registerControl(modernOwner && 'draft' in modernOwner ? undefined : control),
      [control, registerControl],
    );
    useEffect(() => () => registerToolbar(undefined), [registerToolbar]);
    useEffect(() => () => registerControl(undefined), [registerControl]);
    return <div data-page={id} data-hosted={hosted} />;
  }
  function Harness({
    currentScope = scope,
    interactive = true,
    covered = false,
    active = ids[0]!,
    notesOpen = false,
    title = 'Page',
    nonbrowser = false,
    presentationOwner = modernOwner,
  }: {
    currentScope?: NativeBrowserRestoreScope;
    interactive?: boolean;
    covered?: boolean;
    active?: string;
    notesOpen?: boolean;
    title?: string;
    nonbrowser?: boolean;
    presentationOwner?: NativeBrowserChromeOwner;
  }) {
    const chrome = useNativeBrowserChromeRoot(presentationOwner ?? currentScope, {
      interactive,
      covered,
    });
    const tabs = useMemo<SessionTabsChromePresentation>(
      () => ({
        data: {
          scopeKey: JSON.stringify([currentScope.storeId, currentScope.sessionId]),
          tabs: ids.map((id) => ({
            id,
            kind: nonbrowser && id === active ? 'changes' : 'browser',
            title,
          })),
          active,
          visible: true,
          present: true,
          restoring: false,
          restoreIssue: false,
        },
        dispatch: (action) => tabsActions.push(action),
      }),
      [currentScope.storeId, currentScope.sessionId, active, nonbrowser, title],
    );
    useLayoutEffect(() => {
      if (!production) chrome.tabs(tabs);
    }, [chrome.tabs, tabs]);
    useLayoutEffect(
      () => () => {
        if (!production) chrome.tabs(null);
      },
      [chrome.tabs],
    );
    const toolbar = useCallback(
      (id: string) => {
        const register = chrome.toolbar(id);
        if (!production) return register;
        const previous = observed.get(id);
        if (previous?.register === register) return previous.callback;
        let ownPort: NativeBrowserToolbarPort | undefined;
        const callback = (port: NativeBrowserToolbarPort | undefined) => {
          if (port) ports.set(id, port);
          else if (ports.get(id) === ownPort) ports.delete(id);
          ownPort = port;
          register(port);
        };
        observed.set(id, { register, callback });
        return callback;
      },
      [chrome.toolbar],
    );
    const model = useMemo<SessionTabsModel>(
      () => ({
        tabs: tabs.data.tabs,
        active,
        select: (id) => tabsActions.push({ type: 'select', id }),
        title() {},
        addBrowser() {},
        openChanges() {},
        openChild: () => false,
        openWorkspace: () => false,
        closeTab() {},
      }),
      [active, tabs.data.tabs],
    );
    if (production && realModel)
      return (
        <RetainedTabs
          chrome={chrome}
          currentScope={currentScope}
          covered={covered}
          toolbar={toolbar}
        />
      );
    if (production)
      return (
        <production.Tabs
          model={model}
          visible={!covered}
          present
          changes={null}
          onClose={() => {}}
          scopeKey={JSON.stringify([currentScope.storeId, currentScope.sessionId])}
          chromeHosted={chrome.tabsHosted}
          onChromePresentation={chrome.tabs}
          renderBrowser={(props) => (
            <production.Pane
              {...props}
              scope={currentScope}
              chromeHosted={chrome.hosted(props.id)}
              onChromePresentation={toolbar(props.id)}
            />
          )}
        />
      );
    return (
      <>
        <div id="headers" data-hosted={chrome.tabsHosted} />
        <aside className="session-tabs right-sidebar" data-box="[600,0,400,800]">
          {ids.map((id) => (
            <Page
              key={id}
              id={id}
              title={title}
              notesOpen={notesOpen && id === active}
              hosted={chrome.hosted(id)}
              registerToolbar={toolbar(id)}
              registerControl={chrome.control(id)}
            />
          ))}
          <div
            className="prompt-editor"
            contentEditable
            suppressContentEditableWarning
            data-box="[700,600,200,50]"
          />
        </aside>
        <div
          id="main-input"
          className="prompt-editor"
          contentEditable
          suppressContentEditableWarning
          data-box="[50,600,400,50]"
        />
      </>
    );
  }
  const flush = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(15);
    });
  const latest = () =>
    publications
      .filter((snapshot): snapshot is NativeBrowserChromeSnapshot => snapshot !== null)
      .at(-1)!;
  let attachment = 'attachment-1',
    pageToken = 'token-1',
    sequence = 0;
  return {
    publications,
    contexts,
    publicationContexts,
    timeline,
    ports,
    preparations,
    get model() {
      return liveModel!;
    },
    updatePage(id: string, patch: Partial<NativeBrowserState>) {
      return flush(() => {
        const page = { ...pages.get(id)!, ...patch };
        pages.set(id, page);
        for (const receive of pageListeners) receive(page);
      });
    },
    viewportObservers,
    commits,
    actions,
    tabsActions,
    stateListeners,
    actionListeners,
    callbacks,
    flush,
    latest,
    get watches() {
      return watches;
    },
    get unwatches() {
      return unwatches;
    },
    set rejectPublish(value: boolean) {
      rejectPublish = value;
    },
    set holdNextPublication(value: boolean) {
      holdNextPublication = value;
    },
    rejectHeld: () => flush(() => rejectHeld(Error('old_scope_channel_failed'))),
    render: (props: Parameters<typeof Harness>[0] = {}) =>
      flush(() =>
        root.render(
          strict ? (
            <StrictMode>
              <Harness {...props} />
            </StrictMode>
          ) : (
            <Harness {...props} />
          ),
        ),
      ),
    async host(hosted = true, binding = attachment) {
      attachment = binding;
      await flush(() =>
        stateListeners.at(-1)!({
          attachment,
          pageToken,
          hosted,
          actionable: true,
          snapshot: latest(),
        }),
      );
    },
    async event(
      action: Pick<NativeBrowserChromeEvent, 'part'> & { action?: unknown },
      options: Partial<NativeBrowserChromeEvent> = {},
    ) {
      const event = {
        attachment,
        pageToken,
        sequence: ++sequence,
        revision: latest().revision,
        ...action,
        ...options,
      } as NativeBrowserChromeEvent;
      let accepted = false;
      await flush(() => {
        accepted = actionListeners.at(-1)!(event);
      });
      return accepted;
    },
    async close() {
      await act(() => root.unmount());
      restore();
      dom.window.close();
      Object.assign(globalThis, prior);
    },
  };
}

test('repeated Root effects clear only their own context revision while the replacement remains active', async () => {
  const f = await fixture(true, true, false, false, { draft: '00112233445566778899aabbccddeeff' });
  try {
    await f.render();
    const active = f.contexts.filter((value) => value.owner !== null);
    expect(active.length).toBeGreaterThanOrEqual(2);
    expect(
      f.contexts
        .filter((value) => value.owner === null)
        .every((value) => value.revision < active.at(-1)!.revision),
    ).toBe(true);
    expect(f.publicationContexts.at(-1)).toBe(active.at(-1)!.revision);
  } finally {
    await f.close();
  }
});

test('draft Chrome uses an explicit increasing presentation context and old cleanup cannot clear its replacement', async () => {
  const first = { draft: '00112233445566778899aabbccddeeff' },
    second = { draft: 'ffeeddccbbaa99887766554433221100' },
    f = await fixture(true, false, false, false, first);
  try {
    await f.render();
    const context = f.contexts.find((value) => value.owner !== null)!;
    expect(context.owner).toEqual(first);
    expect(f.latest().scope).toEqual(first);
    expect(f.latest().control).toBeUndefined();
    expect(f.latest().toolbar.notesAvailable).toBe(false);
    expect(f.publicationContexts.at(-1)).toBe(context.revision);
    const previous = f.latest(),
      oldReceive = f.stateListeners[0]!;
    await f.render({ presentationOwner: second });
    const replacement = f.contexts.filter((value) => value.owner !== null).at(-1)!;
    expect(replacement.owner).toEqual(second);
    expect(replacement.revision > context.revision).toBe(true);
    expect(
      f.contexts.some((value) => value.revision === context.revision && value.owner === null),
    ).toBe(true);
    await f.flush(() =>
      oldReceive({
        attachment: 'old-attachment',
        pageToken: 'old-page',
        hosted: true,
        actionable: true,
        snapshot: previous,
      }),
    );
    expect(f.latest().scope).toEqual(second);
    expect(f.publicationContexts.at(-1)).toBe(replacement.revision);
  } finally {
    await f.close();
  }
});

test('the real tab model prepares return from a newly navigated page and publishes the successor before closing the current page', async () => {
  const f = await fixture(true, false, true, true);
  try {
    await f.render();
    const first = f.model.active;
    await f.host();
    const original = document.querySelector('.native-browser-page');
    await f.flush(() => f.model.addBrowser());
    const second = f.model.active;
    expect(second).not.toBe(first);
    expect(f.latest().toolbar).toMatchObject({ id: second, hasPage: false });
    await f.flush(() => {
      void window.kiteNative!.browserRequest!({
        action: 'navigate',
        id: second,
        input: 'https://example.com/new-page',
      });
    });
    expect(f.latest().toolbar).toMatchObject({ id: second, loading: true, hasPage: true });
    await f.host(true, 'new-page-binding');
    for (const loading of [true, false]) {
      await f.updatePage(second, { loading });
      const boundary = f.timeline.length;
      await f.flush(() => f.model.select(first));
      expect(f.model.active).toBe(second);
      expect(f.preparations.at(-1)).toMatchObject({ fromId: second, targetId: first });
      await f.flush(() => f.preparations.at(-1)!.resolve({ key: `return-${loading}` }));
      expect(f.model.active).toBe(first);
      expect(
        f.timeline
          .slice(boundary)
          .filter((event) => event.kind === 'snapshot')
          .every((event) => event.value !== null),
      ).toBe(true);
      expect(document.querySelector('.native-browser-page')).toBe(original);
      await f.host(true, `original-${loading}`);
      await f.flush(() => f.model.select(second));
      await f.flush(() => f.preparations.at(-1)!.resolve({ key: `back-${loading}` }));
      await f.host(true, `new-${loading}`);
    }
    const boundary = f.timeline.length;
    await f.flush(() => f.model.closeTab(second));
    expect(f.model.active).toBe(second);
    expect(
      f.timeline
        .slice(boundary)
        .some((event) => event.kind === 'request' && event.value.action === 'close'),
    ).toBe(false);
    await f.flush(() => f.preparations.at(-1)!.resolve({ key: 'close-current' }));
    expect(f.model.active).toBe(first);
    expect(f.model.tabs.map((tab) => tab.id)).toEqual([first]);
    const events = f.timeline.slice(boundary);
    const offered = events.findIndex(
      (event) => event.kind === 'snapshot' && event.value?.toolbar.id === first,
    );
    const closed = events.findIndex(
      (event) =>
        event.kind === 'request' && event.value.action === 'close' && event.value.id === second,
    );
    expect(offered).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(offered);
    expect(events.some((event) => event.kind === 'snapshot' && event.value === null)).toBe(false);
    expect(
      events.filter((event) => event.kind === 'request' && event.value.action === 'close'),
    ).toHaveLength(1);
    expect(f.ports.has(second)).toBe(false);
  } finally {
    await f.close();
  }
});

test('retained real panes switch A-B-A without null Chrome snapshots and offer the new page before hiding the old one', async () => {
  const f = await fixture(true, false, true);
  try {
    await f.render();
    await f.host();
    const panes = [...document.querySelectorAll('.native-browser-page')];
    expect(panes).toHaveLength(ids.length);
    const original = f.ports.get(ids[0]!)!;
    const initialStates = f.timeline.filter(
      (event) => event.kind === 'request' && event.value.action === 'state',
    ).length;
    expect(initialStates).toBe(ids.length);
    expect(f.viewportObservers.size).toBe(1);
    expect(
      f.timeline.every(
        (event) =>
          event.kind !== 'request' || event.value.action !== 'present' || event.value.id === ids[0],
      ),
    ).toBe(true);
    for (const [previous, next] of [
      [ids[0]!, ids[1]!],
      [ids[1]!, ids[0]!],
    ] as const) {
      const boundary = f.timeline.length;
      const retired = f.ports.get(previous)!;
      await f.render({ active: next });
      const switching = f.timeline.slice(boundary);
      const snapshots = switching.filter((event) => event.kind === 'snapshot');
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.some((event) => event.value === null)).toBe(false);
      expect(snapshots.every((event) => event.value?.toolbar.id === next)).toBe(true);
      const offered = switching.findIndex(
        (event) => event.kind === 'snapshot' && event.value?.toolbar.id === next,
      );
      const hidden = switching.findIndex(
        (event) =>
          event.kind === 'request' &&
          event.value.action === 'present' &&
          event.value.id === previous &&
          event.value.bounds === null,
      );
      const hiddenPages = switching.flatMap((event) =>
        event.kind === 'request' && event.value.action === 'present' && event.value.bounds === null
          ? [event.value.id]
          : [],
      );
      expect(offered).toBeGreaterThanOrEqual(0);
      expect(hidden).toBeGreaterThan(offered);
      expect(hiddenPages).toEqual([previous]);
      expect(f.ports.size).toBe(ids.length);
      expect(f.viewportObservers.size).toBe(1);
      [...document.querySelectorAll('.native-browser-page')].forEach((node, index) => {
        expect(node).toBe(panes[index]!);
      });
      await f.host(true, `attachment-${next}`);
      const requests = f.timeline.filter((event) => event.kind === 'request').length;
      await f.flush(() => retired.dispatch({ type: 'reload' }));
      expect(f.timeline.filter((event) => event.kind === 'request')).toHaveLength(requests);
      expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
      expect(f.timeline.at(-1)).toMatchObject({
        kind: 'request',
        value: { action: 'reload', id: next },
      });
    }
    expect(
      f.timeline.filter((event) => event.kind === 'request' && event.value.action === 'state'),
    ).toHaveLength(initialStates);
    expect(f.ports.get(ids[0]!)!.data.id).toBe(original.data.id);
    const revision = Reflect.get(document, Symbol.for('kite.native.browser.presentationRevision'));
    const hiddenBoundary = f.timeline.length;
    await f.render({ covered: true });
    expect(f.viewportObservers.size).toBe(0);
    expect(Reflect.get(document, Symbol.for('kite.native.browser.presentationRevision'))).toBe(
      revision,
    );
    expect(
      f.timeline
        .slice(hiddenBoundary)
        .flatMap((event) =>
          event.kind === 'request' && event.value.action === 'present'
            ? [{ id: event.value.id, bounds: event.value.bounds }]
            : [],
        ),
    ).toEqual([{ id: ids[0]!, bounds: null }]);
    const inactiveBoundary = f.timeline.length;
    await f.render({ covered: true, title: 'Background title' });
    await f.flush(() => window.dispatchEvent(new Event('resize')));
    expect(
      f.timeline
        .slice(inactiveBoundary)
        .some((event) => event.kind === 'request' && event.value.action === 'present'),
    ).toBe(false);
    expect(Reflect.get(document, Symbol.for('kite.native.browser.presentationRevision'))).toBe(
      revision,
    );
    await f.render();
    expect(f.viewportObservers.size).toBe(1);
    expect(
      Number(Reflect.get(document, Symbol.for('kite.native.browser.presentationRevision'))),
    ).toBeGreaterThan(Number(revision));
    const retiredScope = f.ports.get(ids[0]!)!;
    await f.render({ currentScope: { ...scope, generation: 2 } });
    expect((f.latest().scope as NativeBrowserRestoreScope).generation).toBe(2);
    expect(f.ports.size).toBe(ids.length);
    const requests = f.timeline.filter((event) => event.kind === 'request').length;
    await f.flush(() => retiredScope.dispatch({ type: 'reload' }));
    expect(f.timeline.filter((event) => event.kind === 'request')).toHaveLength(requests);
  } finally {
    await f.close();
    expect(f.ports.size).toBe(0);
    expect(f.viewportObservers.size).toBe(0);
  }
});

test('eight mounted page ports publish only the active browser and acknowledge hosted after the Root commit', async () => {
  const f = await fixture();
  try {
    await f.render();
    expect(f.latest()).toMatchObject({
      scope,
      hosted: false,
      toolbar: { id: ids[0] },
      control: { id: ids[0] },
    });
    expect(f.watches).toBe(2);
    await f.host();
    expect(f.latest().hosted).toBe(true);
    expect(
      f.commits
        .filter(({ snapshot }) => snapshot.hosted)
        .every(({ hostedDOM }) => hostedDOM === 'true'),
    ).toBe(true);
    expect(document.querySelectorAll('[data-page][data-hosted="true"]')).toHaveLength(1);
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
    expect(f.actions).toEqual([{ id: ids[0]!, action: { type: 'reload' } }]);
    const callback = f.callbacks.get(ids[0]!)![0];
    await f.render({ title: 'New title' });
    expect(f.callbacks.get(ids[0]!)!.every((value) => value === callback)).toBe(true);
    await f.render({ active: ids[1] });
    expect(f.latest().toolbar.id).toBe(ids[1]!);
    expect(f.latest().control?.id).toBe(ids[1]);
    expect(f.latest().hosted).toBe(false);
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(false);
    await f.host(true, 'attachment-2');
    expect(
      await f.event({
        part: 'control',
        action: { type: 'show-menu', anchor: { x: 600, y: 20, width: 30, height: 25 } },
      }),
    ).toBe(true);
    expect(f.actions.at(-1)?.id).toBe(ids[1]);
    expect(JSON.stringify(f.latest())).not.toContain('dispatch');
  } finally {
    await f.close();
  }
});

test('address edits accept an earlier current-binding revision, then echo committed data even for an equal value', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const old = f.latest().revision;
    await f.render({ title: 'New title' });
    expect(f.latest().revision).toBeGreaterThan(old);
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } }, { revision: old })).toBe(
      false,
    );
    expect(
      await f.event(
        { part: 'toolbar', action: { type: 'address-change', value: 'https://example.com/new' } },
        { revision: old },
      ),
    ).toBe(true);
    expect(f.latest().toolbar.address).toBe('https://example.com/new');
    const changed = f.latest().revision;
    expect(
      await f.event({
        part: 'toolbar',
        action: { type: 'address-change', value: 'https://example.com/new' },
      }),
    ).toBe(true);
    expect(f.latest().revision).toBeGreaterThan(changed);
    expect(await f.event({ part: 'toolbar', action: { type: 'navigate' } })).toBe(true);
    expect(f.actions.at(-1)?.action.type).toBe('navigate');
    const beforeBatch = f.latest();
    let first = false,
      second = false,
      prematureNavigation = true;
    await f.flush(() => {
      const base = {
        attachment: 'attachment-1',
        pageToken: 'token-1',
        revision: beforeBatch.revision,
      };
      const dispatch = f.actionListeners.at(-1)!;
      first = dispatch({
        ...base,
        sequence: 100,
        part: 'toolbar',
        action: { type: 'address-change', value: 'https://example.com/temporary' },
      });
      second = dispatch({
        ...base,
        sequence: 101,
        part: 'toolbar',
        action: { type: 'address-change', value: beforeBatch.toolbar.address },
      });
      prematureNavigation = dispatch({
        ...base,
        sequence: 102,
        part: 'toolbar',
        action: { type: 'navigate' },
      });
    });
    expect([first, second, prematureNavigation]).toEqual([true, true, false]);
    expect(f.latest().revision).toBeGreaterThan(beforeBatch.revision);
    expect(f.latest().toolbar.address).toBe(beforeBatch.toolbar.address);
    expect(
      f.publications.some(
        (snapshot) => snapshot?.toolbar.address === 'https://example.com/temporary',
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('scope, attachment, sequence and exact revision reject late callbacks without invoking old handlers', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const oldState = f.stateListeners.at(-1)!,
      oldAction = f.actionListeners.at(-1)!,
      original = f.latest();
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } }, { sequence: 20 })).toBe(
      true,
    );
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } }, { sequence: 20 })).toBe(
      false,
    );
    await f.host(true, 'attachment-2');
    await f.flush(() =>
      oldState({
        attachment: 'attachment-1',
        pageToken: 'token-1',
        hosted: true,
        actionable: true,
        snapshot: original,
      }),
    );
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
    const count = f.actions.length;
    await f.render({ currentScope: { ...scope, generation: 2 } });
    expect((f.latest().scope as NativeBrowserRestoreScope).generation).toBe(2);
    expect(
      oldAction({
        attachment: 'attachment-2',
        pageToken: 'token-1',
        sequence: 50,
        revision: original.revision,
        part: 'toolbar',
        action: { type: 'reload' },
      }),
    ).toBe(false);
    expect(f.actions).toHaveLength(count);
    expect(f.unwatches).toBe(2);
  } finally {
    await f.close();
  }
});

test('freshness, notes, nonbrowser tabs and Root overlays withdraw action admission and restore local headers', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    await f.render({ interactive: false });
    expect(f.latest()).toMatchObject({ interactive: false, hosted: true });
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(false);
    await f.render({ notesOpen: true });
    expect(f.latest()).toMatchObject({ hosted: false, toolbar: { notesOpen: true } });
    expect(document.querySelector<HTMLElement>('#headers')?.dataset.hosted).toBe('false');
    await f.render();
    await f.host();
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.dataset.box = '[550,100,500,400]';
    await f.flush(() => document.body.append(overlay));
    expect(f.latest()).toMatchObject({ covered: true, hosted: false });
    expect(await f.event({ part: 'tabs', action: { type: 'add' } })).toBe(false);
    await f.flush(() => overlay.remove());
    await f.render({ nonbrowser: true });
    expect(f.publications.at(-1)).toBeNull();
    expect(document.querySelector<HTMLElement>('#headers')?.dataset.hosted).toBe('false');
  } finally {
    await f.close();
  }
});

test('Root Escape preserves capture priority and focus-root avoids the physically cropped browser region', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const order: string[] = [];
    const capture = (event: KeyboardEvent) => {
      if (event.type === 'keydown') {
        order.push('menu');
        event.stopImmediatePropagation();
      }
    };
    const notes = () => order.push('notes');
    const sidebar = () => order.push('sidebar');
    window.addEventListener('keydown', capture, true);
    document.addEventListener('keydown', notes);
    window.addEventListener('keydown', sidebar);
    expect(await f.event({ part: 'escape' })).toBe(true);
    expect(order).toEqual(['menu']);
    window.removeEventListener('keydown', capture, true);
    expect(await f.event({ part: 'escape' })).toBe(true);
    expect(order).toEqual(['menu', 'notes', 'sidebar']);
    document.removeEventListener('keydown', notes);
    window.removeEventListener('keydown', sidebar);
    expect(await f.event({ part: 'focus-root' })).toBe(true);
    expect(document.activeElement?.id).toBe('main-input');
    await f.flush(() => {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.dataset.windowMaterial = 'vibrancy';
    });
    expect(f.latest()).toMatchObject({ theme: 'dark', material: 'vibrancy' });
  } finally {
    await f.close();
  }
});

test('a left-side popover preserves delegated Chrome while intersecting or global coverage restores Root', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const popover = document.createElement('div');
    popover.dataset.slot = 'popover-content';
    popover.dataset.box = '[100,100,300,200]';
    const revision = f.latest().revision;
    await f.flush(() => document.body.append(popover));
    expect(f.latest()).toMatchObject({ covered: false, hosted: true });
    expect(f.latest().revision).toBe(revision);
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
    await f.flush(() => {
      popover.dataset.box = '[590,100,100,200]';
      popover.hidden = true;
    });
    expect(f.latest()).toMatchObject({ covered: false, hosted: true });
    await f.flush(() => {
      popover.hidden = false;
    });
    expect(f.latest()).toMatchObject({ covered: true, hosted: false });
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(false);
    await f.flush(() => popover.remove());
    await f.render({ covered: true });
    expect(f.latest()).toMatchObject({ covered: true, hosted: false });
    expect(document.querySelector<HTMLElement>('#headers')?.dataset.hosted).toBe('false');
  } finally {
    await f.close();
  }
});

test('a visible overlay is conservative when the right panel has no qualified rectangle', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const popover = document.createElement('div');
    popover.dataset.slot = 'popover-content';
    popover.dataset.box = '[100,100,300,200]';
    popover.hidden = true;
    await f.flush(() => {
      document.querySelector<HTMLElement>('.session-tabs')!.dataset.box = '[0,0,0,0]';
      document.body.append(popover);
    });
    expect(f.latest()).toMatchObject({ covered: false, hosted: true });
    await f.flush(() => {
      popover.hidden = false;
    });
    expect(f.latest()).toMatchObject({ covered: true, hosted: false });
    expect(await f.event({ part: 'tabs', action: { type: 'collapse' } })).toBe(false);
  } finally {
    await f.close();
  }
});

test('missing preload methods leave all original headers active and create no presentation subscriptions', async () => {
  const f = await fixture(false);
  try {
    await f.render();
    expect(f.publications).toHaveLength(0);
    expect(f.watches).toBe(0);
    expect(document.querySelector<HTMLElement>('#headers')?.dataset.hosted).toBe('false');
  } finally {
    await f.close();
  }
});

test('a late failed publication from the old scope cannot withdraw the newly attached Root', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    f.holdNextPublication = true;
    await f.render({ title: 'Old scope pending' });
    await f.render({ currentScope: { ...scope, generation: 2 } });
    const count = f.publications.length;
    await f.rejectHeld();
    expect(f.publications).toHaveLength(count);
    expect((f.publications.at(-1)?.scope as NativeBrowserRestoreScope).generation).toBe(2);
    await f.host(true, 'fresh-scope-attachment');
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
  } finally {
    await f.close();
  }
});

test('repeated Root effects rebuild subscriptions and publish a fresh snapshot before hosting again', async () => {
  const f = await fixture(true, true);
  try {
    await f.render();
    const positive = f.publications.filter((value) => value !== null);
    expect(positive.length).toBeGreaterThanOrEqual(2);
    expect(positive.at(-1)!.revision).toBeGreaterThan(positive[0]!.revision);
    expect(f.watches).toBe(4);
    expect(f.unwatches).toBe(2);
    await f.host();
    expect(f.latest().hosted).toBe(true);
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
    expect(f.actions).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('bounded resize history fences ambiguous attachments and never revives evicted old revisions', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const before = f.latest();
    await f.flush(() => {
      for (let index = 0; index < 128; index++)
        f.stateListeners.at(-1)!({
          attachment: `resize-${index}`,
          pageToken: 'token-1',
          hosted: true,
          actionable: true,
          snapshot: before,
        });
    });
    expect(f.latest().revision).toBeGreaterThan(before.revision);
    expect(f.latest().hosted).toBe(true);
    // More than the recent-token capacity arrived before Root could commit a
    // new revision. Even its last accepted old attachment is now action-fenced.
    expect(
      await f.event({ part: 'toolbar', action: { type: 'reload' } }, { attachment: 'resize-64' }),
    ).toBe(false);
    await f.host(true, 'resize-127');
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
    await f.flush(() =>
      f.stateListeners.at(-1)!({
        attachment: 'attachment-1',
        pageToken: 'token-1',
        hosted: true,
        actionable: true,
        snapshot: before,
      }),
    );
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
    const oldRevision = f.latest().revision;
    for (let index = 0; index < 70; index++) await f.render({ title: `Title ${index}` });
    expect(f.latest().revision - oldRevision).toBeGreaterThan(128);
    expect(
      await f.event(
        { part: 'toolbar', action: { type: 'address-change', value: 'https://example.com/old' } },
        { revision: oldRevision },
      ),
    ).toBe(false);
    expect(
      await f.event({
        part: 'toolbar',
        action: { type: 'address-change', value: 'https://example.com/current' },
      }),
    ).toBe(true);
    expect(f.latest().toolbar.address).toBe('https://example.com/current');
    expect(
      f.actions.some(
        ({ action }) =>
          action.type === 'address-change' && action.value === 'https://example.com/old',
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('an ordinary geometry attachment keeps the current revision without a redundant Root publication', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const before = f.latest(),
      count = f.publications.length;
    await f.host(true, 'ordinary-resize');
    expect(f.latest().revision).toBe(before.revision);
    expect(f.publications).toHaveLength(count);
    expect(f.latest().hosted).toBe(true);
    expect(await f.event({ part: 'toolbar', action: { type: 'reload' } })).toBe(true);
  } finally {
    await f.close();
  }
});

test('a same-tab new page binding acknowledges its own committed header with a fresh revision', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.host();
    const previous = f.latest();
    await f.flush(() =>
      f.stateListeners.at(-1)!({
        attachment: 'new-document',
        pageToken: 'new-document-token',
        hosted: true,
        actionable: false,
        snapshot: { ...previous, hosted: false },
      }),
    );
    const fresh = f.latest();
    expect(fresh.revision).toBeGreaterThan(previous.revision);
    expect(fresh.hosted).toBe(true);
    expect(f.commits.at(-1)?.hostedDOM).toBe('true');
    expect(
      await f.event(
        { part: 'toolbar', action: { type: 'reload' } },
        {
          attachment: 'attachment-1',
          pageToken: 'token-1',
          revision: previous.revision,
        },
      ),
    ).toBe(false);
    await f.flush(() =>
      f.stateListeners.at(-1)!({
        attachment: 'new-document',
        pageToken: 'new-document-token',
        hosted: true,
        actionable: true,
        snapshot: fresh,
      }),
    );
    expect(
      await f.event(
        { part: 'toolbar', action: { type: 'reload' } },
        {
          attachment: 'new-document',
          pageToken: 'new-document-token',
          revision: fresh.revision,
        },
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
