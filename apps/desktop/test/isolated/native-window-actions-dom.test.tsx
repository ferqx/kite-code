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
import type {
  NativeWindowMenuAction,
  NativeWindowMenuBridge,
  NativeWindowMenuRequest,
} from '../../src/native-menu-bridge';
import { prepareDesktopDom, promptValue, setPromptText } from '../native-page-dom.fixture';

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

test('actual Native page retains window actions and connects Windows menus to the existing controller without sending work', async () => {
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
  dom.window.document.documentElement.dataset.platform = 'windows';
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
    fail = false,
    menuUnsubscribed = false;
  let menuAction: ((action: NativeWindowMenuAction) => void) | undefined;
  const menuRequests: NativeWindowMenuRequest[] = [];
  const bridge: NativeBridge & NativeWindowBridge & NativeWindowMenuBridge = {
    showWindowMenu: async (request) => {
      menuRequests.push(request);
    },
    watchWindowMenuAction: (listener) => {
      menuAction = listener;
      return () => {
        menuUnsubscribed = true;
        menuAction = undefined;
      };
    },
    getWindowAppearance: async () => ({ backgroundMaterial: 'none' }),
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
    await act(async () => root.render(<NativeDesktop nativeWindow />));
    const header = host.querySelector('.session-header')!,
      sidebar = host.querySelector('.sidebar-header')!,
      draft = host.querySelector<HTMLElement>('[role="textbox"][aria-label="新对话草稿"]')!;
    expect(header).not.toBeNull();
    expect(sidebar).not.toBeNull();
    await act(async () => {
      await setPromptText(draft, '原草稿\n雪🙂');
    });
    const before = calls.length;
    await down(header, 1);
    await down(header, 2, 2);
    await down(header, 3);
    await down(host.querySelector('button[aria-label="收起侧栏"]')!, 2);
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
    expect(promptValue(draft)).toBe('原草稿\n雪🙂');
    expect(calls.length).toBe(before);
    expect(
      calls.every((request) =>
        ['attach', 'directory', 'conversation.models.read', 'state'].includes(request.method),
      ),
    ).toBe(true);
    const menus = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="menubar"] [role="menuitem"]'),
    );
    expect(menus.map((menu) => menu.textContent)).toEqual(['文件', '编辑', '视图', '帮助']);
    await act(async () => menus[1]!.click());
    expect(menuRequests).toEqual([{ menu: 'edit', x: 0, y: 0, applicationEnabled: true }]);
    expect(calls.length).toBe(before);
    await act(async () => menuAction!('new-conversation'));
    expect(promptValue(draft)).toBe('原草稿\n雪🙂');
    expect(calls.length).toBe(before);
    await act(async () => menuAction!('settings'));
    expect(dom.window.document.querySelector('.desktop-settings-dialog')).not.toBeNull();
    expect(menus[0]!.closest('[aria-hidden="true"]')).toBeNull();
    await act(async () => menuAction!('add-workspace'));
    expect(dom.window.document.querySelector('.desktop-settings-dialog')).toBeNull();
    expect(
      calls.slice(before).filter((request) => request.method === 'workspace.pick'),
    ).toHaveLength(1);
    expect(
      calls.some((request) =>
        ['conversation.submit', 'input.submit', 'session.create', 'cancel'].includes(
          request.method,
        ),
      ),
    ).toBe(false);
    expect(
      promptValue(host.querySelector<HTMLElement>('[role="textbox"][aria-label="新对话草稿"]')),
    ).toBe('原草稿\n雪🙂');
  } finally {
    await act(async () => root.unmount());
    expect(menuUnsubscribed).toBe(true);
    // FocusScope dispatches its unmount event on the next timer turn in this DOM realm.
    await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
    dom.window.close();
    restore();
    Object.assign(globalThis, prior);
  }
});
