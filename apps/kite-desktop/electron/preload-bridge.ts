import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_QUIT_INSPECTION_CHANNELS,
  type DesktopIpcChannel,
  type DesktopIpcResult,
  type KiteDesktopBridge,
} from '../src/bridge';

export type DesktopIpcInvoke = <T>(
  channel: DesktopIpcChannel | typeof DESKTOP_QUIT_INSPECTION_CHANNELS.result,
  payload?: unknown,
) => Promise<DesktopIpcResult<T>>;

export type DesktopIpcSubscribe = (
  channel: typeof DESKTOP_QUIT_INSPECTION_CHANNELS.request,
  listener: (requestId: number) => void,
) => () => void;

export function createPreloadBridge(
  call: DesktopIpcInvoke,
  subscribe: DesktopIpcSubscribe = () => () => undefined,
): Readonly<KiteDesktopBridge> {
  const invoke = async <T>(
    channel: DesktopIpcChannel | typeof DESKTOP_QUIT_INSPECTION_CHANNELS.result,
    payload?: unknown,
  ): Promise<T> => {
    const result = await call<T>(channel, payload);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  return Object.freeze({
    watchQuitInspection: (inspect) =>
      subscribe(DESKTOP_QUIT_INSPECTION_CHANNELS.request, (requestId) => {
        void inspect()
          .then((hasActiveTasks) =>
            invoke(DESKTOP_QUIT_INSPECTION_CHANNELS.result, { requestId, hasActiveTasks }),
          )
          .catch(() =>
            invoke(DESKTOP_QUIT_INSPECTION_CHANNELS.result, {
              requestId,
              hasActiveTasks: true,
            }),
          );
      }),
    listProjects: () => invoke(DESKTOP_IPC_CHANNELS.listProjects),
    runtimeStatus: () => invoke(DESKTOP_IPC_CHANNELS.runtimeStatus),
    runtimeStartupStatus: () => invoke(DESKTOP_IPC_CHANNELS.runtimeStartupStatus),
    saveStartupDiagnostic: () => invoke(DESKTOP_IPC_CHANNELS.saveStartupDiagnostic),
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
    setTheme: (theme) => invoke(DESKTOP_IPC_CHANNELS.setTheme, { theme }),
    showConfirm: (options) => invoke(DESKTOP_IPC_CHANNELS.showConfirm, options),
  } satisfies KiteDesktopBridge);
}
