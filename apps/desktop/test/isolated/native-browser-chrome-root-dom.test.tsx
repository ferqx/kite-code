import { expect, test } from 'bun:test';
import type { SessionTabsChromePresentation } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { NativeBrowserRestoreScope } from '../../src/native-browser-bridge';
import type {
  NativeBrowserChromeEnvelope,
  NativeBrowserChromeEvent,
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
async function fixture(supported = true, strict = false) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
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
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const box = JSON.parse(this.dataset.box ?? '[0,0,0,0]') as [number, number, number, number];
    return new dom.window.DOMRect(...box);
  };
  const { createRoot } = await import('react-dom/client');
  const { useNativeBrowserChromeRoot } = await import('../../src/native-browser-chrome-root');
  const root = createRoot(document.getElementById('root')!);
  const publications: (NativeBrowserChromeSnapshot | null)[] = [],
    commits: { snapshot: NativeBrowserChromeSnapshot; hostedDOM: string | undefined }[] = [],
    actions: { id: string; action: NativeBrowserToolbarAction | NativeBrowserControlAction }[] = [],
    tabsActions: Parameters<SessionTabsChromePresentation['dispatch']>[0][] = [],
    stateListeners: ((value: NativeBrowserChromeEnvelope | null) => void)[] = [],
    actionListeners: ((event: NativeBrowserChromeEvent) => boolean)[] = [];
  let watches = 0,
    unwatches = 0,
    rejectPublish = false,
    holdNextPublication = false;
  let rejectHeld!: (cause: Error) => void;
  const rootBridge: NativeBrowserChromeRootBridge = {
    async publishBrowserChrome(snapshot) {
      publications.push(snapshot);
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
  Object.assign(window, { kiteNative: supported ? rootBridge : {} });
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
          notesAvailable: true,
          notesOpen,
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
    useEffect(() => registerControl(control), [control, registerControl]);
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
  }: {
    currentScope?: NativeBrowserRestoreScope;
    interactive?: boolean;
    covered?: boolean;
    active?: string;
    notesOpen?: boolean;
    title?: string;
    nonbrowser?: boolean;
  }) {
    const chrome = useNativeBrowserChromeRoot(currentScope, { interactive, covered });
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
    useLayoutEffect(() => chrome.tabs(tabs), [chrome.tabs, tabs]);
    useLayoutEffect(() => () => chrome.tabs(null), [chrome.tabs]);
    const toolbar = useCallback((id: string) => chrome.toolbar(id), [chrome.toolbar]);
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
    expect(f.latest().scope.generation).toBe(2);
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
    expect(f.publications.at(-1)?.scope.generation).toBe(2);
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
