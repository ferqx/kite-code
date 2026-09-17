import { expect, test } from 'bun:test';
import { createPreloadBridge, type DesktopIpcInvoke } from '../electron/preload-bridge';
import { type BranchSnapshot, DESKTOP_IPC_CHANNELS } from '../src/bridge';

const branch: BranchSnapshot = {
  workspace: '/project',
  repository: true,
  root: '/project',
  current: 'main',
  head: 'abc',
  branches: ['main', 'feature'],
  dirty: false,
  canSwitch: true,
};

test('preload exposes only frozen named methods with fixed channels and payloads', async () => {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const invoke: DesktopIpcInvoke = async <T>(channel: string, payload?: unknown) => {
    calls.push({ channel, payload });
    return { ok: true, value: undefined as T };
  };
  const bridge = createPreloadBridge(invoke);

  expect(Object.isFrozen(bridge)).toBe(true);
  expect(Object.keys(bridge).sort()).toEqual(Object.keys(DESKTOP_IPC_CHANNELS).sort());
  for (const forbidden of ['invoke', 'send', 'on', 'once', 'removeListener', 'ipcRenderer'])
    expect(forbidden in bridge).toBe(false);

  await bridge.listProjects();
  await bridge.runtimeStatus();
  await bridge.runtimeStartupStatus();
  await bridge.saveStartupDiagnostic();
  await bridge.pickWorkspace();
  await bridge.activateWorkspace('/project');
  await bridge.checkWorkspace('/project');
  await bridge.queryWorkspaceBranch('/project');
  await bridge.switchWorkspaceBranch(branch, 'feature');
  await bridge.runtimeOpen();
  await bridge.runtimeSend(7, '{"jsonrpc":"2.0"}');
  await bridge.runtimeReceive(7);
  await bridge.runtimeDetach(7);
  await bridge.runtimeClose(7);
  await bridge.openEditor(7, 'src/main.ts', 'vscode');
  await bridge.writeClipboardText('Agent 最终回复');
  await bridge.toggleWindowMaximize();
  await bridge.showConfirm({
    message: '继续？',
    title: '确认',
    kind: 'warning',
    okLabel: '继续',
    cancelLabel: '取消',
  });

  expect(calls).toEqual([
    { channel: DESKTOP_IPC_CHANNELS.listProjects, payload: undefined },
    { channel: DESKTOP_IPC_CHANNELS.runtimeStatus, payload: undefined },
    { channel: DESKTOP_IPC_CHANNELS.runtimeStartupStatus, payload: undefined },
    { channel: DESKTOP_IPC_CHANNELS.saveStartupDiagnostic, payload: undefined },
    { channel: DESKTOP_IPC_CHANNELS.pickWorkspace, payload: undefined },
    { channel: DESKTOP_IPC_CHANNELS.activateWorkspace, payload: { path: '/project' } },
    { channel: DESKTOP_IPC_CHANNELS.checkWorkspace, payload: { path: '/project' } },
    {
      channel: DESKTOP_IPC_CHANNELS.queryWorkspaceBranch,
      payload: { workspace: '/project' },
    },
    {
      channel: DESKTOP_IPC_CHANNELS.switchWorkspaceBranch,
      payload: { expected: branch, branch: 'feature' },
    },
    { channel: DESKTOP_IPC_CHANNELS.runtimeOpen, payload: undefined },
    {
      channel: DESKTOP_IPC_CHANNELS.runtimeSend,
      payload: { connectionId: 7, frame: '{"jsonrpc":"2.0"}' },
    },
    { channel: DESKTOP_IPC_CHANNELS.runtimeReceive, payload: { connectionId: 7 } },
    { channel: DESKTOP_IPC_CHANNELS.runtimeDetach, payload: { connectionId: 7 } },
    { channel: DESKTOP_IPC_CHANNELS.runtimeClose, payload: { connectionId: 7 } },
    {
      channel: DESKTOP_IPC_CHANNELS.openEditor,
      payload: { connectionId: 7, path: 'src/main.ts', editor: 'vscode' },
    },
    {
      channel: DESKTOP_IPC_CHANNELS.writeClipboardText,
      payload: { text: 'Agent 最终回复' },
    },
    { channel: DESKTOP_IPC_CHANNELS.toggleWindowMaximize, payload: undefined },
    {
      channel: DESKTOP_IPC_CHANNELS.showConfirm,
      payload: {
        message: '继续？',
        title: '确认',
        kind: 'warning',
        okLabel: '继续',
        cancelLabel: '取消',
      },
    },
  ]);
  expect(new Set(Object.values(DESKTOP_IPC_CHANNELS)).size).toBe(
    Object.keys(DESKTOP_IPC_CHANNELS).length,
  );
});

test('preload restores a host error without exposing its IPC envelope', async () => {
  const bridge = createPreloadBridge(async () => ({ ok: false, error: '项目目录已不存在' }));
  await expect(bridge.checkWorkspace('/missing')).rejects.toThrow('项目目录已不存在');
});
