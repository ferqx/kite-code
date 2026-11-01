import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createBrowserDisplayBootstrap } from '../../electron/browser-display-bootstrap';
import {
  type NativeBrowserBridge,
  type NativeBrowserDisplayIntent,
  type NativeBrowserRequest,
  nativeBrowserChannel,
  nativeBrowserLayoutChannel,
  nativeBrowserLayoutFrameChannel,
  nativeBrowserPresentationChannel,
} from '../../src/native-browser-bridge';
import {
  type NativeBrowserChromeRootBridge,
  nativeBrowserChromeRootChannel,
} from '../../src/native-browser-chrome-bridge';

const intent: NativeBrowserDisplayIntent = {
  token: 'a'.repeat(32),
  id: 'page',
  storeId: 'store',
  sessionId: 'session',
  bounds: { x: 801, y: 100, width: 799, height: 600, radius: 0 },
  width: 1600,
  height: 1200,
  zoom: 1,
};
function fixture(
  request: (input: Record<string, unknown>, notify: (value: unknown) => void) => unknown,
  ariaHidden?: string,
  effectiveRemoval = true,
) {
  const dom = new JSDOM('<!doctype html><div id="root"><main>FULL CHAT</main></div>');
  if (ariaHidden !== undefined)
    dom.window.document.getElementById('root')!.setAttribute('aria-hidden', ariaHidden);
  let notify = (_value: unknown) => {};
  let style: HTMLStyleElement | undefined;
  const events: string[] = [];
  const bootstrap = createBrowserDisplayBootstrap({
    document: dom.window.document,
    request: (input) => request(input as Record<string, unknown>, notify),
    insertCSS(css) {
      events.push('stage');
      style = dom.window.document.createElement('style');
      style.textContent = css;
      dom.window.document.head.append(style);
      return 'css-key';
    },
    removeCSS(key) {
      expect(key).toBe('css-key');
      events.push('reveal');
      if (effectiveRemoval) style!.remove();
    },
    subscribe(receive) {
      notify = receive;
      return () => {};
    },
  });
  return { dom, bootstrap, events, root: dom.window.document.getElementById('root')! };
}
test('preload stages the first tree without changing layout dimensions and reveals only after synchronous claim', () => {
  let f!: ReturnType<typeof fixture>;
  const requests: string[] = [];
  f = fixture((input) => {
    requests.push(String(input.action));
    if (input.action === 'get') return intent;
    if (input.action === 'ready') return true;
    if (input.action === 'claim') {
      expect(f.dom.window.getComputedStyle(f.root).opacity).toBe('0');
      expect(f.root.style.width).toBe('');
      expect(f.root.style.paddingRight).toBe('');
      return true;
    }
    throw Error('unexpected request');
  });
  try {
    expect(f.dom.window.getComputedStyle(f.root).opacity).toBe('0');
    expect(f.root.getAttribute('aria-hidden')).toBe('true');
    const loading = f.dom.window.document.querySelector<HTMLElement>('[role="status"]')!;
    expect(loading.parentElement).toBe(f.dom.window.document.body);
    expect(loading.style.width).toBe('801px');
    const copy = f.bootstrap.browserDisplayIntent!()!;
    expect(Object.keys(copy).sort()).toEqual([
      'bounds',
      'height',
      'id',
      'sessionId',
      'storeId',
      'token',
      'width',
      'zoom',
    ]);
    Reflect.set(copy.bounds, 'x', 1);
    expect(f.bootstrap.browserDisplayIntent!()!.bounds.x).toBe(801);
    expect(
      f.bootstrap.claimBrowserDisplay!({
        action: 'present',
        id: 'page',
        bounds: intent.bounds,
      } as NativeBrowserRequest & { action: 'present' }),
    ).toBe(true);
    expect(f.dom.window.getComputedStyle(f.root).opacity).not.toBe('0');
    expect(f.root.hasAttribute('aria-hidden')).toBe(false);
    expect(f.dom.window.document.querySelector('[role="status"]')).toBeNull();
    expect(requests).toEqual(['get', 'ready', 'claim']);
    expect(f.events).toEqual(['stage', 'reveal']);
  } finally {
    f.dom.window.close();
  }
});
test('claim cancellation reveals only after the exact already-hidden receipt', () => {
  for (const failure of ['claim'] as const) {
    let hidden = false;
    const f = fixture((input, notify) => {
      if (input.action === 'get') return intent;
      if (input.action === failure) {
        hidden = true;
        return false;
      }
      if (input.action === 'ready') return true;
      if (input.action === 'cancel') {
        expect(hidden).toBe(true);
        return true;
      }
      notify({ token: intent.token });
      return true;
    });
    try {
      if (failure === 'claim') {
        expect(
          f.bootstrap.claimBrowserDisplay!({
            action: 'present',
            id: 'page',
            bounds: intent.bounds,
          }),
        ).toBe(false);
        expect(f.dom.window.getComputedStyle(f.root).opacity).not.toBe('0');
      }
    } finally {
      f.dom.window.close();
    }
  }
});

test('a candidate destroyed after get cannot leave the first Root staged or claim it was retained', () => {
  const actions: string[] = [];
  const f = fixture((input, notify) => {
    actions.push(String(input.action));
    if (input.action === 'get') {
      notify({ token: intent.token });
      return intent;
    }
    if (input.action === 'ready') return false;
    if (input.action === 'cancel') return true;
    throw Error('unexpected request');
  });
  try {
    expect(f.bootstrap.browserDisplayIntent!()).toBeNull();
    expect(f.dom.window.getComputedStyle(f.root).opacity).not.toBe('0');
    expect(f.dom.window.document.querySelector('[role="status"]')).toBeNull();
    expect(actions).toEqual(['get', 'ready', 'cancel']);
    expect(f.events).toEqual(['stage', 'reveal']);
  } finally {
    f.dom.window.close();
  }
});

test('no candidate leaves the ordinary Root untouched and a lost hide ACK never exposes it', () => {
  const f = fixture((input) => {
    expect(input).toEqual({ action: 'get' });
    return null;
  });
  try {
    expect(f.events).toEqual([]);
    expect(f.bootstrap.browserDisplayIntent!()).toBeNull();
    expect(f.dom.window.getComputedStyle(f.root).opacity).not.toBe('0');
    expect(f.dom.window.document.querySelector('[role="status"]')).toBeNull();
  } finally {
    f.dom.window.close();
  }
  const held = fixture((input) => (input.action === 'get' ? intent : input.action === 'ready'));
  try {
    expect(() => held.bootstrap.cancelBrowserDisplay!()).toThrow(
      'browser_display_cancel_unconfirmed',
    );
    expect(held.dom.window.getComputedStyle(held.root).opacity).toBe('0');
    expect(held.bootstrap.browserDisplayIntent!()?.id).toBe('page');
  } finally {
    held.dom.window.close();
  }
});

test('only an exact settled intent reveals the tree and restores its original accessibility state', () => {
  let settled!: (value: unknown) => void;
  const f = fixture((input, notify) => {
    settled = notify;
    if (input.action === 'get') return intent;
    if (input.action === 'ready') return true;
    throw Error('unexpected request');
  }, 'false');
  try {
    expect(f.root.getAttribute('aria-hidden')).toBe('true');
    settled({ token: 'b'.repeat(32) });
    expect(f.dom.window.getComputedStyle(f.root).opacity).toBe('0');
    settled({ token: intent.token });
    expect(f.dom.window.getComputedStyle(f.root).opacity).not.toBe('0');
    expect(f.root.getAttribute('aria-hidden')).toBe('false');
    expect(f.dom.window.document.querySelector('[role="status"]')).toBeNull();
    expect(f.bootstrap.browserDisplayIntent!()).toBeNull();
  } finally {
    f.dom.window.close();
  }
});

test('built preload removes its actual staging sheet with Electron 44.3 author-only removal semantics', async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../electron/preload.ts')],
    target: 'node',
    format: 'cjs',
    packages: 'bundle',
    external: ['electron'],
  });
  expect(built.success).toBe(true);
  const source = await built.outputs[0]!.text();
  for (const finish of ['claim', 'cancel'] as const) {
    const dom = new JSDOM('<!doctype html><div id="root"><button>Restored UI</button></div>');
    const sheets = {
      author: new Map<string, HTMLStyleElement>(),
      user: new Map<string, HTMLStyleElement>(),
    };
    let bridge!: NativeBrowserBridge,
      serial = 0;
    const removed: string[] = [];
    const requests: string[] = [];
    try {
      runInNewContext(source, {
        document: dom.window.document,
        structuredClone,
        exports: {},
        module: { exports: {} },
        require(name: string) {
          expect(name).toBe('electron');
          return {
            contextBridge: {
              exposeInMainWorld(_name: string, value: NativeBrowserBridge) {
                bridge = value;
              },
            },
            ipcRenderer: {
              sendSync(channel: string, input: { action: string; token?: string }) {
                expect(channel).toBe('kite:native:browser-display');
                requests.push(input.action);
                if (input.action === 'get') return intent;
                expect(input.token).toBe(intent.token);
                return true;
              },
              on() {},
              removeListener() {},
            },
            webFrame: {
              insertCSS(css: string, options?: { cssOrigin?: 'author' | 'user' }) {
                const origin = options?.cssOrigin ?? 'author',
                  key = String(++serial);
                const style = dom.window.document.createElement('style');
                style.textContent = css;
                dom.window.document.head.append(style);
                sheets[origin].set(key, style);
                return key;
              },
              removeInsertedCSS(key: string) {
                // v44.3 web_frame.cc590-598 omits Blink's origin argument.
                // Its pinned Chromium152 WebDocument defaults to author, and
                // StyleEngine::RemoveInjectedSheet searches only that list.
                const style = sheets.author.get(key);
                style?.remove();
                sheets.author.delete(key);
                removed.push(key);
              },
            },
            webUtils: {},
          };
        },
      });
      const root = dom.window.document.getElementById('root')!;
      expect(dom.window.getComputedStyle(root).opacity).toBe('0');
      expect(root.getAttribute('aria-hidden')).toBe('true');
      if (finish === 'claim')
        expect(
          bridge.claimBrowserDisplay!({ action: 'present', id: 'page', bounds: intent.bounds }),
        ).toBe(true);
      else bridge.cancelBrowserDisplay!();
      expect(dom.window.getComputedStyle(root).opacity).not.toBe('0');
      expect(dom.window.getComputedStyle(root).pointerEvents).not.toBe('none');
      expect(root.hasAttribute('aria-hidden')).toBe(false);
      expect(bridge.browserDisplayIntent!()).toBeNull();
      expect(sheets.author.size + sheets.user.size).toBe(0);
      expect(removed).toEqual(['1']);
      expect(requests).toEqual(['get', 'ready', finish]);
    } finally {
      dom.window.close();
    }
  }
});

test('built preload validates hosted calibration and independent readonly presentation subscriptions', async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../electron/preload.ts')],
    target: 'node',
    format: 'cjs',
    packages: 'bundle',
    external: ['electron'],
  });
  expect(built.success).toBe(true);
  let bridge!: NativeBrowserBridge, reply: unknown;
  const calls: { transport: string; channel: string; input: unknown }[] = [];
  const listeners = new Map<string, (_event: unknown, value: unknown) => void>();
  runInNewContext(await built.outputs[0]!.text(), {
    document: { defaultView: null },
    exports: {},
    module: { exports: {} },
    require(name: string) {
      expect(name).toBe('electron');
      return {
        contextBridge: {
          exposeInMainWorld(_name: string, value: NativeBrowserBridge) {
            bridge = value;
          },
        },
        ipcRenderer: {
          sendSync(channel: string, input: unknown) {
            if (channel === 'kite:native:browser-display') return null;
            calls.push({ transport: 'sync', channel, input });
            return reply;
          },
          async invoke(channel: string, input: unknown) {
            calls.push({ transport: 'async', channel, input });
            return reply;
          },
          on(channel: string, receive: (_event: unknown, value: unknown) => void) {
            listeners.set(channel, receive);
          },
          removeListener(channel: string, receive: (_event: unknown, value: unknown) => void) {
            expect(listeners.get(channel)).toBe(receive);
            listeners.delete(channel);
          },
        },
        webFrame: {},
        webUtils: {},
      };
    },
  });
  expect(typeof bridge.presentBrowserLayoutAsync).toBe('function');
  const input: Extract<NativeBrowserRequest, { action: 'present' }> = {
    action: 'present',
    id: 'page',
    bounds: intent.bounds,
    witness: { key: 'a'.repeat(24), step: 1 },
  };
  const state = {
    id: 'page',
    url: 'https://example.com/',
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  for (const transport of ['sync', 'async'] as const) {
    const read = (request = input) =>
      transport === 'sync'
        ? Promise.resolve().then(() => bridge.presentBrowserLayout!(request))
        : bridge.presentBrowserLayoutAsync!(request);
    reply = { ok: true, value: state, waiting: false };
    expect(await read()).toEqual({ state, waiting: false });
    expect(calls.at(-1)).toEqual({ transport, channel: nativeBrowserLayoutChannel, input });
    reply = { ok: true, value: state };
    expect(await read({ ...input, witness: undefined })).toEqual(state);
    reply = { ok: true, value: null };
    expect(await read({ ...input, witness: undefined })).toBeNull();
    reply = { ok: false, code: 'browser_page_scope_denied' };
    await expect(read()).rejects.toThrow('browser_page_scope_denied');
    reply = { ok: true, value: { id: 'unverified' }, waiting: false };
    await expect(read()).rejects.toThrow('invalid_browser_state');
    for (const invalid of [
      { waiting: 'yes' },
      { waiting: true, frozenKey: 'invalid', frozenWidth: 100, frozenHeight: 100 },
      { waiting: true, frozenKey: 'a'.repeat(32), frozenWidth: 0, frozenHeight: 100 },
    ]) {
      reply = { ok: true, value: state, ...invalid };
      await expect(read()).rejects.toThrow('invalid_browser_presentation');
    }
    reply = {
      ok: true,
      value: state,
      waiting: true,
      frozenKey: 'a'.repeat(32),
      frozenWidth: 100,
      frozenHeight: 200,
    };
    expect(await read()).toEqual({
      state,
      waiting: true,
      frozenKey: 'a'.repeat(32),
      frozenWidth: 100,
      frozenHeight: 200,
    });
  }
  const received: unknown[] = [];
  const stop = bridge.watchBrowserLayoutFrame!((value) => received.push(value));
  const ack = {
    id: 'page',
    scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 2 },
    presentationRevision: 1,
    key: 'a'.repeat(24),
    step: 2,
  };
  const valid = [
    { ...ack, presented: false },
    { ...ack, presented: true },
    { ...ack, presented: false, error: 'browser_presentation_unavailable' },
    { ...ack, scope: undefined, draft: 'a'.repeat(32), presented: true },
  ];
  for (const value of [
    ...valid,
    { ...ack, step: 1, presented: true },
    { ...ack, presented: 'yes' },
    { ...ack, error: 'browser_presentation_unavailable' },
    { ...ack, presented: true, error: 'browser_presentation_unavailable' },
    { ...ack, presented: false, error: 'arbitrary' },
    { ...ack, draft: 'a'.repeat(32) },
    { ...ack, scope: undefined },
    { ...ack, scope: undefined, draft: 'A'.repeat(32) },
  ])
    listeners.get(nativeBrowserLayoutFrameChannel)!(null, value);
  expect(received).toEqual(valid);
  const callsBeforePresentation = calls.length;
  const presentationRequests: unknown[] = [];
  const stopPresentation = bridge.watchBrowserPresentation!((value) =>
    presentationRequests.push(value),
  );
  const request = { id: 'page', key: 'b'.repeat(32), scope: ack.scope };
  const draftRequest = { id: 'draft-page', key: 'c'.repeat(32), draft: 'd'.repeat(32) };
  for (const value of [
    request,
    draftRequest,
    null,
    { id: request.id, key: request.key },
    { ...request, draft: draftRequest.draft },
    { ...request, scope: { storeId: 'store', sessionId: 'session', generation: 1 } },
    { ...request, scope: { ...request.scope, generation: 0 } },
    { ...request, key: 'B'.repeat(32) },
    { ...request, key: 'b'.repeat(24) },
    { ...draftRequest, draft: 'D'.repeat(32) },
    { ...request, lease: 'private-control' },
    { ...request, action: 'reload' },
  ])
    listeners.get(nativeBrowserPresentationChannel)!(null, value);
  expect(presentationRequests).toEqual([request, draftRequest]);
  expect(calls).toHaveLength(callsBeforePresentation);
  stop();
  expect(listeners.has(nativeBrowserLayoutFrameChannel)).toBe(false);
  expect(listeners.has(nativeBrowserPresentationChannel)).toBe(true);
  listeners.get(nativeBrowserPresentationChannel)!(null, request);
  expect(presentationRequests).toEqual([request, draftRequest, request]);
  stopPresentation();
  expect(listeners.has(nativeBrowserPresentationChannel)).toBe(false);
  expect(calls).toHaveLength(callsBeforePresentation);
});

test('built Root preload restores only bounded draft pages and never accepts their inventory as an ordinary page reply', async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../electron/preload.ts')],
    target: 'node',
    format: 'cjs',
    packages: 'bundle',
    external: ['electron'],
  });
  expect(built.success).toBe(true);
  let bridge!: NativeBrowserBridge, reply: unknown;
  const calls: unknown[][] = [];
  runInNewContext(await built.outputs[0]!.text(), {
    document: { defaultView: null },
    exports: {},
    module: { exports: {} },
    require() {
      return {
        contextBridge: {
          exposeInMainWorld(_name: string, value: NativeBrowserBridge) {
            bridge = value;
          },
        },
        ipcRenderer: {
          sendSync() {
            return null;
          },
          async invoke(...args: unknown[]) {
            calls.push(args);
            return reply;
          },
          on() {},
          removeListener() {},
        },
        webFrame: {},
        webUtils: {},
      };
    },
  });
  expect(typeof bridge.restoreBrowserDraft).toBe('function');
  const draft = 'a'.repeat(32),
    page = {
      id: 'draft-page',
      url: 'https://www.baidu.com/',
      title: 'Baidu',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
  reply = { ok: true, value: { pages: [page], activeId: page.id } };
  expect(await bridge.restoreBrowserDraft!(draft)).toEqual({ pages: [page], activeId: page.id });
  expect(calls.at(-1)).toEqual([nativeBrowserChannel, { action: 'restoreDraft', draft }]);
  await expect(bridge.browserRequest({ action: 'state', id: page.id, draft })).rejects.toThrow(
    'invalid_browser_state',
  );
  await expect(
    bridge.restoreBrowser({ storeId: 's', sessionId: 'e', generation: 1, viewSelection: 1 }),
  ).rejects.toThrow('invalid_browser_restore');
  const count = calls.length;
  for (const invalid of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), null, { draft }])
    await expect(bridge.restoreBrowserDraft!(invalid as string)).rejects.toThrow(
      'invalid_browser_request',
    );
  expect(calls).toHaveLength(count);
  for (const value of [
    null,
    [],
    {},
    { pages: [page, page] },
    { pages: [], activeId: page.id },
    { pages: Array.from({ length: 9 }, (_, i) => ({ ...page, id: `p${i}` })) },
    { pages: [page], draft },
    { pages: [page], scope: { storeId: 's', sessionId: 'e', generation: 1, viewSelection: 1 } },
    {
      pages: [
        {
          ...page,
          control: {
            phase: 'human',
            incarnation: 'incarnation',
            navigation: 0,
            sessionId: 'session',
          },
        },
      ],
    },
    { pages: [page], lease: 'not-authority' },
    page,
  ]) {
    reply = { ok: true, value };
    await expect(bridge.restoreBrowserDraft!(draft)).rejects.toThrow('invalid_browser_restore');
  }
  reply = { ok: true, value: { pages: [] } };
  expect(await bridge.restoreBrowserDraft!(draft)).toEqual({ pages: [] });
  reply = { ok: false, code: 'browser_draft_scope_denied' };
  await expect(bridge.restoreBrowserDraft!(draft)).rejects.toThrow('browser_draft_scope_denied');
});

test('built Root preload keeps Chrome context and Root-close markers private, bounded and distinct from page replies', async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../electron/preload.ts')],
    target: 'node',
    format: 'cjs',
    packages: 'bundle',
    external: ['electron'],
  });
  expect(built.success).toBe(true);
  let bridge!: NativeBrowserBridge & NativeBrowserChromeRootBridge, reply: unknown;
  const calls: unknown[][] = [];
  runInNewContext(await built.outputs[0]!.text(), {
    structuredClone,
    document: { defaultView: null },
    exports: {},
    module: { exports: {} },
    require() {
      return {
        contextBridge: {
          exposeInMainWorld(_name: string, value: typeof bridge) {
            bridge = value;
          },
        },
        ipcRenderer: {
          sendSync() {
            return null;
          },
          async invoke(...args: unknown[]) {
            calls.push(args);
            return reply;
          },
          on() {},
          removeListener() {},
        },
        webFrame: {},
        webUtils: {},
      };
    },
  });
  const draft = 'a'.repeat(32),
    owner = { draft };
  reply = undefined;
  await bridge.setBrowserPresentationContext!({ revision: 1, owner });
  expect(calls.at(-1)).toEqual([
    nativeBrowserChromeRootChannel,
    { action: 'context', revision: 1, owner },
  ]);
  await bridge.publishBrowserChrome(null, 1);
  expect(calls.at(-1)).toEqual([
    nativeBrowserChromeRootChannel,
    { action: 'publish', snapshot: null, context: 1 },
  ]);
  let count = calls.length;
  for (const invalid of [
    { revision: 0, owner },
    { revision: 1, owner: { draft: 'bad' } },
    { revision: 1, owner, extra: true },
    {},
  ])
    await expect(bridge.setBrowserPresentationContext!(invalid as never)).rejects.toThrow(
      'browser_chrome_context_invalid',
    );
  await expect(bridge.publishBrowserChrome(null, 0)).rejects.toThrow(
    'browser_chrome_context_invalid',
  );
  expect(calls).toHaveLength(count);
  reply = { ok: true };
  await expect(bridge.setBrowserPresentationContext!({ revision: 2, owner: null })).rejects.toThrow(
    'browser_chrome_context_invalid',
  );
  const receipt = {
    key: 'b'.repeat(32),
    witness: 'c'.repeat(24),
    bounds: { x: 600, y: 0, width: 400, height: 96, radius: 0 },
    width: 1000,
    height: 700,
  };
  reply = { ok: true, value: receipt };
  expect(await bridge.prepareBrowserClose!({ id: 'page', draft })).toEqual(receipt);
  expect(calls.at(-1)).toEqual([
    nativeBrowserChannel,
    { action: 'prepareClose', id: 'page', draft },
  ]);
  await expect(bridge.browserRequest({ action: 'state', id: 'page', draft })).rejects.toThrow(
    'invalid_browser_state',
  );
  for (const value of [
    { ...receipt, key: 'bad' },
    { ...receipt, witness: 'bad' },
    { ...receipt, bounds: { ...receipt.bounds, width: 401 } },
    { ...receipt, control: {} },
  ]) {
    reply = { ok: true, value };
    await expect(bridge.prepareBrowserClose!({ id: 'page' })).rejects.toThrow(
      'invalid_browser_close',
    );
  }
  count = calls.length;
  for (const invalid of [
    { id: '../bad' },
    { id: 'page', draft: 'bad' },
    { id: 'page', scope: {} },
    { id: 'page', action: 'grant' },
  ])
    await expect(bridge.prepareBrowserClose!(invalid as never)).rejects.toThrow(
      'invalid_browser_request',
    );
  expect(calls).toHaveLength(count);
  for (const [method, action] of [
    [bridge.confirmBrowserClose!, 'confirmClose'],
    [bridge.finishBrowserClose!, 'finishClose'],
    [bridge.cancelBrowserClose!, 'cancelClose'],
  ] as const) {
    reply = { ok: true, value: null };
    expect(await method(receipt.key)).toBeUndefined();
    expect(calls.at(-1)).toEqual([nativeBrowserChannel, { action, key: receipt.key }]);
    reply = { ok: true, value: receipt };
    await expect(method(receipt.key)).rejects.toThrow('invalid_browser_close');
    count = calls.length;
    await expect(method('bad')).rejects.toThrow('invalid_browser_request');
    expect(calls).toHaveLength(count);
    reply = { ok: false, code: 'browser_close_preparation_stale' };
    await expect(method(receipt.key)).rejects.toThrow('browser_close_preparation_stale');
  }
});

test('built Root preload validates bounded presentation preparation inputs and receipts without exposing it to pages', async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../electron/preload.ts')],
    target: 'node',
    format: 'cjs',
    packages: 'bundle',
    external: ['electron'],
  });
  expect(built.success).toBe(true);
  let bridge!: NativeBrowserBridge, reply: unknown;
  const calls: unknown[][] = [];
  runInNewContext(await built.outputs[0]!.text(), {
    document: { defaultView: null },
    exports: {},
    module: { exports: {} },
    require() {
      return {
        contextBridge: {
          exposeInMainWorld(_name: string, value: NativeBrowserBridge) {
            bridge = value;
          },
        },
        ipcRenderer: {
          sendSync() {
            return null;
          },
          async invoke(...args: unknown[]) {
            calls.push(args);
            return reply;
          },
          on() {},
          removeListener() {},
        },
        webFrame: {},
        webUtils: {},
      };
    },
  });
  expect(typeof bridge.prepareBrowserPresentation).toBe('function');
  expect(typeof bridge.cancelBrowserPreparation).toBe('function');
  const input = { fromId: 'original', targetId: 'retained' };
  reply = null;
  expect(await bridge.prepareBrowserPresentation!(input)).toBeNull();
  expect(calls.at(-1)).toEqual(['kite:native:browser-preparation', input]);
  reply = { key: 'a'.repeat(32) };
  expect(await bridge.prepareBrowserPresentation!(input)).toEqual({ key: 'a'.repeat(32) });
  for (const invalid of [
    true,
    { key: 'invalid' },
    { key: 'a'.repeat(32), authority: true },
    { key: 'A'.repeat(32) },
  ]) {
    reply = invalid;
    await expect(bridge.prepareBrowserPresentation!(input)).rejects.toThrow(
      'invalid_browser_preparation',
    );
  }
  for (const input of [
    { fromId: 'same', targetId: 'same' },
    { fromId: 'x', targetId: '../bad' },
    { fromId: 'x', targetId: 'y', url: 'https://example.com' },
  ]) {
    const count = calls.length;
    await expect(bridge.prepareBrowserPresentation!(input)).rejects.toThrow(
      'invalid_browser_preparation',
    );
    expect(calls).toHaveLength(count);
  }
  reply = undefined;
  await bridge.cancelBrowserPreparation!('a'.repeat(32));
  expect(calls.at(-1)).toEqual(['kite:native:browser-preparation-cancel', 'a'.repeat(32)]);
  reply = { ok: true };
  await expect(bridge.cancelBrowserPreparation!('a'.repeat(32))).rejects.toThrow(
    'invalid_browser_preparation',
  );
  const count = calls.length;
  await expect(bridge.cancelBrowserPreparation!('unknown')).rejects.toThrow(
    'invalid_browser_preparation',
  );
  expect(calls).toHaveLength(count);
});

test('ineffective stylesheet removal cancels the live handoff without falsely clearing pending or accessibility state', () => {
  const actions: string[] = [];
  const f = fixture(
    (input) => {
      actions.push(String(input.action));
      return input.action === 'get' ? intent : true;
    },
    undefined,
    false,
  );
  try {
    expect(() =>
      f.bootstrap.claimBrowserDisplay!({ action: 'present', id: 'page', bounds: intent.bounds }),
    ).toThrow('browser_display_reveal_failed');
    expect(actions).toEqual(['get', 'ready', 'claim', 'cancel']);
    expect(f.bootstrap.browserDisplayIntent!()?.token).toBe(intent.token);
    expect(f.dom.window.getComputedStyle(f.root).opacity).toBe('0');
    expect(f.root.getAttribute('aria-hidden')).toBe('true');
    expect(f.dom.window.document.querySelector('[role="status"]')).not.toBeNull();
  } finally {
    f.dom.window.close();
  }
});
