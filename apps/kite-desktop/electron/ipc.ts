import { type BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC_CHANNELS, type DesktopIpcChannel, type DesktopIpcResult } from '../src/bridge';
import type { DesktopHost } from './host';
import {
  assertTrustedIpc,
  confirmPayload,
  connectionPayload,
  editorPayload,
  noPayload,
  pathPayload,
  runtimeSendPayload,
  switchPayload,
  workspacePayload,
} from './security';

export interface DesktopIpcOptions {
  ipcMain: IpcMain;
  host: DesktopHost;
  getWindow: () => BrowserWindow | undefined;
  rendererUrl: string;
}

export function registerDesktopIpc(options: DesktopIpcOptions): void {
  const handle = <T>(
    channel: DesktopIpcChannel,
    operation: (event: IpcMainInvokeEvent, payload: unknown) => Promise<T> | T,
  ) => {
    options.ipcMain.handle(
      channel,
      async (event, payload: unknown): Promise<DesktopIpcResult<T>> => {
        try {
          assertTrustedIpc(event, options.getWindow(), options.rendererUrl);
          return { ok: true, value: await operation(event, payload) };
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
      },
    );
  };

  handle(DESKTOP_IPC_CHANNELS.listProjects, (_event, payload) => {
    noPayload(payload);
    return options.host.listProjects();
  });
  handle(DESKTOP_IPC_CHANNELS.runtimeStatus, (_event, payload) => {
    noPayload(payload);
    return options.host.runtimeStatus();
  });
  handle(DESKTOP_IPC_CHANNELS.pickWorkspace, async (_event, payload) => {
    noPayload(payload);
    const window = requireWindow(options.getWindow());
    const selected = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    });
    if (selected.canceled || selected.filePaths.length !== 1) return null;
    const path = selected.filePaths[0];
    if (!path) return null;
    return options.host.rememberPickedWorkspace(path);
  });
  handle(DESKTOP_IPC_CHANNELS.activateWorkspace, (_event, payload) => {
    const { path } = pathPayload(payload);
    return options.host.activateWorkspace(path);
  });
  handle(DESKTOP_IPC_CHANNELS.checkWorkspace, (_event, payload) => {
    const { path } = pathPayload(payload);
    options.host.checkWorkspace(path);
  });
  handle(DESKTOP_IPC_CHANNELS.queryWorkspaceBranch, (_event, payload) => {
    const { workspace } = workspacePayload(payload);
    return options.host.queryWorkspaceBranch(workspace);
  });
  handle(DESKTOP_IPC_CHANNELS.switchWorkspaceBranch, (_event, payload) => {
    const { expected, branch } = switchPayload(payload);
    return options.host.switchWorkspaceBranch(expected, branch);
  });
  handle(DESKTOP_IPC_CHANNELS.runtimeOpen, (_event, payload) => {
    noPayload(payload);
    return options.host.runtimeOpen();
  });
  handle(DESKTOP_IPC_CHANNELS.runtimeSend, (_event, payload) => {
    const { connectionId, frame } = runtimeSendPayload(payload);
    return options.host.runtimeSend(connectionId, frame);
  });
  handle(DESKTOP_IPC_CHANNELS.runtimeReceive, (_event, payload) => {
    const { connectionId } = connectionPayload(payload);
    return options.host.runtimeReceive(connectionId);
  });
  handle(DESKTOP_IPC_CHANNELS.runtimeDetach, (_event, payload) => {
    const { connectionId } = connectionPayload(payload);
    return options.host.runtimeDetach(connectionId);
  });
  handle(DESKTOP_IPC_CHANNELS.runtimeClose, (_event, payload) => {
    const { connectionId } = connectionPayload(payload);
    return options.host.runtimeClose(connectionId);
  });
  handle(DESKTOP_IPC_CHANNELS.openEditor, (_event, payload) => {
    const { connectionId, path, editor } = editorPayload(payload);
    return options.host.openEditor(connectionId, path, editor);
  });
  handle(DESKTOP_IPC_CHANNELS.toggleWindowMaximize, (_event, payload) => {
    noPayload(payload);
    const window = requireWindow(options.getWindow());
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  handle(DESKTOP_IPC_CHANNELS.showConfirm, async (_event, payload) => {
    const confirm = confirmPayload(payload);
    const result = await dialog.showMessageBox(requireWindow(options.getWindow()), {
      type: confirm.kind,
      title: confirm.title,
      message: confirm.message,
      buttons: [confirm.okLabel ?? '确定', confirm.cancelLabel ?? '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      normalizeAccessKeys: true,
    });
    return result.response === 0;
  });
}

function requireWindow(window: BrowserWindow | undefined): BrowserWindow {
  if (!window || window.isDestroyed()) throw new Error('主窗口不可用。');
  return window;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
