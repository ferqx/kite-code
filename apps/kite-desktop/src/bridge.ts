export interface DesktopProject {
  path: string;
  directoryMissing?: boolean;
  lastOpenedAt: number;
}

export interface BranchSnapshot {
  workspace: string;
  repository: boolean;
  root: string | null;
  current: string | null;
  head: string | null;
  branches: readonly string[];
  dirty: boolean;
  canSwitch: boolean;
}

export interface DesktopConnectionInfo {
  connectionId: number;
  workspace: string;
  expectedServerVersion: string;
}

export interface DesktopRuntimeStatus {
  workspace: string | null;
  connectionId: number | null;
}

export interface DesktopStartupStatus {
  phase:
    | 'inspecting'
    | 'acquiring_maintenance'
    | 'waiting_for_store'
    | 'preparing'
    | 'publishing'
    | 'ready'
    | null;
  message: string | null;
  diagnosticAvailable: boolean;
}

export type DesktopEditor = 'vscode' | 'zed' | 'textedit';
export type DesktopTheme = 'light' | 'dark' | 'system';

export interface DesktopConfirmOptions {
  message: string;
  title: string;
  kind: 'warning' | 'info';
  okLabel?: string;
  cancelLabel?: string;
}

export type DesktopIpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The complete API exposed to the sandboxed renderer by Electron's preload. */
export interface KiteDesktopBridge {
  listProjects(): Promise<DesktopProject[]>;
  runtimeStatus(): Promise<DesktopRuntimeStatus>;
  runtimeStartupStatus(): Promise<DesktopStartupStatus>;
  saveStartupDiagnostic(): Promise<boolean>;
  pickWorkspace(): Promise<string | null>;
  activateWorkspace(path: string): Promise<string>;
  checkWorkspace(path: string): Promise<void>;
  queryWorkspaceBranch(workspace: string): Promise<BranchSnapshot>;
  switchWorkspaceBranch(expected: BranchSnapshot, branch: string): Promise<BranchSnapshot>;
  runtimeOpen(): Promise<DesktopConnectionInfo>;
  runtimeSend(connectionId: number, frame: string): Promise<void>;
  runtimeReceive(connectionId: number): Promise<string>;
  runtimeDetach(connectionId: number): Promise<void>;
  runtimeClose(connectionId: number): Promise<void>;
  openEditor(connectionId: number, path: string, editor: DesktopEditor): Promise<void>;
  writeClipboardText(text: string): Promise<void>;
  toggleWindowMaximize(): Promise<void>;
  setTheme(theme: DesktopTheme): Promise<void>;
  showConfirm(options: DesktopConfirmOptions): Promise<boolean>;
}

export const DESKTOP_IPC_CHANNELS = {
  listProjects: 'kite:desktop:list-projects',
  runtimeStatus: 'kite:desktop:runtime-status',
  runtimeStartupStatus: 'kite:desktop:runtime-startup-status',
  saveStartupDiagnostic: 'kite:desktop:save-startup-diagnostic',
  pickWorkspace: 'kite:desktop:pick-workspace',
  activateWorkspace: 'kite:desktop:activate-workspace',
  checkWorkspace: 'kite:desktop:check-workspace',
  queryWorkspaceBranch: 'kite:desktop:query-workspace-branch',
  switchWorkspaceBranch: 'kite:desktop:switch-workspace-branch',
  runtimeOpen: 'kite:desktop:runtime-open',
  runtimeSend: 'kite:desktop:runtime-send',
  runtimeReceive: 'kite:desktop:runtime-receive',
  runtimeDetach: 'kite:desktop:runtime-detach',
  runtimeClose: 'kite:desktop:runtime-close',
  openEditor: 'kite:desktop:open-editor',
  writeClipboardText: 'kite:desktop:write-clipboard-text',
  toggleWindowMaximize: 'kite:desktop:toggle-window-maximize',
  setTheme: 'kite:desktop:set-theme',
  showConfirm: 'kite:desktop:show-confirm',
} as const satisfies Record<keyof KiteDesktopBridge, string>;

export type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

declare global {
  interface Window {
    readonly kiteDesktop?: KiteDesktopBridge;
  }
}
