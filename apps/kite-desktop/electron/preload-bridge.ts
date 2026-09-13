import {
  DESKTOP_IPC_CHANNELS,
  type DesktopIpcChannel,
  type DesktopIpcResult,
  type KiteDesktopBridge,
} from '../src/bridge';

export type DesktopIpcInvoke = <T>(
  channel: DesktopIpcChannel,
  payload?: unknown,
) => Promise<DesktopIpcResult<T>>;

export function createPreloadBridge(call: DesktopIpcInvoke): Readonly<KiteDesktopBridge> {
  const invoke = async <T>(channel: DesktopIpcChannel, payload?: unknown): Promise<T> => {
    const result = await call<T>(channel, payload);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  return Object.freeze({
    listProjects: () => invoke(DESKTOP_IPC_CHANNELS.listProjects),
    runtimeStatus: () => invoke(DESKTOP_IPC_CHANNELS.runtimeStatus),
    pickWorkspace: () => invoke(DESKTOP_IPC_CHANNELS.pickWorkspace),
    activateWorkspace: (path) => invoke(DESKTOP_IPC_CHANNELS.activateWorkspace, { path }),
    checkWorkspace: (path) => invoke(DESKTOP_IPC_CHANNELS.checkWorkspace, { path }),
    queryWorkspaceBranch: (workspace) =>
      invoke(DESKTOP_IPC_CHANNELS.queryWorkspaceBranch, { workspace }),
    switchWorkspaceBranch: (expected, branch) =>
      invoke(DESKTOP_IPC_CHANNELS.switchWorkspaceBranch, { expected, branch }),
    runtimeOpen: () => invoke(DESKTOP_IPC_CHANNELS.runtimeOpen),
    runtimeSend: (connectionId, frame) =>
      invoke(DESKTOP_IPC_CHANNELS.runtimeSend, { connectionId, frame }),
    runtimeReceive: (connectionId) => invoke(DESKTOP_IPC_CHANNELS.runtimeReceive, { connectionId }),
    runtimeDetach: (connectionId) => invoke(DESKTOP_IPC_CHANNELS.runtimeDetach, { connectionId }),
    runtimeClose: (connectionId) => invoke(DESKTOP_IPC_CHANNELS.runtimeClose, { connectionId }),
    openEditor: (connectionId, path, editor) =>
      invoke(DESKTOP_IPC_CHANNELS.openEditor, { connectionId, path, editor }),
    writeClipboardText: (text) => invoke(DESKTOP_IPC_CHANNELS.writeClipboardText, { text }),
    toggleWindowMaximize: () => invoke(DESKTOP_IPC_CHANNELS.toggleWindowMaximize),
    showConfirm: (options) => invoke(DESKTOP_IPC_CHANNELS.showConfirm, options),
  } satisfies KiteDesktopBridge);
}
