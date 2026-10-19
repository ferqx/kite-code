import type { BrowserWindow, Input, IpcMain, MenuItemConstructorOptions } from 'electron';
import type { NativeReply } from '../src/native-bridge';
import {
  type NativeWindowMenuAction,
  type NativeWindowMenuRequest,
  nativeWindowMenuChannel,
} from '../src/native-menu-bridge';
import { assertNativeSender } from './native-ipc';

export function nativeWindowMenuTemplate(options: {
  applicationEnabled: boolean;
  dispatch: (action: NativeWindowMenuAction) => void;
}): MenuItemConstructorOptions[] {
  return [
    {
      id: 'file',
      label: '文件',
      submenu: [
        {
          label: '新对话',
          accelerator: 'Ctrl+N',
          registerAccelerator: false,
          enabled: options.applicationEnabled,
          click: () => options.dispatch('new-conversation'),
        },
        {
          label: '添加空间…',
          accelerator: 'Ctrl+O',
          registerAccelerator: false,
          enabled: options.applicationEnabled,
          click: () => options.dispatch('add-workspace'),
        },
        {
          label: '设置…',
          accelerator: 'Ctrl+,',
          registerAccelerator: false,
          enabled: options.applicationEnabled,
          click: () => options.dispatch('settings'),
        },
        { type: 'separator' },
        { label: '隐藏窗口', role: 'close' },
        { label: '退出', role: 'quit', accelerator: 'Ctrl+Q' },
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '删除', role: 'delete' },
        { type: 'separator' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      id: 'view',
      label: '视图',
      submenu: [
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '切换全屏', role: 'togglefullscreen' },
      ],
    },
    { id: 'help', label: '帮助', submenu: [{ label: '关于 Kite', role: 'about' }] },
  ];
}

export function nativeWindowMenuShortcut(input: Input): NativeWindowMenuAction | undefined {
  if (
    input.type !== 'keyDown' ||
    input.isAutoRepeat ||
    input.isComposing ||
    !input.control ||
    input.alt ||
    input.meta ||
    input.shift
  )
    return undefined;
  const key = input.key.toLowerCase();
  if (key === 'n') return 'new-conversation';
  if (key === 'o') return 'add-workspace';
  if (key === ',') return 'settings';
  return undefined;
}

/** A window-only port; application actions still enter the existing renderer controller. */
export function registerNativeWindowMenuIpc(options: {
  ipcMain: IpcMain;
  window: () => BrowserWindow | undefined;
  rendererUrl: string;
  platform: string;
  showMenu: (window: BrowserWindow, request: NativeWindowMenuRequest) => Promise<void>;
}) {
  options.ipcMain.handle(
    nativeWindowMenuChannel,
    async (event, payload: unknown): Promise<NativeReply> => {
      try {
        const window = options.window();
        assertNativeSender(event, window, options.rendererUrl);
        if (options.platform !== 'win32') throw Error('native_window_menu_unavailable');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          throw Error('invalid_native_request');
        const input = payload as Record<string, unknown>;
        if (
          Object.keys(input).length !== 4 ||
          !Object.keys(input).every((key) =>
            ['menu', 'x', 'y', 'applicationEnabled'].includes(key),
          ) ||
          !['file', 'edit', 'view', 'help'].includes(input.menu as string) ||
          typeof input.applicationEnabled !== 'boolean' ||
          !Number.isSafeInteger(input.x) ||
          !Number.isSafeInteger(input.y)
        )
          throw Error('invalid_native_request');
        const [width, height] = window!.getContentSize();
        if (width === undefined || height === undefined) throw Error('native_window_menu_failed');
        const zoom = window!.webContents.getZoomFactor();
        const x = (input.x as number) * zoom,
          y = (input.y as number) * zoom;
        if (x < 0 || x > width || y < 0 || y > height) throw Error('invalid_native_request');
        await options.showMenu(window!, {
          menu: input.menu as NativeWindowMenuRequest['menu'],
          applicationEnabled: input.applicationEnabled,
          x: Math.round(x),
          y: Math.round(y),
        });
        return { ok: true, value: null };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return {
          ok: false,
          code: [
            'native_sender_denied',
            'invalid_native_request',
            'native_window_menu_unavailable',
          ].includes(code)
            ? code
            : 'native_window_menu_failed',
        };
      }
    },
  );
  return () => options.ipcMain.removeHandler(nativeWindowMenuChannel);
}
