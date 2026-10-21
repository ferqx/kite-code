import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { nativeBrowserChannel } from '../../src/native-browser-bridge';

type Request = Pick<Electron.OnBeforeRequestListenerDetails, 'url' | 'resourceType'>;
let beforeRequest:
  | ((details: Request, complete: (value: { cancel: boolean }) => void) => void)
  | null;
const browsing = Object.assign(new EventEmitter(), {
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  webRequest: {
    onBeforeRequest(listener: typeof beforeRequest) {
      beforeRequest = listener;
    },
  },
});
mock.module('electron', () => ({
  session: { fromPartition: () => browsing },
  WebContentsView: class {
    constructor() {
      throw Error('unexpected_browser_view');
    }
  },
}));
const { registerNativeBrowserIpc } = await import('../../electron/native-browser');

test('isolated browser allows credential-free WebSocket subresources but not WebSocket navigation', () => {
  const rendererUrl = 'http://127.0.0.1:3000/';
  const frame = { url: rendererUrl };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  }) as unknown as BrowserWindow;
  type Handler = (event: IpcMainInvokeEvent, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const close = registerNativeBrowserIpc({ ipcMain, window, rendererUrl });
  const allowed = (url: string, resourceType: Request['resourceType']) => {
    let cancel: boolean | undefined;
    beforeRequest!({ url, resourceType }, (result) => {
      cancel = result.cancel;
    });
    return cancel === false;
  };
  try {
    for (const protocol of ['ws', 'wss']) {
      const url = `${protocol}://127.0.0.1:3001/live`;
      expect(allowed(url, 'webSocket')).toBe(true);
      for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'other'] as const)
        expect(allowed(url, resourceType)).toBe(false);
      expect(allowed(`${protocol}://user:secret@localhost/live`, 'webSocket')).toBe(false);
      expect(
        handlers.get(nativeBrowserChannel)!(
          { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
          { action: 'navigate', id: 'browser', input: url },
        ),
      ).toEqual({ ok: false, code: 'unsupported_browser_protocol' });
    }
    expect(allowed('https://example.com/page', 'mainFrame')).toBe(true);
    expect(allowed('http://localhost:3000/script.js', 'script')).toBe(true);
    for (const url of ['file:///private.txt', 'javascript:alert(1)', 'kite://open'])
      expect(allowed(url, 'webSocket')).toBe(false);
    expect(allowed('http://user:secret@localhost/', 'mainFrame')).toBe(false);
  } finally {
    close();
  }
  expect(beforeRequest).toBeNull();
});
