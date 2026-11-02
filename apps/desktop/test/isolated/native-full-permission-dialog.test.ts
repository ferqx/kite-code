import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerNativeFullPermissionDialogIpc } from '../../electron/native-full-permission-dialog';
import type { NativeRootWindow } from '../../electron/native-root-window';
import {
  type NativeFullPermissionConfirmationReply,
  nativeFullPermissionConfirmationCancelChannel,
  nativeFullPermissionConfirmationChannel,
} from '../../src/native-bridge';

const rendererUrl = 'http://localhost:2042/native.html';
class Parent extends EventEmitter {
  destroyed = false;
  visible = true;
  minimized = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: rendererUrl },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  });
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
}

function fixture(url = rendererUrl) {
  const ipcMain = new EventEmitter();
  let handler!: (
    event: IpcMainInvokeEvent,
    input: unknown,
  ) => Promise<NativeFullPermissionConfirmationReply>;
  const handlers = new Set<string>();
  Object.assign(ipcMain, {
    handle(channel: string, receive: typeof handler) {
      handlers.add(channel);
      handler = receive;
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  });
  let parent: Parent | undefined = new Parent();
  parent.webContents.mainFrame.url = url;
  const original = parent;
  const dialogs: {
    parent: NativeRootWindow;
    language: 'zh' | 'en';
    signal: AbortSignal;
    resolve: (value: boolean) => void;
    reject: (cause: unknown) => void;
  }[] = [];
  const dispose = registerNativeFullPermissionDialogIpc({
    ipcMain: ipcMain as unknown as IpcMain,
    window: () => parent as unknown as NativeRootWindow | undefined,
    rendererUrl: url,
    showDialog(parent, language, signal) {
      return new Promise<boolean>((resolve, reject) => {
        dialogs.push({ parent, language, signal, resolve, reject });
      });
    },
  });
  const event = () =>
    ({
      sender: parent!.webContents,
      senderFrame: parent!.webContents.mainFrame,
    }) as unknown as IpcMainInvokeEvent;
  return {
    original,
    dialogs,
    handlers,
    ipcMain,
    dispose,
    event,
    replace(next: Parent | undefined) {
      parent = next;
    },
    invoke: (input: unknown = { requestId: 'request-1', language: 'zh' }, sender = event()) =>
      handler(sender, input),
    cancel: (input: unknown, sender = event()) =>
      ipcMain.emit(nativeFullPermissionConfirmationCancelChannel, sender, input),
    tick: async () => {
      await Promise.resolve();
    },
  };
}

test('only the current Root receives a parented boolean confirmation and completion removes listeners', async () => {
  const f = fixture();
  try {
    expect(f.handlers.has(nativeFullPermissionConfirmationChannel)).toBe(true);
    for (const value of [false, true]) {
      const result = f.invoke({ requestId: `request-${value}`, language: 'en' });
      await f.tick();
      const dialog = f.dialogs.at(-1)!;
      expect(dialog.parent).toBe(f.original as unknown as NativeRootWindow);
      expect(dialog.language).toBe('en');
      expect(dialog.signal.aborted).toBe(false);
      dialog.resolve(value);
      expect(await result).toEqual({ ok: true, value });
      expect(f.original.eventNames()).toHaveLength(0);
      expect(f.original.webContents.eventNames()).toHaveLength(0);
    }
  } finally {
    f.dispose();
  }
});

test('exact bounded payloads reject extra content, unsupported languages, accessors and malformed IDs', async () => {
  const f = fixture();
  try {
    for (const input of [
      null,
      [],
      {},
      { requestId: 'ok' },
      { requestId: 'ok', language: 'en', text: '<script>untrusted</script>' },
      { requestId: 'ok', language: 'fr' },
      { requestId: '', language: 'zh' },
      { requestId: 'a'.repeat(129), language: 'zh' },
      { requestId: 'not an ID', language: 'zh' },
      { requestId: 1, language: 'zh' },
      { requestId: 'ok', language: 'zh', [Symbol('extra')]: true },
      Object.create({ requestId: 'inherited', language: 'zh' }),
      Object.defineProperty({ requestId: 'ok' }, 'language', {
        get() {
          throw Error('the accessor must not execute');
        },
      }),
    ])
      expect(await f.invoke(input)).toEqual({ ok: false, code: 'invalid_native_request' });
    expect(f.dialogs).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

test('foreign WebContents, subframes, external pages and wrong paths cannot open the dialog', async () => {
  const f = fixture();
  try {
    const root = f.event();
    for (const event of [
      { ...root, sender: new Parent().webContents },
      { ...root, senderFrame: { url: rendererUrl } },
      { ...root, senderFrame: null },
    ])
      expect(await f.invoke(undefined, event as IpcMainInvokeEvent)).toEqual({
        ok: false,
        code: 'native_sender_denied',
      });
    for (const url of [
      'https://outside.test/native.html',
      'http://localhost:2042/other.html',
      'bad',
    ]) {
      f.original.webContents.mainFrame.url = url;
      expect(await f.invoke()).toEqual({ ok: false, code: 'native_sender_denied' });
    }
    expect(f.dialogs).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

test('file Root admission requires the exact local file', async () => {
  const f = fixture('file:///application/native.html');
  try {
    f.original.webContents.mainFrame.url = 'file:///other/native.html';
    expect(await f.invoke()).toEqual({ ok: false, code: 'native_sender_denied' });
    expect(f.dialogs).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

test('a missing, destroyed, hidden, minimized or destroyed-renderer parent cannot open a modal', async () => {
  for (const state of ['missing', 'destroyed', 'hidden', 'minimized', 'renderer-destroyed']) {
    const f = fixture();
    const event = f.event();
    try {
      if (state === 'missing') f.replace(undefined);
      if (state === 'destroyed') f.original.destroyed = true;
      if (state === 'hidden') f.original.visible = false;
      if (state === 'minimized') f.original.minimized = true;
      if (state === 'renderer-destroyed') f.original.webContents.destroyed = true;
      expect(await f.invoke(undefined, event)).toEqual({
        ok: false,
        code: ['missing', 'destroyed'].includes(state)
          ? 'native_sender_denied'
          : 'native_full_permission_confirmation_unavailable',
      });
      expect(f.dialogs).toHaveLength(0);
    } finally {
      f.dispose();
    }
  }
});

test('duplicate and concurrent requests are busy; only the matching Root cancellation retires its dialog', async () => {
  const f = fixture();
  try {
    const result = f.invoke();
    await f.tick();
    for (const requestId of ['request-1', 'request-2'])
      expect(await f.invoke({ requestId, language: 'zh' })).toEqual({
        ok: false,
        code: 'native_full_permission_confirmation_busy',
      });
    const old = f.dialogs[0]!;
    f.cancel({ requestId: 'other' });
    f.cancel({ requestId: 'request-1', extra: true });
    f.cancel({ requestId: 'request-1' }, {
      ...f.event(),
      senderFrame: { url: rendererUrl },
    } as IpcMainInvokeEvent);
    f.cancel({ requestId: 'request-1' }, {
      ...f.event(),
      sender: new Parent().webContents,
    } as unknown as IpcMainInvokeEvent);
    expect(old.signal.aborted).toBe(false);
    f.cancel({ requestId: 'request-1' });
    expect(old.signal.aborted).toBe(true);
    expect(await result).toEqual({
      ok: false,
      code: 'native_full_permission_confirmation_cancelled',
    });
    const next = f.invoke({ requestId: 'request-2', language: 'en' });
    await f.tick();
    old.resolve(true);
    await f.tick();
    expect(f.dialogs[1]!.signal.aborted).toBe(false);
    expect(await f.invoke({ requestId: 'request-3', language: 'zh' })).toEqual({
      ok: false,
      code: 'native_full_permission_confirmation_busy',
    });
    f.dialogs[1]!.resolve(false);
    expect(await next).toEqual({ ok: true, value: false });
  } finally {
    f.dispose();
  }
});

for (const event of ['hide', 'minimize', 'closed', 'render-process-gone', 'destroyed', 'dispose'])
  test(`${event} aborts the modal promptly and ignores a late affirmative result`, async () => {
    const f = fixture();
    try {
      const result = f.invoke();
      await f.tick();
      const dialog = f.dialogs[0]!;
      if (event === 'dispose') f.dispose();
      else if (event === 'render-process-gone' || event === 'destroyed')
        f.original.webContents.emit(event);
      else f.original.emit(event);
      expect(dialog.signal.aborted).toBe(true);
      expect(await result).toEqual({
        ok: false,
        code: 'native_full_permission_confirmation_cancelled',
      });
      dialog.resolve(true);
      await f.tick();
      expect(f.original.eventNames()).toHaveLength(0);
      expect(f.original.webContents.eventNames()).toHaveLength(0);
      f.dispose();
      expect(f.handlers.size).toBe(0);
      expect(f.ipcMain.listenerCount(nativeFullPermissionConfirmationCancelChannel)).toBe(0);
    } finally {
      f.dispose();
    }
  });

test('subframe navigation leaves the Root modal alone, while Root navigation aborts it', async () => {
  const f = fixture();
  try {
    const result = f.invoke();
    await f.tick();
    f.original.webContents.emit('did-start-navigation', { isMainFrame: false });
    expect(f.dialogs[0]!.signal.aborted).toBe(false);
    f.original.webContents.emit('did-start-navigation', { isMainFrame: true });
    expect(f.dialogs[0]!.signal.aborted).toBe(true);
    expect(await result).toEqual({
      ok: false,
      code: 'native_full_permission_confirmation_cancelled',
    });
  } finally {
    f.dispose();
  }
});

test('a replaced parent or main frame cannot receive the old affirmative result', async () => {
  for (const replacement of ['window', 'frame']) {
    const f = fixture();
    try {
      const result = f.invoke();
      await f.tick();
      if (replacement === 'window') f.replace(new Parent());
      else f.original.webContents.mainFrame = { url: rendererUrl };
      f.dialogs[0]!.resolve(true);
      expect(await result).toEqual({
        ok: false,
        code: 'native_full_permission_confirmation_cancelled',
      });
      expect(f.dialogs[0]!.signal.aborted).toBe(true);
      const next = f.invoke({ requestId: 'successor', language: 'zh' });
      await f.tick();
      f.dialogs[1]!.resolve(false);
      expect(await next).toEqual({ ok: true, value: false });
    } finally {
      f.dispose();
    }
  }
});

test('cancellation or parent replacement before showing never opens a stale native dialog', async () => {
  for (const change of ['cancel', 'replace', 'hide', 'dispose']) {
    const f = fixture();
    try {
      const result = f.invoke();
      if (change === 'cancel') f.cancel({ requestId: 'request-1' });
      if (change === 'replace') f.replace(new Parent());
      if (change === 'hide') f.original.visible = false;
      if (change === 'dispose') f.dispose();
      expect(await result).toEqual({
        ok: false,
        code: 'native_full_permission_confirmation_cancelled',
      });
      expect(f.dialogs).toHaveLength(0);
      expect(f.original.eventNames()).toHaveLength(0);
      expect(f.original.webContents.eventNames()).toHaveLength(0);
    } finally {
      f.dispose();
    }
  }
});

test('the renderer URL is rechecked after the modal and dialog failures reveal no private error text', async () => {
  const f = fixture();
  try {
    const navigated = f.invoke();
    await f.tick();
    f.original.webContents.mainFrame.url = 'https://outside.test/';
    f.dialogs[0]!.resolve(true);
    expect(await navigated).toEqual({ ok: false, code: 'native_sender_denied' });
    f.original.webContents.mainFrame.url = rendererUrl;
    const failed = f.invoke({ requestId: 'failed', language: 'en' });
    await f.tick();
    f.dialogs[1]!.reject(Error('/private/path: sensitive native error'));
    expect(await failed).toEqual({ ok: false, code: 'native_full_permission_confirmation_failed' });
    const invalid = f.invoke({ requestId: 'invalid-result', language: 'en' });
    await f.tick();
    f.dialogs[2]!.resolve('affirmative' as unknown as boolean);
    expect(await invalid).toEqual({
      ok: false,
      code: 'native_full_permission_confirmation_failed',
    });
  } finally {
    f.dispose();
  }
});
