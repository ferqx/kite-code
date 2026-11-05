import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AgentClient, SessionView } from '@kite-ai/client';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createBrowserGrantRequestId } from '../../../service/src/desktop-browser-authorization';
import {
  type BrowserGrantScope,
  type BrowserPagePort,
  NativeBrowserPageHost,
  serializeBrowserPageFailure,
} from '../../electron/browser-page-host';
import { NativeCaller } from '../../electron/native-caller';
import type { NativeState } from '../../src/native-bridge';
import {
  type NativeBrowserRestoreResult,
  nativeBrowserChannel,
} from '../../src/native-browser-bridge';
import { FakePlainView } from '../native-plain-view.fixture';
import { memoryPrivateData } from '../private-data.fixture';

const views: View[] = [];
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let initialization: ReturnType<typeof deferred> | undefined;
class Contents extends EventEmitter {
  destroyed = false;
  loads = 0;
  url = '';
  pid = 0;
  attached = false;
  formValue = '';
  cssRemovals = 0;
  readonly cdp: { method: string; params: Record<string, unknown> }[] = [];
  readonly debugger = Object.assign(new EventEmitter(), {
    isAttached: () => this.attached,
    attach: () => {
      if (this.pid <= 0) throw Error('renderer_not_ready');
      this.attached = true;
    },
    detach: () => {
      this.attached = false;
    },
    sendCommand: async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      this.cdp.push({ method, params });
      return { result: { type: 'number', value: 1 } };
    },
  });
  readonly mainFrame = { url: 'http://localhost/' };
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return false;
  }
  getZoomFactor() {
    return 1;
  }
  frame?: (image: Electron.NativeImage) => void;
  beginFrameSubscription(_onlyDirty: boolean, receive: (image: Electron.NativeImage) => void) {
    this.frame = receive;
  }
  endFrameSubscription() {
    this.frame = undefined;
  }
  invalidate() {
    const view = nativeWindow?.contentView.children.find((child) => child.webContents === this);
    if (!view?.getVisible()) return;
    const { width, height } = view.getBounds();
    this.frame?.({
      isEmpty: () => width === 0 || height === 0,
      getSize: () => ({ width, height }),
    } as Electron.NativeImage);
  }
  setWindowOpenHandler() {}
  executeJavaScriptInIsolatedWorld() {
    return Promise.resolve();
  }
  async insertCSS() {
    return 'annotation-key';
  }
  async removeInsertedCSS() {
    this.cssRemovals++;
  }
  async loadURL(url: string) {
    this.loads++;
    await initialization?.promise;
    if (this.destroyed) throw Error('initialization_destroyed');
    let prevented = false;
    this.emit('will-frame-navigate', {
      url,
      isMainFrame: true,
      preventDefault() {
        prevented = true;
      },
    });
    if (prevented) throw Error('initialization_navigation_denied');
    this.url = url;
    this.formValue = '';
    this.pid = 123;
    this.emit('did-start-navigation', {}, url, false, true);
    this.emit('page-title-updated', {}, '');
    this.emit('did-navigate', {}, url);
    this.emit('dom-ready');
    this.emit('did-finish-load');
    this.emit('did-stop-loading');
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return '';
  }
  getOSProcessId() {
    return this.pid;
  }
  close() {
    this.destroyed = true;
    this.emit('destroyed');
  }
  send() {}
}
class View {
  readonly webContents = new Contents();
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  constructor() {
    views.push(this);
  }
  setVisible(value: boolean) {
    this.visible = value;
  }
  getVisible() {
    return this.visible;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value;
  }
  getBounds() {
    return this.bounds;
  }
  setBorderRadius() {}
  setBackgroundColor() {}
}
const browsing = Object.assign(new EventEmitter(), {
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  webRequest: { onBeforeRequest() {} },
});
let nativeWindow: { contentView: { children: View[] } } | undefined;
mock.module('electron', () => ({
  View: FakePlainView,
  WebContentsView: View,
  session: { fromPartition: () => browsing },
  BrowserWindow: {
    fromWebContents: (contents: Contents) =>
      nativeWindow?.contentView.children.some((view) => view.webContents === contents)
        ? nativeWindow
        : undefined,
  },
}));
const { registerNativeBrowserIpc } = await import('../../electron/native-browser');

function readPageToken(invoke: (request: unknown) => unknown, id: string): string {
  const result = invoke({ action: 'state', id }) as {
    ok: boolean;
    value: { id: string; pageToken: string };
  };
  expect(result.ok).toBe(true);
  expect(result.value.id).toBe(id);
  expect(typeof result.value.pageToken).toBe('string');
  return result.value.pageToken;
}

function fixture(
  grantScope?: () => BrowserGrantScope | undefined,
  selectedScope?: () => BrowserGrantScope | undefined,
) {
  views.length = 0;
  const host = new NativeBrowserPageHost(),
    owner = new Contents(),
    children: View[] = [];
  const ports: BrowserPagePort[] = [];
  const add = host.add.bind(host);
  host.add = (port) => {
    ports.push(port);
    return add(port);
  };
  const window = Object.assign(new EventEmitter(), {
    webContents: owner,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => [1200, 900],
    contentView: {
      children,
      addChildView(view: View, index?: number) {
        const previous = children.indexOf(view);
        if (previous >= 0) children.splice(previous, 1);
        children.splice(index ?? children.length, 0, view);
      },
      removeChildView(view: View) {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      },
    },
  });
  const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => unknown>();
  nativeWindow = window;
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const dispose = registerNativeBrowserIpc({
    window: window as unknown as BrowserWindow,
    ipcMain: {
      handle: (key: string, handler: (event: IpcMainInvokeEvent, request: unknown) => unknown) =>
        handlers.set(key, handler),
      removeHandler: (key: string) => handlers.delete(key),
    } as unknown as IpcMain,
    rendererUrl: 'http://localhost/',
    automation: host,
    selectedScope: selectedScope ?? (() => scope),
    ...(grantScope ? { grantScope } : {}),
  });
  const prepare = async () => {
    const requestId = createBrowserGrantRequestId();
    await host.request({
      op: 'prepareGrant',
      requestId,
      storeId: scope.storeId,
      sessionId: scope.sessionId,
      executionId: 'tool',
      browserId: 'open',
      url: 'https://example.test/target',
    });
    return requestId;
  };
  const commit = (requestId: string, interactionId = 'question') =>
    host.request({
      op: 'commitGrant',
      requestId,
      interactionId,
      decisionRevision: '1',
    }) as Promise<{ state: string; page: { id: string } }>;
  return { host, owner, window, children, handlers, scope, dispose, prepare, commit, ports };
}

async function ownedNavigationFixture() {
  const f = fixture();
  const invoke = (request: unknown) =>
    f.handlers.get(nativeBrowserChannel)!(
      { sender: f.owner, senderFrame: f.owner.mainFrame } as unknown as IpcMainInvokeEvent,
      request,
    );
  expect(
    invoke({ action: 'navigate', id: 'owned-page', input: 'https://example.test/old' }),
  ).toMatchObject({ ok: true });
  await Promise.resolve();
  const contents = views[0]!.webContents;
  f.host.arm('owned-page', f.scope);
  const lease = (await f.host.request({
    op: 'acquire',
    storeId: f.scope.storeId,
    sessionId: f.scope.sessionId,
    executionId: 'owned-job',
    browserId: 'owned-browser',
  })) as { leaseId: string; pageId: string; incarnation: string; navigation: number };
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  return { ...f, contents, lease };
}

for (const kind of ['cross-document', 'redirect', 'hash', 'same-url'])
  test(`Main-owned ${kind} navigation dispatches once and returns actual native state`, async () => {
    const f = await ownedNavigationFixture(),
      ack = deferred(),
      dispatched = deferred();
    let settled = false,
      styles = 0;
    const actual = 'https://redirect.example.test/actual';
    try {
      f.contents.insertCSS = async () => {
        styles++;
        return 'unused-css';
      };
      f.contents.debugger.sendCommand = async (method, params) => {
        f.contents.cdp.push({ method, params });
        dispatched.resolve();
        await ack.promise;
        return {
          frameId: 'main',
          ...(kind === 'cross-document' || kind === 'redirect' ? { loaderId: 'new' } : {}),
        };
      };
      const requested = kind === 'same-url' ? f.contents.url : 'https://example.test/requested';
      const pending = f.host
        .request({
          op: 'navigate',
          leaseId: f.lease.leaseId,
          url: requested,
        })
        .then((value) => {
          settled = true;
          return value;
        });
      await dispatched.promise;
      f.contents.emit('dom-ready'); // Readiness from the old document cannot complete this call.
      const before = f.host.state('owned-page')!.navigation;
      f.contents.emit('did-start-navigation', {}, 'https://iframe.test/', false, false);
      f.contents.emit('did-navigate-in-page', {}, 'https://iframe.test/#child', false);
      expect(f.host.state('owned-page')!.navigation).toBe(before);
      if (kind === 'cross-document' || kind === 'redirect') {
        f.contents.emit('did-start-navigation', {}, requested, false, true);
        if (kind === 'redirect')
          f.contents.emit('did-redirect-navigation', {}, actual, false, true);
        ack.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        f.contents.url = kind === 'redirect' ? actual : requested;
        f.contents.emit('did-navigate', {}, f.contents.url);
        await Promise.resolve();
        expect(settled).toBe(false);
        f.contents.emit('dom-ready');
      } else {
        f.contents.url = requested;
        if (kind === 'hash') f.contents.emit('did-navigate-in-page', {}, requested, true);
        ack.resolve();
      }
      const result = await pending;
      expect(result).toEqual({
        leaseId: f.lease.leaseId,
        pageId: f.lease.pageId,
        incarnation: f.lease.incarnation,
        navigation: f.host.state('owned-page')!.navigation,
        url: f.contents.url,
        title: '',
      });
      expect(f.contents.cdp).toEqual([{ method: 'Page.navigate', params: { url: requested } }]);
      expect(styles).toBe(0);
      expect(f.contents.loads).toBe(1);
      expect(f.contents.destroyed).toBe(false);
    } finally {
      ack.resolve();
      f.dispose();
    }
  });

for (const boundary of ['revoke', 'detach', 'destroyed', 'cancel'])
  test(`Main-owned navigation retains ${boundary} and late raw completion as unknown`, async () => {
    const f = await ownedNavigationFixture(),
      ack = deferred(),
      dispatched = deferred(),
      abort = new AbortController();
    let settled = false;
    try {
      f.contents.debugger.sendCommand = async (method, params) => {
        f.contents.cdp.push({ method, params });
        dispatched.resolve();
        await ack.promise;
        return { frameId: 'main', loaderId: 'new' };
      };
      const request = { op: 'navigate', leaseId: f.lease.leaseId, url: 'https://example.test/new' };
      const pending = f.host.request(request, abort.signal).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await dispatched.promise;
      if (boundary === 'revoke') await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
      if (boundary === 'detach') await f.ports[0]!.detach();
      if (boundary === 'destroyed') f.contents.close();
      if (boundary === 'cancel') abort.abort(Error('stopped'));
      await Promise.resolve();
      expect(settled).toBe(false); // The original raw CDP acknowledgement still drains.
      ack.resolve();
      const result = await pending;
      expect(result).toBeInstanceOf(Error);
      expect(serializeBrowserPageFailure(result, request)).toMatchObject({
        op: 'navigate',
        leaseId: f.lease.leaseId,
        kind: 'effect_unknown',
      });
      f.contents.emit('did-start-navigation', {}, request.url, false, true);
      f.contents.emit('did-navigate', {}, request.url);
      f.contents.emit('dom-ready');
      expect(f.contents.cdp).toEqual([{ method: 'Page.navigate', params: { url: request.url } }]);
      expect(f.contents.loads).toBe(1);
      expect(f.contents.destroyed).toBe(boundary === 'destroyed');
    } finally {
      ack.resolve();
      f.dispose();
    }
  });

test('Main-owned navigation ignores old-frame DOM-ready and requires the current frame commit', async () => {
  const f = await ownedNavigationFixture(),
    dispatched = deferred();
  let settled = false;
  try {
    f.contents.debugger.sendCommand = async (method, params) => {
      f.contents.cdp.push({ method, params });
      dispatched.resolve();
      return { frameId: 'main', loaderId: 'new' };
    };
    const pending = f.host
      .request({
        op: 'navigate',
        leaseId: f.lease.leaseId,
        url: 'https://example.test/new',
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await dispatched.promise;
    f.contents.emit('did-start-navigation', {}, 'https://example.test/new', false, true);
    f.contents.emit('did-navigate', {}, 'https://example.test/new');
    Object.defineProperty(f.contents, 'mainFrame', { value: { url: 'https://example.test/new' } });
    f.contents.emit('dom-ready');
    await Promise.resolve();
    expect(settled).toBe(false);
    f.contents.url = 'https://example.test/new';
    f.contents.emit('did-navigate', {}, f.contents.url);
    f.contents.emit('dom-ready');
    expect(await pending).toMatchObject({ url: f.contents.url });
    expect(f.contents.cdp).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test('Main state and owned navigation refuse the Kite root instead of using another debugging target', async () => {
  const f = await ownedNavigationFixture();
  const root = f.window.webContents;
  try {
    f.window.webContents = f.contents;
    const state = { op: 'pageState', leaseId: f.lease.leaseId },
      navigation = { op: 'navigate', leaseId: f.lease.leaseId, url: 'https://example.test/new' };
    const read = await f.host.request(state).catch((error: unknown) => error);
    expect(serializeBrowserPageFailure(read, state)).toMatchObject({ kind: 'read_failed' });
    const effect = await f.host.request(navigation).catch((error: unknown) => error);
    expect(serializeBrowserPageFailure(effect, navigation)).toMatchObject({
      kind: 'not_dispatched',
    });
    expect(f.contents.cdp).toHaveLength(0);
  } finally {
    f.window.webContents = root;
    f.dispose();
  }
});

test('same-URL tabs never replace the exact leased page for owned state or navigation', async () => {
  const f = await ownedNavigationFixture();
  try {
    const sameUrl = f.contents.url,
      originalViews = new Set(views);
    expect(
      f.handlers.get(nativeBrowserChannel)!(
        { sender: f.owner, senderFrame: f.owner.mainFrame } as unknown as IpcMainInvokeEvent,
        { action: 'navigate', id: 'same-url-other-page', input: sameUrl },
      ),
    ).toMatchObject({ ok: true });
    await Promise.resolve();
    const allocated = views.filter((view) => !originalViews.has(view));
    expect(allocated).toHaveLength(1);
    const other = allocated[0]!.webContents;
    f.contents.getTitle = () => 'Exact original';
    other.getTitle = () => 'Other tab';
    other.formValue = 'keep-other-form';
    expect(await f.host.request({ op: 'pageState', leaseId: f.lease.leaseId })).toMatchObject({
      pageId: 'owned-page',
      incarnation: f.lease.incarnation,
      url: sameUrl,
      title: 'Exact original',
    });
    f.contents.debugger.sendCommand = async (method, params) => {
      f.contents.cdp.push({ method, params });
      f.contents.emit('did-start-navigation', {}, params.url, false, true);
      f.contents.url = String(params.url);
      f.contents.emit('did-navigate', {}, f.contents.url);
      f.contents.emit('dom-ready');
      return { frameId: 'original-main', loaderId: 'original-loader' };
    };
    expect(
      await f.host.request({
        op: 'navigate',
        leaseId: f.lease.leaseId,
        url: 'https://example.test/original-new',
      }),
    ).toMatchObject({ pageId: 'owned-page', title: 'Exact original' });
    expect(f.contents.cdp).toHaveLength(1);
    expect(other.cdp).toHaveLength(0);
    expect(other.url).toBe(sameUrl);
    expect(other.formValue).toBe('keep-other-form');
  } finally {
    f.dispose();
  }
});

test('release drains the one raw navigation acknowledgement before detaching the original page', async () => {
  const f = await ownedNavigationFixture(),
    ack = deferred(),
    dispatched = deferred();
  let released = false;
  try {
    f.contents.debugger.sendCommand = async (method, params) => {
      f.contents.cdp.push({ method, params });
      dispatched.resolve();
      await ack.promise;
      return { frameId: 'main', loaderId: 'new-document' };
    };
    const request = { op: 'navigate', leaseId: f.lease.leaseId, url: 'https://example.test/new' };
    const pending = f.host.request(request).catch((error: unknown) => error);
    await dispatched.promise;
    await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
    const release = f.host
      .request({
        op: 'release',
        leaseId: f.lease.leaseId,
        channelRevoked: true,
      })
      .then((value) => {
        released = true;
        return value;
      });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(f.contents.attached).toBe(true);
    ack.resolve();
    const result = await pending;
    expect(serializeBrowserPageFailure(result, request)).toMatchObject({ kind: 'effect_unknown' });
    expect(await release).toMatchObject({ confirmed: true, detached: true });
    expect(f.contents.attached).toBe(false);
    expect(f.contents.destroyed).toBe(false);
    expect(f.contents.cdp).toHaveLength(1);
  } finally {
    ack.resolve();
    f.dispose();
  }
});

for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn'])
  for (const change of [
    'in-page',
    'cross-document',
    'identity',
    'revoke-resume',
    'detach',
    'stable',
    'css-rejection',
    'raw-rejection',
  ])
    test(`${method} CSS preflight preserves its original target before ${change}`, async () => {
      const f = fixture();
      const invoke = (request: unknown) =>
        f.handlers.get(nativeBrowserChannel)!(
          { sender: f.owner, senderFrame: f.owner.mainFrame } as unknown as IpcMainInvokeEvent,
          request,
        );
      const inserted = deferred(),
        finishInsertion = deferred();
      try {
        expect(
          invoke({
            action: 'navigate',
            id: 'preflight-page',
            input: 'https://example.test/target',
          }),
        ).toMatchObject({ ok: true });
        await Promise.resolve();
        const contents = views[0]!.webContents;
        f.host.arm('preflight-page', f.scope);
        const lease = (await f.host.request({
          op: 'acquire',
          storeId: f.scope.storeId,
          sessionId: f.scope.sessionId,
          executionId: 'original-job',
          browserId: 'original-browser',
        })) as { leaseId: string };
        await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
        contents.insertCSS = async () => {
          inserted.resolve();
          await finishInsertion.promise;
          if (change === 'css-rejection') throw Error('native_css_failed');
          return 'original-insertion';
        };
        const originalError = Error('actual_debugger_rejection');
        if (change === 'raw-rejection')
          contents.debugger.sendCommand = async (actualMethod, params) => {
            contents.cdp.push({ method: actualMethod, params });
            throw originalError;
          };
        const request = {
          op: 'cdp',
          method,
          leaseId: lease.leaseId,
          params: { expression: '1' },
        };
        const pending = f.host.request(request).catch((error: unknown) => error);
        await inserted.promise;
        const navigation = f.host.state('preflight-page')!.navigation;
        let detach: Promise<boolean> | undefined;
        let release: Promise<unknown> | undefined;
        if (change === 'in-page') {
          contents.emit('did-navigate-in-page', {}, 'https://example.test/target#updated', true);
          expect(f.host.state('preflight-page')?.navigation).toBe(navigation + 1);
          expect(contents.cssRemovals).toBe(0);
        }
        if (change === 'cross-document')
          contents.emit(
            'did-start-navigation',
            {},
            'https://example.test/new-document',
            false,
            true,
          );
        if (change === 'identity') {
          const state = f.host.state.bind(f.host);
          f.host.state = (id) => {
            const current = state(id);
            return current ? { ...current, browserId: 'replacement-browser' } : current;
          };
        }
        if (change === 'detach') detach = Promise.resolve(f.ports[0]!.detach());
        if (change === 'revoke-resume') {
          await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
          release = f.host.request({
            op: 'release',
            leaseId: lease.leaseId,
            pause: true,
            channelRevoked: true,
          });
        }
        finishInsertion.resolve();
        const result = await pending;
        if (change === 'stable') {
          expect(result).toEqual({ result: { type: 'number', value: 1 } });
          expect(contents.cdp).toEqual([{ method, params: request.params }]);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(serializeBrowserPageFailure(result, request)).toMatchObject({
            kind: change === 'raw-rejection' ? 'effect_unknown' : 'not_dispatched',
            op: request.op,
            method,
            leaseId: lease.leaseId,
          });
          expect(contents.cdp).toHaveLength(change === 'raw-rejection' ? 1 : 0);
          if (change === 'raw-rejection')
            expect(originalError.message).toBe('actual_debugger_rejection');
        }
        await detach;
        if (release) {
          expect(await release).toMatchObject({ confirmed: true, detached: true });
          const next = (await f.host.request({ op: 'resume', leaseId: lease.leaseId })) as {
            leaseId: string;
          };
          expect(next.leaseId).not.toBe(lease.leaseId);
          await f.host.request({ op: 'confirm', leaseId: next.leaseId });
          expect(await f.host.request({ ...request, leaseId: next.leaseId })).toEqual({
            result: { type: 'number', value: 1 },
          });
          expect(contents.cdp).toEqual([{ method, params: request.params }]);
        }
      } finally {
        finishInsertion.resolve();
        f.dispose();
      }
    });

test('released pages survive selection changes and renderer replacement with their original contents and form state', async () => {
  let selected = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  const f = fixture(undefined, () => selected);
  const invoke = (request: unknown) =>
    f.handlers.get(nativeBrowserChannel)!(
      { sender: f.owner, senderFrame: f.owner.mainFrame } as unknown as IpcMainInvokeEvent,
      request,
    );
  try {
    expect(
      invoke({ action: 'navigate', id: 'original', input: 'https://example.test/target' }),
    ).toMatchObject({ ok: true });
    const contents = views[0]!.webContents;
    await Promise.resolve();
    contents.formValue = 'USER-UNSUBMITTED';
    const requestId = await f.prepare();
    await f.commit(requestId);
    const lease = (await f.host.request({
      op: 'acquire',
      storeId: f.scope.storeId,
      sessionId: f.scope.sessionId,
      executionId: 'job',
      browserId: 'open',
      grantId: requestId,
      grantExecutionId: 'tool',
    })) as { leaseId: string };
    await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
    await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
    expect(
      await f.host.request({ op: 'release', leaseId: lease.leaseId, channelRevoked: true }),
    ).toEqual({
      confirmed: true,
      detached: true,
      retainedPage: {
        leaseId: lease.leaseId,
        pageId: 'original',
        incarnation: f.host.state('original')?.incarnation,
        url: 'https://example.test/target',
        title: '',
      },
    });
    expect(f.host.retained('original')).toBe(false);
    selected = { ...selected, sessionId: 'other', viewSelection: 2 };
    expect(invoke({ action: 'restore', scope: selected })).toMatchObject({
      ok: true,
      value: { page: null, pages: [] },
    });
    selected = { ...f.scope, viewSelection: 3 };
    expect(invoke({ action: 'restore', scope: selected })).toMatchObject({
      ok: true,
      value: { page: { id: 'original' }, pages: [{ id: 'original' }], activeId: 'original' },
    });
    for (const kind of ['navigation', 'crash']) {
      if (kind === 'navigation')
        f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
      else f.owner.emit('render-process-gone');
      expect(contents.destroyed).toBe(false);
      expect(invoke({ action: 'restore', scope: selected })).toMatchObject({
        ok: true,
        value: { page: { id: 'original' } },
      });
      expect(views[0]!.webContents).toBe(contents);
      expect(contents.loads).toBe(1);
      expect(contents.formValue).toBe('USER-UNSUBMITTED');
    }
    expect(
      invoke({ action: 'close', id: 'original', pageToken: readPageToken(invoke, 'original') }),
    ).toMatchObject({ ok: true });
    expect(contents.destroyed).toBe(true);
    expect(invoke({ action: 'restore', scope: selected })).toMatchObject({
      ok: true,
      value: { page: null, pages: [] },
    });
  } finally {
    f.dispose();
  }
});

test('explicit tab X destroys its exact page in every control phase; hiding and release still preserve it', async () => {
  for (const phase of ['acquiring', 'agent', 'unknown', 'human'] as const) {
    const f = fixture();
    let presentationRevision = 0;
    const invoke = (request: unknown) =>
      f.handlers.get(nativeBrowserChannel)!(
        { sender: f.owner, senderFrame: f.owner.mainFrame } as unknown as IpcMainInvokeEvent,
        request,
      );
    try {
      const requestId = await f.prepare();
      const committed = await f.commit(requestId);
      const lease = (await f.host.request({
        op: 'acquire',
        storeId: f.scope.storeId,
        sessionId: f.scope.sessionId,
        executionId: 'job',
        browserId: 'open',
        grantId: requestId,
        grantExecutionId: 'tool',
      })) as { leaseId: string };
      if (phase !== 'acquiring') await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
      if (phase === 'unknown') f.host.fail(committed.page.id);
      if (phase === 'human') {
        await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
        expect(
          await f.host.request({ op: 'release', leaseId: lease.leaseId, channelRevoked: true }),
        ).toEqual({ confirmed: true, detached: true });
      }
      const contents = views[0]!.webContents;
      const pageToken = readPageToken(invoke, committed.page.id);
      // Pane unmount/collapse continues to publish only hide, never user close.
      expect(
        invoke({
          action: 'present',
          id: committed.page.id,
          bounds: null,
          scope: f.scope,
          pageToken,
          presentationRevision: ++presentationRevision,
        }),
      ).toMatchObject({ ok: true });
      expect(contents.destroyed).toBe(false);
      expect(f.host.state(committed.page.id)?.phase).toBe(phase);
      const incarnation = f.host.state(committed.page.id)!.incarnation;
      expect(f.children).toHaveLength(2); // Page plus the existing input shield.
      let sends = 0;
      f.ports[0]!.send = async () => {
        sends++;
        return {};
      };
      expect(invoke({ action: 'close', id: committed.page.id, pageToken })).toMatchObject({
        ok: true,
      });
      expect(contents.destroyed).toBe(true);
      expect(f.host.state(committed.page.id)).toBeUndefined();
      expect(f.host.retained(committed.page.id)).toBe(false);
      expect(f.children.some((view) => view.webContents === contents)).toBe(false);
      expect(invoke({ action: 'restore', scope: f.scope })).toMatchObject({
        ok: true,
        value: { page: null, pages: [] },
      });
      // Queued reads and Pane cleanup are get-only, including an old positive
      // presentation. None can recreate the closed id or publish a replacement.
      for (const request of [
        { action: 'state', id: committed.page.id },
        {
          action: 'present',
          id: committed.page.id,
          bounds: null,
          scope: f.scope,
          pageToken,
          presentationRevision: ++presentationRevision,
        },
        {
          action: 'present',
          id: committed.page.id,
          bounds: { x: 800, y: 80, width: 390, height: 810, radius: 0 },
          scope: f.scope,
          pageToken,
          presentationRevision: ++presentationRevision,
        },
        { action: 'close', id: committed.page.id, pageToken },
      ])
        expect(invoke(request)).toEqual(
          request.action === 'present' && request.bounds
            ? { ok: false, code: 'browser_page_scope_denied' }
            : { ok: true, value: null },
        );
      contents.emit('page-title-updated', {}, 'Late original title');
      expect(invoke({ action: 'restore', scope: f.scope })).toMatchObject({
        ok: true,
        value: { page: null, pages: [] },
      });
      for (const input of [
        { op: 'events', after: 0 },
        { op: 'cdp', method: 'Accessibility.getFullAXTree' },
        { op: 'dialogs' },
      ])
        await expect(f.host.request({ ...input, leaseId: lease.leaseId })).rejects.toThrow(
          // An already-released human lease has no remaining Main ownership proof.
          phase === 'human' ? 'browser_page_lease_stale' : 'browser_page_closed',
        );
      // A later Run can neither recover the old target nor silently allocate it.
      await expect(
        f.host.request({
          op: 'prepareGrant',
          requestId: createBrowserGrantRequestId(),
          storeId: f.scope.storeId,
          sessionId: f.scope.sessionId,
          executionId: 'next-tool',
          browserId: 'next-open',
          url: 'https://example.test/target',
          requireExisting: true,
          existingPage: { pageId: committed.page.id, incarnation },
        }),
      ).rejects.toThrow('browser_page_existing_missing');
      expect(views.filter((view) => view.webContents === contents)).toHaveLength(1);
      expect(f.ports).toHaveLength(1);
      expect(sends).toBe(0);
      expect(invoke({ action: 'close', id: committed.page.id, pageToken })).toMatchObject({
        ok: true,
      });
      expect(f.owner.destroyed).toBe(false);
    } finally {
      f.dispose();
    }
  }
});

test('renderer replacement keeps manual contents alive and only owner-window disposal destroys them', async () => {
  const f = fixture();
  const invoke = (request: unknown) =>
    f.handlers.get(nativeBrowserChannel)!(
      { sender: f.owner, senderFrame: f.owner.mainFrame } as unknown as IpcMainInvokeEvent,
      request,
    );
  try {
    expect(
      invoke({ action: 'navigate', id: 'manual', input: 'https://example.test/form' }),
    ).toMatchObject({ ok: true });
    await Promise.resolve();
    const contents = views[0]!.webContents;
    contents.formValue = 'UNSUBMITTED';
    f.owner.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(contents.destroyed).toBe(false);
    f.owner.emit('render-process-gone');
    expect(contents.destroyed).toBe(false);
    expect(contents.formValue).toBe('UNSUBMITTED');
    expect(contents.loads).toBe(1);
    f.window.emit('closed');
    expect(contents.destroyed).toBe(true);
  } finally {
    f.dispose();
  }
});

test('Main restores every live scoped tab with the last presented selection and preserves the eight-page limit', async () => {
  let selected = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  let presentationRevision = 0;
  const f = fixture(undefined, () => selected);
  const invoke = (request: unknown) =>
    f.handlers.get(nativeBrowserChannel)!(
      { sender: f.owner, senderFrame: f.owner.mainFrame } as unknown as IpcMainInvokeEvent,
      request,
    );
  try {
    for (let index = 0; index < 8; index++)
      expect(
        invoke({ action: 'navigate', id: `page-${index}`, input: `https://example.test/${index}` }),
      ).toMatchObject({ ok: true });
    const pageToken = readPageToken(invoke, 'page-5');
    expect(
      invoke({
        action: 'present',
        id: 'page-5',
        bounds: { x: 800, y: 80, width: 390, height: 810, radius: 0 },
        scope: selected,
        pageToken,
        presentationRevision: ++presentationRevision,
      }),
    ).toMatchObject({ ok: true });
    expect(
      invoke({
        action: 'present',
        id: 'page-5',
        bounds: null,
        scope: selected,
        pageToken,
        presentationRevision: ++presentationRevision,
      }),
    ).toMatchObject({ ok: true });
    const restored = invoke({ action: 'restore', scope: selected }) as {
      value: NativeBrowserRestoreResult;
    };
    expect(restored).toMatchObject({
      ok: true,
      value: { page: { id: 'page-5' }, activeId: 'page-5' },
    });
    expect(restored.value.pages!.map((page: { id: string }) => page.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `page-${index}`),
    );
    await Promise.resolve();
    f.host.arm('page-0', f.scope);
    const lease = (await f.host.request({
      op: 'acquire',
      storeId: f.scope.storeId,
      sessionId: f.scope.sessionId,
      executionId: 'background-job',
      browserId: 'background-browser',
    })) as { leaseId: string };
    await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
    expect(invoke({ action: 'restore', scope: selected })).toMatchObject({
      ok: true,
      value: { page: { id: 'page-0' }, activeId: 'page-5' },
    });
    expect(
      invoke({ action: 'navigate', id: 'overflow', input: 'https://example.test/overflow' }),
    ).toEqual({ ok: false, code: 'browser_tab_limit' });
    const currentPageToken = readPageToken(invoke, 'page-5');
    selected = { ...selected, sessionId: 'other', viewSelection: 2 };
    expect(invoke({ action: 'restore', scope: selected })).toMatchObject({
      ok: true,
      value: { page: null, pages: [] },
    });
    expect(invoke({ action: 'close', id: 'page-5', pageToken: currentPageToken })).toEqual({
      ok: false,
      code: 'browser_page_scope_denied',
    });
    expect(invoke({ action: 'restore', scope: f.scope })).toEqual({
      ok: false,
      code: 'browser_page_scope_denied',
    });
    selected = { ...f.scope, viewSelection: 3 };
    expect(invoke({ action: 'close', id: 'page-5', pageToken: currentPageToken })).toMatchObject({
      ok: true,
    });
    expect(
      (invoke({ action: 'restore', scope: selected }) as { value: NativeBrowserRestoreResult })
        .value.pages,
    ).toHaveLength(7);
    expect(
      invoke({ action: 'navigate', id: 'replacement', input: 'https://example.test/replacement' }),
    ).toMatchObject({ ok: true });
  } finally {
    f.dispose();
  }
});

test('a real Caller loading projection commits and restores a scoped new page through the original Native factory', async () => {
  const data = memoryPrivateData();
  let gate: ReturnType<typeof deferred> | undefined;
  const entered = deferred();
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'local-user', capabilities: [] },
    connect: async () => ({}),
    async observe({ signal }: { signal: AbortSignal }) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    async getView(id: string) {
      if (gate) {
        entered.resolve();
        await gate.promise;
      }
      return {
        storeId: 'store',
        snapshotCursor: '0',
        session: {
          id,
          workspaceId: 'workspace',
          rootSessionId: id,
          parentSessionId: null,
          title: id,
          nextSeq: '0',
          contextSelectionId: `context-${id}`,
          controlRevision: '0',
          deletedAt: null,
        },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView;
    },
    listWorkspaces: async () => [],
    listAllWorkspaces: async () => [],
    listAllSessions: async () => [],
    listSessions: async () => [],
    disposeNetwork() {},
  } as unknown as AgentClient;
  const caller = new NativeCaller(client, () => {}, data);
  let f: ReturnType<typeof fixture> | undefined;
  let refreshing: Promise<unknown> | undefined;
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const select = { method: 'select', generation, sessionId: 'session', activationId: 1 } as const;
    await caller.invoke(select);
    const identity = () => {
      const state = caller.state(),
        view = state.selection;
      return view
        ? {
            storeId: view.storeId,
            sessionId: view.session.id,
            generation: state.generation,
            viewSelection: view.viewSelection!,
          }
        : undefined;
    };
    f = fixture(identity, () => (caller.state().selection?.viewLoading ? undefined : identity()));
    const rootView = {
      webContents: f.owner,
      getVisible: () => true,
      getBounds: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
    } as View;
    f.window.contentView.addChildView(rootView);
    const requestId = await f.prepare();
    expect(views).toHaveLength(0);
    gate = deferred();
    refreshing = caller.invoke(select);
    await entered.promise;
    expect(caller.state().selection).toMatchObject({
      viewLoading: true,
      permissionUnavailable: true,
    });
    const committed = await f.commit(requestId);
    expect(committed.state).toBe('committed');
    expect(views).toHaveLength(1);
    expect(f.ports).toHaveLength(1);
    expect(f.ports[0]!.scope).toEqual({ storeId: 'store', sessionId: 'session' });
    expect(f.host.state(committed.page.id)?.phase).toBe('armed');
    expect(views[0]!.webContents.loads).toBe(1);
    // Grant creation initializes about:blank. The same page becomes drawable
    // only after its actual HTTP document and a complete native frame are ready.
    await views[0]!.webContents.loadURL('https://example.test/target');
    const loadingEvent = {
      sender: f.owner,
      senderFrame: f.owner.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const bounds = { x: 800, y: 80, width: 390, height: 810, radius: 0 };
    const pageToken = readPageToken(
      (request) => f!.handlers.get(nativeBrowserChannel)!(loadingEvent, request),
      committed.page.id,
    );
    expect(
      f.handlers.get(nativeBrowserChannel)!(loadingEvent, {
        action: 'present',
        id: committed.page.id,
        bounds,
        scope: identity(),
        pageToken,
        presentationRevision: 1,
      }),
    ).toMatchObject({ ok: true });
    const displayDeadline = Date.now() + 1000;
    while (
      (
        f.handlers.get(nativeBrowserChannel)!(loadingEvent, {
          action: 'state',
          id: committed.page.id,
        }) as { value: { display?: string } }
      ).value.display !== 'ready'
    ) {
      if (Date.now() >= displayDeadline) throw Error('browser_fixture_display_not_ready');
      await Bun.sleep(0);
    }
    expect(views[0]!.getBounds()).toEqual({ x: 800, y: 80, width: 390, height: 810 });
    expect(views[0]!.getVisible()).toBe(true);
    const original = views[0]!,
      contents = original.webContents;
    contents.formValue = 'HUMAN-UPDATED';
    expect(
      f.handlers.get(nativeBrowserChannel)!(loadingEvent, { action: 'restore', scope: identity() }),
    ).toMatchObject({
      ok: true,
      value: { page: { id: committed.page.id }, activeId: committed.page.id },
    });
    for (const scope of [
      { ...identity()!, storeId: 'other-store' },
      { ...identity()!, sessionId: 'other-session' },
      { ...identity()!, generation: generation + 1 },
      { ...identity()!, viewSelection: identity()!.viewSelection + 1 },
    ]) {
      expect(
        f.handlers.get(nativeBrowserChannel)!(loadingEvent, { action: 'restore', scope }),
      ).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    }
    expect(views[0]).toBe(original);
    expect(original.webContents).toBe(contents);
    expect(original.getVisible()).toBe(true);
    expect(original.getBounds()).toEqual({ x: 800, y: 80, width: 390, height: 810 });
    expect(contents.formValue).toBe('HUMAN-UPDATED');
    expect(
      f.handlers.get(nativeBrowserChannel)!(loadingEvent, {
        action: 'navigate',
        id: committed.page.id,
        input: 'https://example.test/other',
      }),
    ).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    expect(views[0]!.webContents.loads).toBe(2);
    expect(views[0]!.webContents.pid).toBeGreaterThan(0);
    expect((await f.commit(requestId)).page.id).toBe(committed.page.id);
    expect(views).toHaveLength(1);
    gate.resolve();
    await refreshing;
    gate = undefined;
    const event = {
      sender: f.owner,
      senderFrame: f.owner.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    expect(
      f.handlers.get(nativeBrowserChannel)!(event, { action: 'restore', scope: identity() }),
    ).toMatchObject({
      ok: true,
      value: { page: { id: committed.page.id, control: { phase: 'human' } } },
    });
    await f.host.request({ op: 'cancelGrant', requestId });
    expect(original.webContents).toBe(contents);
    expect(contents.destroyed).toBe(false);
    expect(contents.formValue).toBe('HUMAN-UPDATED');
    expect(contents.loads).toBe(2);
    expect(
      f.handlers.get(nativeBrowserChannel)!(event, {
        action: 'close',
        id: committed.page.id,
        pageToken: readPageToken(
          (request) => f!.handlers.get(nativeBrowserChannel)!(event, request),
          committed.page.id,
        ),
      }),
    ).toMatchObject({ ok: true });
    expect(contents.destroyed).toBe(true);
    expect(f.children).toEqual([rootView]);
  } finally {
    gate?.resolve();
    await refreshing?.catch(() => {});
    f?.dispose();
    await caller.close();
    data.close();
  }
});

test('a synchronous page registration failure closes only the exact unused allocation', async () => {
  const f = fixture();
  try {
    const requestId = await f.prepare();
    f.host.add = () => {
      throw Error('fixture_registration_failed');
    };
    await expect(f.commit(requestId)).rejects.toThrow('browser_page_request_failed');
    expect(views).toHaveLength(1);
    expect(views[0]!.webContents.destroyed).toBe(true);
    expect(f.children).toHaveLength(0);
    expect(await f.host.request({ op: 'inspectGrant', requestId })).toMatchObject({
      state: 'expired',
      consumed: false,
    });
  } finally {
    f.dispose();
  }
});

test('an installed private grant scope that denies cannot fall back to a ready renderer scope', async () => {
  const f = fixture(() => undefined);
  try {
    await expect(f.prepare()).rejects.toThrow('browser_page_scope_denied');
    expect(views).toHaveLength(0);
    expect(f.ports).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

test('presentation and restoration reject a switched or invalidated trusted selection without ready-scope fallback', async () => {
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
  let trusted: BrowserGrantScope | undefined = scope;
  let selected: BrowserGrantScope | undefined = scope;
  const f = fixture(
    () => trusted,
    () => selected,
  );
  try {
    const committed = await f.commit(await f.prepare());
    const event = {
      sender: f.owner,
      senderFrame: f.owner.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const pageToken = readPageToken(
      (request) => f.handlers.get(nativeBrowserChannel)!(event, request),
      committed.page.id,
    );
    let presentationRevision = 0;
    const request = (
      bounds: { x: number; y: number; width: number; height: number; radius: number } | null,
    ) =>
      f.handlers.get(nativeBrowserChannel)!(event, {
        action: 'present',
        id: committed.page.id,
        bounds,
        scope,
        pageToken,
        presentationRevision: ++presentationRevision,
      });
    const bounds = { x: 800, y: 80, width: 390, height: 810, radius: 0 };
    expect(request(bounds)).toMatchObject({ ok: true });
    trusted = selected = { ...scope, sessionId: 'other', viewSelection: 2 };
    expect(request({ ...bounds, x: 700 })).toMatchObject({
      ok: false,
      code: 'browser_page_scope_denied',
    });
    expect(
      f.handlers.get(nativeBrowserChannel)!(event, {
        action: 'navigate',
        id: committed.page.id,
        input: 'https://example.test/other',
      }),
    ).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    expect(views[0]!.getBounds()).toEqual({ x: 800, y: 80, width: 390, height: 810 });
    // The old selection may withdraw its exact page while its Root generation remains current.
    expect(request(null)).toMatchObject({ ok: true });
    expect(views[0]!.getVisible()).toBe(false);
    trusted = undefined;
    selected = scope; // A denied installed provider never falls back to this ready scope.
    expect(
      f.handlers.get(nativeBrowserChannel)!(event, { action: 'restore', scope }),
    ).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    selected = undefined; // Completed permission/observation loss revokes the readonly identity too.
    expect(
      f.handlers.get(nativeBrowserChannel)!(event, { action: 'restore', scope }),
    ).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    selected = scope;
    expect(request(bounds)).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    expect(request(null)).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    expect(views[0]!.getVisible()).toBe(false);
    expect(request(bounds)).toMatchObject({ ok: false, code: 'browser_page_scope_denied' });
    expect(views[0]!.getVisible()).toBe(false);
  } finally {
    f.dispose();
  }
});

test('Native grant context is passive until consent, initializes one blank renderer before arming and closes only that unused page', async () => {
  const { host, owner, children, handlers, scope, dispose } = fixture();
  try {
    expect(views).toHaveLength(0);
    const requestId = createBrowserGrantRequestId();
    expect(
      await host.request({
        op: 'prepareGrant',
        requestId,
        storeId: scope.storeId,
        sessionId: scope.sessionId,
        executionId: 'tool',
        browserId: 'open',
        url: 'https://example.test/target',
      }),
    ).toMatchObject({ state: 'question', page: { kind: 'new' } });
    expect(views).toHaveLength(0);
    const committed = (await host.request({
      op: 'commitGrant',
      requestId,
      interactionId: 'question',
      decisionRevision: '1',
    })) as { page: { id: string } };
    expect(views).toHaveLength(1);
    expect(views[0]!.webContents.loads).toBe(1);
    expect(views[0]!.webContents.getURL()).toBe('about:blank');
    expect(views[0]!.webContents.getOSProcessId()).toBeGreaterThan(0);
    expect(children).toHaveLength(1);
    expect(host.state(committed.page.id)?.phase).toBe('armed');
    const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
    expect(
      handlers.get(nativeBrowserChannel)!(event, { action: 'state', id: committed.page.id }),
    ).toMatchObject({
      ok: true,
      value: { id: committed.page.id, url: '', control: { phase: 'armed' } },
    });
    expect(await host.request({ op: 'inspectGrant', requestId })).toMatchObject({
      state: 'committed',
    });
    await host.request({
      op: 'commitGrant',
      requestId,
      interactionId: 'question',
      decisionRevision: '1',
    });
    expect(views).toHaveLength(1);
    await host.request({ op: 'cancelGrant', requestId });
    expect(views[0]!.webContents.destroyed).toBe(true);
    expect(children).toHaveLength(0);
    expect(host.state(committed.page.id)).toBeUndefined();
  } finally {
    dispose();
  }
});

test('existing unready blank pages wait for the same renderer in both Question and manual-ready acquisition', async () => {
  for (const mode of ['question', 'manual'] as const) {
    const f = fixture();
    initialization = deferred();
    try {
      const oldId = await f.prepare();
      const obsolete = f.commit(oldId).then(
        () => 'unexpected_success',
        (error: Error) => error.message,
      );
      await Promise.resolve();
      const pageId = f.ports[0]!.id;
      f.host.arm(pageId, f.scope);
      if (mode === 'question') f.host.arm(pageId, f.scope);
      expect(await f.host.request({ op: 'inspectGrant', requestId: oldId })).toMatchObject({
        state: 'expired',
      });
      expect(views[0]!.webContents.destroyed).toBe(false);
      expect(views[0]!.webContents.pid).toBe(0);
      const requestId = await f.prepare();
      expect(await f.host.request({ op: 'inspectGrant', requestId })).toMatchObject({
        state: mode === 'question' ? 'question' : 'ready',
        page: { kind: 'existing', id: pageId },
      });
      if (mode === 'question') await f.commit(requestId);
      const acquiring = f.host.request({
        op: 'acquire',
        storeId: f.scope.storeId,
        sessionId: f.scope.sessionId,
        executionId: 'job',
        browserId: 'open',
        grantId: requestId,
        grantExecutionId: 'tool',
      });
      await Promise.resolve();
      expect(views).toHaveLength(1);
      expect(views[0]!.webContents.loads).toBe(1);
      expect(views[0]!.webContents.attached).toBe(false);
      initialization.resolve();
      expect(await obsolete).not.toBe('unexpected_success');
      expect(await acquiring).toMatchObject({ pageId });
      expect(views[0]!.webContents.loads).toBe(1);
      expect(views[0]!.webContents.attached).toBe(true);
    } finally {
      initialization?.resolve();
      initialization = undefined;
      f.dispose();
    }
  }
});

test('same-receipt commits share the pending blank initialization and cannot publish armed before DOM readiness', async () => {
  const f = fixture();
  initialization = deferred();
  try {
    const requestId = await f.prepare();
    const first = f.commit(requestId),
      second = f.commit(requestId);
    await Promise.resolve();
    expect(views).toHaveLength(1);
    expect(views[0]!.webContents.loads).toBe(1);
    const pageId = (
      (await f.host.request({ op: 'inspectGrant', requestId })) as { page: { id?: string } }
    ).page.id;
    expect(pageId).toBeUndefined();
    expect(views[0]!.webContents.pid).toBe(0);
    initialization.resolve();
    expect(await first).toEqual(await second);
    const committed = await first;
    expect(f.host.state(committed.page.id)?.phase).toBe('armed');
    expect(views).toHaveLength(1);
  } finally {
    initialization?.resolve();
    initialization = undefined;
    f.dispose();
  }
});

test('failed, cancelled or selection-invalidated blank initialization cannot arm or revive its late page', async () => {
  for (const mode of ['failed', 'cancelled', 'selection'] as const) {
    const f = fixture();
    initialization = deferred();
    try {
      const requestId = await f.prepare();
      const pending = f.commit(requestId).then(
        () => 'unexpected_success',
        (error: Error) => error.message,
      );
      await Promise.resolve();
      expect(views).toHaveLength(1);
      expect(views[0]!.webContents.loads).toBe(1);
      if (mode === 'failed') initialization.reject(Error('initialization_failed'));
      else {
        if (mode === 'selection') f.scope.viewSelection++;
        await f.host.request({
          op: mode === 'cancelled' ? 'cancelGrant' : 'inspectGrant',
          requestId,
        });
        expect(views[0]!.webContents.destroyed).toBe(true);
        initialization.resolve();
      }
      expect(await pending).not.toBe('unexpected_success');
      expect(views[0]!.webContents.destroyed).toBe(true);
      expect(f.children).toHaveLength(0);
      expect(await f.host.request({ op: 'inspectGrant', requestId })).toMatchObject({
        state: mode === 'cancelled' ? 'cancelled' : 'expired',
        consumed: false,
      });
    } finally {
      initialization?.resolve();
      initialization = undefined;
      f.dispose();
    }
  }
});

test('a later Run rechecks blank-page renderer initialization instead of reusing a settled promise', async () => {
  const f = fixture();
  try {
    const requestId = await f.prepare(),
      committed = await f.commit(requestId),
      pageId = committed.page.id;
    const acquire = (job: string) =>
      f.host.request({
        op: 'acquire',
        storeId: f.scope.storeId,
        sessionId: f.scope.sessionId,
        executionId: job,
        browserId: job === 'job-first' ? 'open' : job,
        ...(job === 'job-first' ? { grantId: requestId, grantExecutionId: 'tool' } : {}),
      }) as Promise<{ leaseId: string; incarnation: string }>;
    const first = await acquire('job-first');
    await f.host.request({ op: 'confirm', leaseId: first.leaseId });
    await f.host.request({ op: 'revoke', leaseId: first.leaseId });
    expect(
      await f.host.request({ op: 'release', leaseId: first.leaseId, channelRevoked: true }),
    ).toEqual({ confirmed: true, detached: true });
    const contents = views[0]!.webContents;
    expect(contents.loads).toBe(1);
    contents.url = '';
    contents.pid = 0;
    f.host.arm(pageId, f.scope);
    const next = await acquire('job-second');
    expect(contents.loads).toBe(2);
    expect(contents.getOSProcessId()).toBeGreaterThan(0);
    expect(next.incarnation).toBe(first.incarnation);
    expect(next.leaseId).not.toBe(first.leaseId);
    await f.host.request({ op: 'confirm', leaseId: next.leaseId });
    await expect(
      f.host.request({ op: 'cdp', leaseId: first.leaseId, method: 'Page.getLayoutMetrics' }),
    ).rejects.toThrow('lease_stale');
    expect(f.host.state(pageId)?.phase).toBe('agent');
  } finally {
    f.dispose();
  }
});
