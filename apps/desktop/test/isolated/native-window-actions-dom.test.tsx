import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeDirectory,
  NativeRequest,
  NativeState,
  NativeWindowBridge,
} from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, originals);
bootstrap.window.close();

test('actual Native page retains the original header filters, both double-click callbacks and draft on host failure with zero work', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    }),
    restore = prepareDesktopDom(dom),
    prior = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
    };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const directory: NativeDirectory = { storeId: 'store', workspaces: [], sessions: [] },
    state: NativeState = {
      generation: 1,
      directory,
      creationSubmissions: [],
      inputSubmissions: [],
      permissionSubmissions: [],
      interactionSubmissions: [],
    },
    calls: NativeRequest[] = [];
  let zooms = 0,
    fail = false;
  const bridge: NativeBridge & NativeWindowBridge = {
    request: async (request) => {
      calls.push(request);
      if (request.method === 'directory') return directory;
      if (request.method === 'conversation.models.read')
        return {
          kind: 'settings.models',
          observationId: 1,
          scope: 'user',
          storeId: 'store',
          canWrite: false,
          defaultModelId: null,
          errors: ['model_not_configured'],
          models: [],
        };
      return state;
    },
    watch: () => () => {},
    writeClipboardText: async () => {
      throw Error('clipboard_not_used_by_header');
    },
    toggleWindowMaximize: async () => {
      zooms++;
      if (fail) throw Error('native_window_failed');
    },
  };
  Object.assign(dom.window, { kiteNative: bridge });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const down = async (target: Element, detail: number, button = 0) =>
    act(async () => {
      target.dispatchEvent(
        new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button, detail }),
      );
    });
  try {
    await act(async () => root.render(<NativeDesktop />));
    const header = host.querySelector('.session-header')!,
      sidebar = host.querySelector('.sidebar-header')!,
      draft = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="新对话草稿"]')!;
    expect(header).not.toBeNull();
    expect(sidebar).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        draft,
        '原草稿\n雪🙂',
      );
      draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const before = calls.length;
    await down(header, 1);
    await down(header, 2, 2);
    await down(header, 3);
    await down(sidebar.querySelector('button')!, 2);
    expect(zooms).toBe(0);
    await down(header, 2);
    await down(sidebar, 2);
    expect(zooms).toBe(2);
    fail = true;
    await down(header, 2);
    expect(zooms).toBe(3);
    expect(dom.window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'native_window_failed',
    );
    expect(draft.value).toBe('原草稿\n雪🙂');
    expect(calls.length).toBe(before);
    expect(
      calls.every((request) =>
        ['attach', 'directory', 'conversation.models.read', 'state'].includes(request.method),
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restore();
    Object.assign(globalThis, prior);
  }
});
