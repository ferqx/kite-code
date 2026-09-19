import type { BranchSnapshot, KiteDesktopBridge } from '../src/bridge';

export type DesktopTestCall = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Adapts existing service fixtures to the named renderer bridge contract. */
export function createTestDesktopBridge(call: DesktopTestCall): KiteDesktopBridge {
  return {
    listProjects: () => call('list_projects'),
    runtimeStatus: () => call('runtime_status'),
    runtimeStartupStatus: () => call('runtime_startup_status'),
    saveStartupDiagnostic: () => call('save_startup_diagnostic'),
    pickWorkspace: () => call('pick_workspace'),
    activateWorkspace: (path) => call('activate_workspace', { path }),
    checkWorkspace: (path) => call('check_workspace', { path }),
    queryWorkspaceBranch: (workspace) => call('query_workspace_branch', { workspace }),
    switchWorkspaceBranch: (expected: BranchSnapshot, branch) =>
      call('switch_workspace_branch', { expected, branch }),
    runtimeOpen: () => call('runtime_open'),
    runtimeSend: (connectionId, frame) => call('runtime_send', { connectionId, frame }),
    runtimeReceive: (connectionId) => call('runtime_receive', { connectionId }),
    runtimeDetach: (connectionId) => call('runtime_detach', { connectionId }),
    runtimeClose: (connectionId) => call('runtime_close', { connectionId }),
    openEditor: (connectionId, path, editor) => call('open_editor', { connectionId, path, editor }),
    writeClipboardText: (text) => call('write_clipboard_text', { text }),
    toggleWindowMaximize: () => call('animated_toggle_maximize'),
    setTheme: async () => {},
    showConfirm: (options) => call('show_confirm', { ...options }),
  };
}
