import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContentsView } from 'electron';
import {
  type PreviewMenu,
  type PreviewMenuState,
  previewMenuActiveChannel,
  previewMenuCloseChannel,
  previewMenuEventChannel,
  previewMenuOpenChannel,
  previewMenuStateChannel,
} from '../src/native-preview-menu-bridge';
import { createNativeModalSurface, nativeModalRecord } from './native-modal-surface';
import type { NativeRootWindow } from './native-root-window';

function isPreviewMenu(value: unknown): value is PreviewMenu {
  if (!nativeModalRecord(value)) return false;
  const { id, anchor, label, options, value: selected } = value;
  return (
    Object.keys(value).sort().join(',') === 'anchor,id,label,options,value' &&
    typeof id === 'string' &&
    /^[a-f0-9-]{36}$/.test(id) &&
    typeof label === 'string' &&
    label.length > 0 &&
    label.length <= 64 &&
    typeof selected === 'string' &&
    selected.length > 0 &&
    selected.length <= 32 &&
    nativeModalRecord(anchor) &&
    Object.keys(anchor).sort().join(',') === 'height,width,x,y' &&
    Object.values(anchor).every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 32768,
    ) &&
    Number(anchor.width) > 0 &&
    Number(anchor.height) > 0 &&
    Array.isArray(options) &&
    options.length > 0 &&
    options.length <= 12 &&
    options.every((option: unknown) => {
      if (!nativeModalRecord(option)) return false;
      const keys = Object.keys(option).sort().join(',');
      return (
        (keys === 'label,value' || keys === 'disabled,label,value') &&
        typeof option.value === 'string' &&
        option.value.length > 0 &&
        option.value.length <= 32 &&
        typeof option.label === 'string' &&
        option.label.length > 0 &&
        option.label.length <= 64 &&
        (option.disabled === undefined || typeof option.disabled === 'boolean')
      );
    }) &&
    new Set(options.map((option) => option.value)).size === options.length
  );
}

/** Geometry and menu choices only. Preview control still goes through the original Root owner. */
export function createNativePreviewMenuHost(options: {
  window: NativeRootWindow;
  ipcMain: IpcMain;
  rootUrl: string;
  url: string;
  createView(): WebContentsView;
  theme(): 'light' | 'dark';
  higherModalActive(): boolean;
}) {
  const root = options.window.webContents;
  let pending:
    | {
        state: NonNullable<PreviewMenuState>;
        resolve(value: string | null): void;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const send = () => surface.send(previewMenuStateChannel, pending?.state ?? null);
  const finish = (value: string | null = null) => {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimeout(current.timer);
    surface.setActive(false);
    send();
    current.resolve(value);
  };
  const cancel = () => finish();
  const surface = createNativeModalSurface({
    ...options,
    priority: 10,
    activeChannel: previewMenuActiveChannel,
    unavailable: 'native_preview_menu_unavailable',
    cancel,
    unavailableError: cancel,
  });
  const fromRoot = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    !root.isDestroyed() &&
    event.sender === root &&
    event.senderFrame === root.mainFrame &&
    event.senderFrame?.url.split('#')[0] === options.rootUrl;
  const open = (event: IpcMainInvokeEvent, input: unknown): Promise<string | null> | null => {
    if (
      !fromRoot(event) ||
      !surface.available() ||
      options.higherModalActive() ||
      !isPreviewMenu(input)
    )
      return null;
    const [width = 0, height = 0] = options.window.getContentSize();
    const zoom = root.getZoomFactor();
    if (
      input.anchor.x + input.anchor.width > width / zoom + 1 ||
      input.anchor.y + input.anchor.height > height / zoom + 1
    )
      return null;
    cancel();
    return new Promise((resolve) => {
      const state = { ...input, theme: options.theme() };
      pending = { state, resolve, timer: setTimeout(cancel, 6000) };
      surface.setActive(true);
      void surface
        .prepare()
        .then(() => {
          if (pending?.state === state) {
            send();
            surface.present();
          }
        })
        .catch(() => {
          if (pending?.state === state) cancel();
        });
    });
  };
  const close = (event: IpcMainEvent, id: unknown) => {
    if (fromRoot(event) && pending?.state.id === id) cancel();
  };
  const onOverlay = (event: IpcMainEvent, input: unknown) => {
    if (!surface.accepts(event) || !nativeModalRecord(input)) return;
    if (input.type === 'ready' && Object.keys(input).length === 1) {
      surface.initialized();
      return;
    }
    if (!pending || input.id !== pending.state.id) return;
    if (input.type === 'shown' && Object.keys(input).length === 2) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
      return;
    }
    if (input.type !== 'finish' || Object.keys(input).length !== 3) return;
    const value = input.value;
    finish(
      !pending.timer &&
        !options.higherModalActive() &&
        typeof value === 'string' &&
        pending.state.options.some((option) => option.value === value && !option.disabled)
        ? value
        : null,
    );
  };
  const dispose = () => {
    cancel();
    options.ipcMain.removeHandler(previewMenuOpenChannel);
    options.ipcMain.off(previewMenuCloseChannel, close);
    options.ipcMain.off(previewMenuEventChannel, onOverlay);
    options.window.off('blur', cancel);
    options.window.off('resize', cancel);
    surface.dispose();
  };
  options.ipcMain.handle(previewMenuOpenChannel, open);
  options.ipcMain.on(previewMenuCloseChannel, close);
  options.ipcMain.on(previewMenuEventChannel, onOverlay);
  options.window.on('blur', cancel);
  options.window.on('resize', cancel);
  options.window.once('closed', dispose);
}
