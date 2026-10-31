import type { SessionTabsChromePresentation } from '@kite-ai/ui/desktop';
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { NativeBrowserRestoreScope } from './native-browser-bridge';
import {
  isNativeBrowserChromeEnvelope,
  isNativeBrowserChromeEvent,
  isNativeBrowserChromeSnapshot,
  type NativeBrowserChromeEnvelope,
  type NativeBrowserChromeEvent,
  type NativeBrowserChromeRootBridge,
  type NativeBrowserChromeSnapshot,
} from './native-browser-chrome-bridge';
import type {
  NativeBrowserControlPort,
  NativeBrowserToolbarPort,
} from './native-browser-chrome-types';

const revisionKey = Symbol.for('kite.native.browser.chromeRevision');
const recentRevisionLimit = 128;
const recentBindingLimit = 64;
const scopeKey = (scope: NativeBrowserRestoreScope | undefined) =>
  scope
    ? JSON.stringify([scope.storeId, scope.sessionId, scope.generation, scope.viewSelection])
    : '';
const overlays =
  '[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-slot="sheet-overlay"], [data-slot="popover-content"], [role="menu"], [role="dialog"], dialog[open], [data-native-browser-overlay]';
function visibleBox(node: HTMLElement) {
  if (!node.isConnected || node.closest('[hidden], [aria-hidden="true"], [inert]')) return;
  const style = getComputedStyle(node),
    box = node.getBoundingClientRect();
  if (
    [box.left, box.top, box.right, box.bottom, box.width, box.height].every(Number.isFinite) &&
    style.display !== 'none' &&
    !['hidden', 'collapse'].includes(style.visibility) &&
    box.width > 0 &&
    box.height > 0 &&
    box.right > 0 &&
    box.bottom > 0 &&
    box.left < window.innerWidth &&
    box.top < window.innerHeight
  )
    return box;
  return undefined;
}
function rootCovered() {
  const right = [...document.querySelectorAll<HTMLElement>('.session-tabs.right-sidebar')]
    .map(visibleBox)
    .filter((box): box is DOMRect => !!box);
  const panel = right.length === 1 ? right[0] : undefined;
  return [...document.querySelectorAll<HTMLElement>(overlays)].some((node) => {
    const box = visibleBox(node);
    return (
      !!box &&
      (!panel ||
        (box.left < panel.right &&
          box.right > panel.left &&
          box.top < panel.bottom &&
          box.bottom > panel.top))
    );
  });
}
function focusRoot() {
  const panel = [...document.querySelectorAll<HTMLElement>('.session-tabs.right-sidebar')].find(
    (node) => visibleBox(node),
  );
  const limit = panel?.getBoundingClientRect().left ?? window.innerWidth;
  const candidates = document.querySelectorAll<HTMLElement>(
    '.prompt-editor[contenteditable="true"], button[aria-controls="navigation"], button[aria-controls="session-tabs"]',
  );
  for (const node of candidates) {
    const box = visibleBox(node);
    if (!box || box.right > limit + 1 || node.matches(':disabled, [aria-disabled="true"]'))
      continue;
    node.focus({ preventScroll: true });
    if (document.activeElement === node) return true;
  }
  return false;
}
function nextRevision() {
  const previous: unknown = Reflect.get(document, revisionKey) ?? 0;
  const next = Number(previous) + 1;
  if (!Number.isSafeInteger(previous) || Number(previous) < 0 || !Number.isSafeInteger(next))
    throw Error('browser_chrome_revision_unavailable');
  Object.defineProperty(document, revisionKey, { value: next, configurable: true });
  return next;
}

type RootContext = { key: string; interactive: boolean; covered: boolean };
/** The original Root owns every callback; only selected, validated display data leaves this store. */
class BrowserChromeRoot {
  private active = false;
  private failed = false;
  private tabs?: SessionTabsChromePresentation;
  private readonly toolbars = new Map<string, NativeBrowserToolbarPort>();
  private readonly controls = new Map<string, NativeBrowserControlPort>();
  private readonly toolbarCallbacks = new Map<
    string,
    (port: NativeBrowserToolbarPort | undefined) => void
  >();
  private readonly controlCallbacks = new Map<
    string,
    (port: NativeBrowserControlPort | undefined) => void
  >();
  private readonly listeners = new Set<() => void>();
  private change = 0;
  private readonly retiredBindings = new Map<string, number>();
  private retiredRevisionFloor = 0;
  private revisionFloor = 0;
  private stateRevision = 0;
  private bindingFloor = 0;
  private binding = '';
  private forcePublication = false;
  private bindingUncertain = false;
  private echo?: { value: string; committed: boolean };
  private envelope?: NativeBrowserChromeEnvelope;
  private committedHosted = '';
  private lastHosted = '';
  private lastPayload?: string;
  private snapshot?: NativeBrowserChromeSnapshot;
  private readonly revisions = new Set<number>();
  private page = '';
  private sequence = 0;
  private stopState?: () => void;
  private stopActions?: () => void;
  private mutations?: MutationObserver;

  private readonly bridge: NativeBrowserChromeRootBridge | undefined;
  private readonly scope: NativeBrowserRestoreScope | undefined;
  private readonly current: () => RootContext;
  constructor(
    bridge: NativeBrowserChromeRootBridge | undefined,
    scope: NativeBrowserRestoreScope | undefined,
    current: () => RootContext,
  ) {
    this.bridge = bridge;
    this.scope = scope;
    this.current = current;
  }
  private live() {
    return (
      this.active && !this.failed && !!this.scope && this.current().key === scopeKey(this.scope)
    );
  }
  private retireBinding() {
    if (!this.binding) return;
    this.retiredBindings.set(
      this.binding,
      Math.max(this.stateRevision, this.snapshot?.revision ?? 0),
    );
    while (this.retiredBindings.size > recentBindingLimit) {
      const oldest = this.retiredBindings.entries().next().value!;
      this.retiredBindings.delete(oldest[0]);
      // Dropping an opaque token can only narrow admission. A later unseen
      // binding must carry newer Main-echoed Root facts before it can act.
      this.retiredRevisionFloor = Math.max(this.retiredRevisionFloor, oldest[1]);
    }
  }
  private rememberRevision(revision: number) {
    this.revisions.add(revision);
    while (this.revisions.size > recentRevisionLimit) {
      const oldest = this.revisions.values().next().value!;
      this.revisions.delete(oldest);
      this.revisionFloor = Math.max(this.revisionFloor, oldest);
    }
  }
  private requestRevisionBoundary() {
    this.forcePublication = true;
    this.changed(true);
  }
  private selected() {
    const tabs = this.tabs,
      tab = tabs?.data.tabs.find((tab) => tab.id === tabs.data.active),
      toolbar = tab && this.toolbars.get(tab.id);
    if (
      !tabs?.data.visible ||
      !tabs.data.present ||
      tab?.kind !== 'browser' ||
      !toolbar ||
      toolbar.data.id !== tab.id
    )
      return;
    return { tabs, toolbar, control: this.controls.get(tab.id) };
  }
  private eligible() {
    const selected = this.selected();
    return (
      this.live() &&
      !this.current().covered &&
      !rootCovered() &&
      selected?.toolbar.data.hasPage &&
      !selected.toolbar.data.notesOpen
    );
  }
  readonly getHosted = () =>
    this.eligible() && this.envelope?.hosted ? this.selected()!.toolbar.data.id : '';
  readonly subscribe = (receive: () => void) => {
    this.listeners.add(receive);
    return () => this.listeners.delete(receive);
  };
  readonly getChange = () => this.change;
  private changed(force = false) {
    const next = this.getHosted();
    if (next === this.lastHosted && !force) return;
    this.lastHosted = next;
    this.change++;
    for (const receive of this.listeners) receive();
  }
  readonly toolbar = (id: string) => {
    let callback = this.toolbarCallbacks.get(id);
    if (!callback) {
      callback = (port) => {
        if (port?.data.id === id) this.toolbars.set(id, port);
        else this.toolbars.delete(id);
        this.refresh();
      };
      this.toolbarCallbacks.set(id, callback);
    }
    return callback;
  };
  readonly control = (id: string) => {
    let callback = this.controlCallbacks.get(id);
    if (!callback) {
      callback = (port) => {
        if (port?.data.id === id) this.controls.set(id, port);
        else this.controls.delete(id);
        this.refresh();
      };
      this.controlCallbacks.set(id, callback);
    }
    return callback;
  };
  readonly registerTabs = (port: SessionTabsChromePresentation | null) => {
    this.tabs = port ?? undefined;
    this.refresh();
  };
  start() {
    this.active = true;
    if (!this.bridge) return;
    try {
      this.stopState = this.bridge.watchBrowserChromeState((value) => this.receive(value));
      this.stopActions = this.bridge.watchBrowserChromeAction((event) => {
        try {
          return this.dispatch(event);
        } catch {
          return false;
        }
      });
      this.mutations = new MutationObserver(() => this.refresh());
      this.mutations.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['hidden', 'inert', 'aria-hidden', 'style', 'class', 'open', 'data-state'],
      });
      this.mutations.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-window-material'],
      });
      this.refresh();
    } catch {
      this.fail();
    }
  }
  stop() {
    this.active = false;
    this.envelope = undefined;
    this.snapshot = undefined;
    this.echo = undefined;
    this.lastPayload = undefined;
    this.committedHosted = '';
    this.retireBinding();
    this.binding = '';
    this.forcePublication = false;
    this.bindingUncertain = false;
    this.sequence = 0;
    this.revisions.clear();
    this.stopState?.();
    this.stopActions?.();
    this.mutations?.disconnect();
    if (this.bridge) void this.bridge.publishBrowserChrome(null).catch(() => {});
  }
  private fail() {
    if (this.failed || !this.active || this.current().key !== scopeKey(this.scope)) return;
    this.failed = true;
    this.envelope = undefined;
    this.snapshot = undefined;
    this.echo = undefined;
    this.forcePublication = false;
    this.lastPayload = 'null';
    this.changed();
    if (this.bridge) void this.bridge.publishBrowserChrome(null).catch(() => {});
  }
  refresh(force = false) {
    this.changed();
    if (!this.active || !this.bridge || this.current().key !== scopeKey(this.scope)) return;
    const selected = this.selected(),
      context = this.current();
    const data =
      this.live() && selected
        ? {
            scope: this.scope!,
            theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
            material: document.documentElement.dataset.windowMaterial,
            interactive: context.interactive,
            covered: context.covered || rootCovered(),
            hosted: this.committedHosted === selected.toolbar.data.id && this.eligible(),
            tabs: selected.tabs.data,
            toolbar: selected.toolbar.data,
            ...(selected.control?.data.id === selected.toolbar.data.id
              ? { control: selected.control.data }
              : {}),
          }
        : null;
    const payload = JSON.stringify(data);
    const echo = this.echo?.committed && this.echo.value === selected?.toolbar.data.address;
    if (payload === this.lastPayload && !echo && !force) return;
    this.lastPayload = payload;
    try {
      const snapshot: unknown = data ? { ...JSON.parse(payload), revision: nextRevision() } : null;
      if (snapshot !== null && !isNativeBrowserChromeSnapshot(snapshot)) {
        this.fail();
        return;
      }
      const page = snapshot?.toolbar.id ?? '';
      if (page !== this.page) {
        this.retireBinding();
        this.binding = '';
        this.bindingUncertain = false;
        this.page = page;
        this.envelope = undefined;
        this.echo = undefined;
        this.sequence = 0;
        this.revisions.clear();
        this.changed();
      }
      this.snapshot = snapshot ?? undefined;
      if (snapshot) this.rememberRevision(snapshot.revision);
      if (echo) this.echo = undefined;
      void this.bridge.publishBrowserChrome(snapshot).catch(() => this.fail());
    } catch {
      this.fail();
    }
  }
  /** Root header props have committed before Main receives hosted acknowledgement. */
  commitHosted(id: string) {
    this.committedHosted = id === this.getHosted() ? id : '';
    if (this.echo) this.echo.committed = true;
    const force = this.forcePublication;
    this.forcePublication = false;
    this.refresh(force);
  }
  private receive(value: NativeBrowserChromeEnvelope | null) {
    if (!this.live()) return;
    if (value === null) {
      this.envelope = undefined;
      this.changed();
      return;
    }
    if (
      !isNativeBrowserChromeEnvelope(value) ||
      scopeKey(value.snapshot.scope) !== scopeKey(this.scope) ||
      value.snapshot.toolbar.id !== this.page ||
      value.snapshot.tabs.active !== this.page ||
      value.snapshot.revision <= this.revisionFloor ||
      value.snapshot.revision < this.stateRevision ||
      !this.revisions.has(value.snapshot.revision)
    )
      return;
    const binding = JSON.stringify([value.attachment, value.pageToken]);
    if (this.retiredBindings.has(binding)) return;
    if (this.binding !== binding) {
      if (value.snapshot.revision <= this.retiredRevisionFloor) {
        this.bindingUncertain = true;
        this.requestRevisionBoundary();
        return;
      }
      this.retireBinding();
      this.binding = binding;
      this.echo = undefined;
      this.sequence = 0;
      this.bindingFloor = value.snapshot.revision;
      this.bindingUncertain = false;
      // A new page binding needs a fresh committed acknowledgement even if
      // the visible header did not change. Geometry-only attachments retain
      // hosted=true and do not add a Root publication.
      if (!value.snapshot.hosted || value.snapshot.revision <= this.retiredRevisionFloor)
        this.forcePublication = true;
    }
    this.stateRevision = value.snapshot.revision;
    this.envelope = value;
    this.changed(this.forcePublication);
  }
  private dispatch(event: NativeBrowserChromeEvent) {
    const envelope = this.envelope,
      snapshot = this.snapshot,
      selected = this.selected();
    if (
      !this.live() ||
      this.bindingUncertain ||
      !isNativeBrowserChromeEvent(event) ||
      !this.current().interactive ||
      !this.eligible() ||
      !envelope?.hosted ||
      !envelope.actionable ||
      !snapshot?.hosted ||
      !selected ||
      document.hidden ||
      event.attachment !== envelope.attachment ||
      event.pageToken !== envelope.pageToken ||
      event.sequence <= this.sequence ||
      event.revision < this.bindingFloor ||
      event.revision <= this.revisionFloor ||
      !this.revisions.has(event.revision)
    )
      return false;
    const editing =
      event.part === 'toolbar' && ['address-change', 'address-focus'].includes(event.action.type);
    if (!editing && event.revision !== snapshot.revision) return false;
    if (!editing && this.echo) return false;
    this.sequence = event.sequence;
    switch (event.part) {
      case 'tabs': {
        const action = event.action;
        if (
          (action.type === 'select' || action.type === 'close') &&
          !selected.tabs.data.tabs.some((tab) => tab.id === action.id)
        )
          return false;
        selected.tabs.dispatch(action);
        return true;
      }
      case 'toolbar':
        if (event.action.type === 'address-change') {
          if (!selected.toolbar.data.canNavigate) return false;
          this.echo = { value: event.action.value, committed: false };
        }
        selected.toolbar.dispatch(event.action);
        if (event.action.type === 'address-change') this.changed(true);
        return true;
      case 'control':
        if (!selected.control || selected.control.data.id !== this.page) return false;
        selected.control.dispatch(event.action);
        return true;
      case 'escape':
        for (const type of ['keydown', 'keyup'])
          document.dispatchEvent(
            new KeyboardEvent(type, { key: 'Escape', bubbles: true, cancelable: true }),
          );
        return true;
      case 'focus-root':
        return focusRoot();
    }
  }
}

/** Optional presentation transport. Unsupported preloads retain the complete original Root UI. */
export function useNativeBrowserChromeRoot(
  scope: NativeBrowserRestoreScope | undefined,
  options: { interactive: boolean; covered: boolean },
) {
  const candidate = window.kiteNative as
    | (typeof window.kiteNative & Partial<NativeBrowserChromeRootBridge>)
    | undefined;
  const bridge =
    typeof candidate?.publishBrowserChrome === 'function' &&
    typeof candidate.watchBrowserChromeState === 'function' &&
    typeof candidate.watchBrowserChromeAction === 'function'
      ? (candidate as typeof candidate & NativeBrowserChromeRootBridge)
      : undefined;
  const key = scopeKey(scope);
  const ownedScope = useMemo(() => {
    if (!key) return;
    const [storeId, sessionId, generation, viewSelection] = JSON.parse(key) as [
      string,
      string,
      number,
      number,
    ];
    return { storeId, sessionId, generation, viewSelection };
  }, [key]);
  const current = useRef<RootContext>({ key, ...options });
  current.current = { key, ...options };
  const owner = useMemo(
    () => new BrowserChromeRoot(bridge, ownedScope, () => current.current),
    [bridge, ownedScope],
  );
  useSyncExternalStore(owner.subscribe, owner.getChange, () => 0);
  const hosted = owner.getHosted();
  useLayoutEffect(() => {
    owner.start();
    return () => owner.stop();
  }, [owner]);
  useLayoutEffect(() => owner.commitHosted(hosted));
  return useMemo(
    () => ({
      toolbar: owner.toolbar,
      control: owner.control,
      tabs: owner.registerTabs,
      hosted: (id: string) => hosted === id,
      tabsHosted: !!hosted,
    }),
    [owner, hosted],
  );
}
