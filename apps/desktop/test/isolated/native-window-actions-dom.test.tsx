import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeDirectory,
  NativeDraft,
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

const bootstrap = new JSDOM('<!doctype html><div></div>', { pretendToBeVisual: true });
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
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
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
  let failure: unknown = Error('native_window_failed');
  let pendingZoom: Promise<void> | undefined;
  let savedDraft: NativeDraft = {
    id: 'preparation-draft',
    storeId: directory.storeId,
    workspaceId: 'new-conversation',
    rootSessionId: 'new-conversation',
    revision: 1,
    content: '原草稿\n雪🙂',
  };
  let menuAction: ((action: NativeWindowMenuAction) => void) | undefined;
  let pendingMenu: Promise<void> | undefined;
  const menuRequests: NativeWindowMenuRequest[] = [];
  const bridge: NativeBridge & NativeWindowBridge & NativeWindowMenuBridge = {
    confirmFullPermission: async () => false,
    cancelFullPermissionConfirmation() {},
    showWindowMenu: async (request) => {
      menuRequests.push(request);
      await pendingMenu;
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
      if (request.method === 'draft.read' && request.sessionId === 'new-conversation')
        return savedDraft;
      if (request.method === 'draft.write' && request.sessionId === 'new-conversation') {
        expect(request.revision).toBe(savedDraft.revision);
        savedDraft = { ...savedDraft, content: request.content, revision: savedDraft.revision + 1 };
        return savedDraft;
      }
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
      if (request.method === 'settings.general.shell.read')
        return {
          kind: 'settings.general.shell',
          storeId: directory.storeId,
          preference: 'powershell',
          automatic: 'powershell',
          gitBashAvailable: false,
          powerShellAvailable: true,
          powerShellVersion: null,
          powerShell7Version: null,
        };
      if (request.method === 'workspace.pick') return null;
      return state;
    },
    watch: () => () => {},
    writeClipboardText: async () => {
      throw Error('clipboard_not_used_by_header');
    },
    toggleWindowMaximize: async () => {
      zooms++;
      if (pendingZoom) return pendingZoom;
      if (fail) throw failure;
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
    expect(header.parentElement?.closest('.native-window-titlebar')).not.toBeNull();
    expect(host.querySelector('.client-main-panel .session-header')).toBeNull();
    expect(
      host
        .querySelector<HTMLDivElement>('.client-main-panel')
        ?.style.getPropertyValue('--session-header-height'),
    ).toBe('0px');
    expect(sidebar).not.toBeNull();
    expect(dom.window.document.querySelector('.native-toast')).toBeNull();
    expect(promptValue(draft)).toBe('原草稿\n雪🙂');
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
    expect(dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(
      dom.window.document.querySelector('.native-toast [role="status"]')?.textContent,
    ).toContain('调整窗口大小遇到问题，请先查看当前状态。');
    expect(dom.window.document.body.textContent).not.toContain('native_window_failed');
    expect(host.querySelector('.session-view .native-toast')).toBeNull();
    expect(dom.window.document.querySelector('.native-toast')?.parentElement).toBe(
      dom.window.document.body,
    );
    for (const cause of [Error('private detail\n at internal/path'), null]) {
      failure = cause;
      await down(header, 2);
      const text = dom.window.document.querySelector('.native-toast [role="status"]')?.textContent;
      expect(text).toContain('调整窗口大小遇到问题，请先查看当前状态。');
      expect(text).not.toContain('结果');
      expect(text).not.toContain('private');
    }
    expect(promptValue(draft)).toBe('原草稿\n雪🙂');
    expect(calls.length).toBe(before);
    expect(
      calls.every((request) =>
        ['attach', 'directory', 'conversation.models.read', 'draft.read', 'state'].includes(
          request.method,
        ),
      ),
    ).toBe(true);
    const menuButtons = host.querySelectorAll<HTMLButtonElement>(
      '.native-window-titlebar button[aria-haspopup="menu"]',
    );
    expect(menuButtons).toHaveLength(1);
    const menuButton = menuButtons[0]!;
    expect(menuButton.getAttribute('aria-label')).toBe('应用菜单');
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
    let rejectMenu!: (reason: Error) => void;
    pendingMenu = new Promise<void>((_resolve, reject) => {
      rejectMenu = reject;
    });
    await act(async () => {
      draft.focus();
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10' }));
    });
    expect(dom.window.document.activeElement).toBe(menuButton);
    expect(menuRequests).toEqual([]);
    await act(async () => {
      menuButton.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      menuButton.click();
    });
    const rootMenu: NativeWindowMenuRequest = {
      menu: 'application',
      x: 0,
      y: 0,
      applicationEnabled: true,
    };
    expect(menuRequests).toEqual([rootMenu]);
    expect(menuButton.getAttribute('aria-expanded')).toBe('true');
    expect(menuButton.hasAttribute('title')).toBe(false);
    expect(dom.window.document.activeElement).toBe(draft);
    await act(async () => rejectMenu(Error('native_window_menu_failed')));
    pendingMenu = undefined;
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
    expect(menuButton.title).toBe('应用菜单');
    expect(host.querySelector('.native-window-menu-error')?.textContent).toBe(
      '菜单打开失败，请重试。',
    );
    await act(async () => menuButton.click());
    expect(menuRequests).toEqual([rootMenu, rootMenu]);
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.native-window-menu-error')).toBeNull();
    for (const key of ['f', 'e', 'v', 'h']) {
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, altKey: true }));
      });
    }
    expect(menuRequests.slice(2)).toEqual(
      (['file', 'edit', 'view', 'help'] as const).map((menu) => ({ ...rootMenu, menu })),
    );
    expect(calls.length).toBe(before);
    const editedDraft = '已编辑草稿\n雪🙂';
    await act(async () => {
      await setPromptText(draft, editedDraft);
    });
    await act(async () => menuAction!('new-conversation'));
    expect(promptValue(draft)).toBe(editedDraft);
    expect(savedDraft.content).toBe(editedDraft);
    expect(calls.slice(before).map((request) => request.method)).toEqual([
      'draft.write',
      'conversation.models.read',
    ]);
    let rejectZoom!: (reason: Error) => void;
    pendingZoom = new Promise<void>((_resolve, reject) => {
      rejectZoom = reject;
    });
    await down(header, 2);
    expect(zooms).toBe(6);
    await act(async () => menuAction!('settings'));
    const settings = dom.window.document.querySelector<HTMLElement>('.desktop-settings-dialog')!;
    expect(settings).not.toBeNull();
    await act(async () => rejectZoom(Error('native_window_failed')));
    pendingZoom = undefined;
    expect(dom.window.document.querySelector('.native-toast')).toBeNull();
    await act(async () => menuAction!('add-workspace'));
    expect(settings.isConnected).toBe(true);
    expect(calls.some((request) => request.method === 'workspace.pick')).toBe(false);
    const focusGuard = dom.window.document.querySelector<HTMLElement>('[data-radix-focus-guard]')!;
    expect(focusGuard).not.toBeNull();
    await act(async () => focusGuard.focus());
    expect(dom.window.document.querySelector('.desktop-settings-dialog')).not.toBeNull();
    const outsidePointer = new dom.window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 2,
    });
    await act(async () => dom.window.document.documentElement.dispatchEvent(outsidePointer));
    expect(outsidePointer.defaultPrevented).toBe(true);
    expect(dom.window.document.querySelector('.desktop-settings-dialog')).not.toBeNull();
    const editor = settings.querySelector<HTMLButtonElement>('[aria-label="默认编辑器"]')!;
    await act(async () =>
      editor.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(dom.window.document.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(dom.window.document.querySelector('[role="listbox"]')).toBeNull();
    expect(dom.window.document.querySelector('.desktop-settings-dialog')).not.toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(dom.window.document.activeElement).toBe(editor);
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(dom.window.document.querySelector('.desktop-settings-dialog')).toBeNull();
    expect(dom.window.document.querySelector('.native-toast')).toBeNull();
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
    ).toBe(editedDraft);
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
