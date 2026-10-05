import { expect, test } from 'bun:test';
import type { BrowserClient } from '@kite-ai/client/browser';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WebPage } from '../src/page';

async function fixture(preference?: string, width = 1024, unavailableStorage = false) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://127.0.0.1:31000/',
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  if (preference !== undefined)
    dom.window.localStorage.setItem('kite.web.navigationWidth.v1', preference);
  if (unavailableStorage)
    Object.defineProperty(dom.window, 'localStorage', {
      get() {
        throw Error('denied');
      },
    });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const reads: string[] = [];
  const client = {
    serverInfo: { storeId: 'store', capabilities: [] },
    async listAllWorkspaces() {
      reads.push('directory');
      return [{ id: 'w', name: 'Workspace' }];
    },
    async listAllSessions() {
      reads.push('sessions');
      return [session('a'), session('b')];
    },
    async getView(id: string) {
      reads.push(`view:${id}`);
      return {
        storeId: 'store',
        snapshotCursor: '1',
        session: session(id),
        runs: [],
        executions: [],
        messages: [],
      };
    },
    async listMessages(id: string) {
      reads.push(`messages:${id}`);
      return [
        {
          id: `message-${id}`,
          sessionId: id,
          runId: 'run',
          seq: '1',
          status: 'complete',
          role: 'user',
          content: `Original ${id} body`,
        },
      ];
    },
  } as unknown as BrowserClient;
  function session(id: string) {
    return {
      id,
      workspaceId: 'w',
      parentSessionId: null,
      title: `Session ${id}`,
      controlRevision: '1',
      contextSelectionId: 'selection',
      nextSeq: '1',
      deletedAt: null,
    };
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  const browser = dom.window as unknown as Window;
  async function render(suspended = false) {
    await act(async () => {
      root.render(
        <WebPage client={client} window={browser} suspended={suspended} pollIntervalMs={10000} />,
      );
      await Bun.sleep(0);
    });
  }
  await render();
  const document = dom.window.document;
  const nav = () => document.querySelector<HTMLElement>('nav')!;
  const separator = () => document.querySelector<HTMLElement>('hr[aria-label="Resize directory"]')!;
  const button = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Bun.sleep(0);
    });
  }
  async function key(element: Element, name: string) {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    });
  }
  async function pointer(element: EventTarget, type: string, x: number, id = 1) {
    await act(async () => {
      const event = new dom.window.MouseEvent(type, {
        clientX: x,
        button: 0,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'pointerId', { value: id });
      element.dispatchEvent(event);
    });
  }
  async function resize(next: number) {
    await act(async () => {
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: next });
      dom.window.dispatchEvent(new dom.window.Event('resize'));
    });
  }
  return {
    dom,
    document,
    reads,
    nav,
    separator,
    button,
    render,
    click,
    key,
    pointer,
    resize,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('pointer resizing clamps bounds, ignores another pointer, folds and restores last valid width without business reads', async () => {
  const f = await fixture();
  try {
    expect(f.separator().getAttribute('aria-valuenow')).toBe('200');
    const before = [...f.reads];
    await f.pointer(f.separator(), 'pointerdown', 200);
    await f.pointer(f.dom.window, 'pointermove', 360, 2);
    expect(f.separator().getAttribute('aria-valuenow')).toBe('200');
    await f.pointer(f.dom.window, 'pointercancel', 360, 2);
    await f.pointer(f.dom.window, 'pointermove', 1000);
    expect(f.separator().getAttribute('aria-valuenow')).toBe('420');
    await f.pointer(f.dom.window, 'pointerup', 320);
    expect(f.separator().getAttribute('aria-valuenow')).toBe('320');
    expect(f.dom.window.localStorage.getItem('kite.web.navigationWidth.v1')).toBe('320');
    await f.resize(900);
    expect(f.separator().getAttribute('aria-valuenow')).toBe('320');
    await f.pointer(f.separator(), 'pointerdown', 320);
    await f.pointer(f.dom.window, 'pointerup', 20);
    expect(f.nav().hidden).toBe(true);
    expect(f.document.activeElement).toBe(f.button('Open directory'));
    await f.click(f.button('Open directory'));
    expect(f.separator().getAttribute('aria-valuenow')).toBe('320');
    await f.pointer(f.separator(), 'pointerdown', 320);
    await f.pointer(f.dom.window, 'pointerup', 150);
    expect(f.separator().getAttribute('aria-valuenow')).toBe('200');
    expect(f.reads).toEqual(before);
  } finally {
    await f.close();
  }
});

test('keyboard separator has bounded ARIA values and local finite preferences, with storage failure and cancellation fallback', async () => {
  for (const preference of [
    'NaN',
    'Infinity',
    '-2',
    '421',
    '199',
    '320px',
    ' 320',
    '320.5',
    '{"width":320}',
    '9'.repeat(1000),
  ]) {
    const f = await fixture(preference);
    try {
      expect(f.separator().getAttribute('aria-valuenow')).toBe('200');
    } finally {
      await f.close();
    }
  }
  const f = await fixture('310');
  try {
    const bar = f.separator();
    expect(bar.getAttribute('aria-orientation')).toBe('vertical');
    expect(bar.getAttribute('aria-controls')).toBe(f.nav().id);
    expect(bar.getAttribute('aria-valuemin')).toBe('200');
    expect(bar.getAttribute('aria-valuemax')).toBe('420');
    expect(bar.tabIndex).toBe(0);
    await f.key(bar, 'ArrowRight');
    expect(bar.getAttribute('aria-valuenow')).toBe('320');
    await f.key(bar, 'End');
    expect(bar.getAttribute('aria-valuenow')).toBe('420');
    await f.key(bar, 'Home');
    await f.key(bar, 'ArrowLeft');
    expect(bar.getAttribute('aria-valuenow')).toBe('200');
    await f.pointer(bar, 'pointerdown', 200);
    await f.pointer(f.dom.window, 'pointermove', 390);
    await f.pointer(f.dom.window, 'pointercancel', 390);
    expect(bar.getAttribute('aria-valuenow')).toBe('200');
    expect(f.dom.window.localStorage.getItem('kite.web.navigationWidth.v1')).toBe('200');
    await f.key(bar, 'Enter');
    expect(f.nav().hidden).toBe(true);
    await f.click(f.button('Open directory'));
    expect(f.separator().getAttribute('aria-valuenow')).toBe('200');
  } finally {
    await f.close();
  }
  const unavailable = await fixture(undefined, 1024, true);
  try {
    await unavailable.key(unavailable.separator(), 'End');
    expect(unavailable.separator().getAttribute('aria-valuenow')).toBe('420');
  } finally {
    await unavailable.close();
  }
});

test('narrow directory opening, exact session selection and Escape preserve selected history while responsive layout and suspension only cancel the drag', async () => {
  const f = await fixture('340', 600);
  try {
    expect(f.nav().hidden).toBe(true);
    await f.click(f.button('Open directory'));
    await f.click(
      [...f.document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Workspace',
      )!,
    );
    await f.click(f.document.querySelector('a[href="/sessions/a"]')!);
    expect(f.nav().hidden).toBe(true);
    expect(f.document.querySelector('[aria-label=History]')!.textContent).toContain(
      'Original a body',
    );
    const before = [...f.reads];
    await f.click(f.button('Open directory'));
    await f.key(f.nav(), 'Escape');
    expect(f.nav().hidden).toBe(true);
    expect(f.document.activeElement).toBe(f.button('Open directory'));
    await f.click(f.button('Open directory'));
    f.button('Close directory').focus();
    await f.key(f.button('Close directory'), 'Escape');
    expect(f.nav().hidden).toBe(true);
    expect(f.document.activeElement).toBe(f.button('Open directory'));
    await f.resize(1024);
    expect(f.separator().getAttribute('aria-valuenow')).toBe('340');
    await f.pointer(f.separator(), 'pointerdown', 340);
    await f.pointer(f.dom.window, 'pointermove', 400);
    await f.render(true);
    expect(f.separator().getAttribute('aria-valuenow')).toBe('340');
    expect(f.document.querySelector('[aria-label=History]')!.textContent).toContain(
      'Original a body',
    );
    expect(f.reads).toEqual(before);
    await f.render(false);
    await f.resize(600);
    expect(f.nav().hidden).toBe(true);
    expect(f.document.querySelector('[aria-label=History]')!.textContent).toContain(
      'Original a body',
    );
  } finally {
    await f.close();
  }
});
