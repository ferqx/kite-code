import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createBrowserDisplayBootstrap } from '../../electron/browser-display-bootstrap';
import type {
  NativeBrowserBridge,
  NativeBrowserDisplayIntent,
  NativeBrowserRequest,
} from '../../src/native-browser-bridge';

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
