import { fileURLToPath } from 'node:url';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { BranchSnapshot, DesktopConfirmOptions, DesktopEditor } from '../src/bridge';

export function assertTrustedIpc(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | undefined,
  rendererUrl: string,
): void {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !event.senderFrame ||
    !sameRendererDocument(event.senderFrame.url, rendererUrl)
  )
    throw new Error('拒绝未授权的桌面 IPC 来源。');
}

export function sameRendererDocument(actualValue: string, expectedValue: string): boolean {
  try {
    const actual = new URL(actualValue);
    const expected = new URL(expectedValue);
    if (actual.protocol !== expected.protocol) return false;
    if (actual.protocol === 'file:') return fileURLToPath(actual) === fileURLToPath(expected);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function noPayload(value: unknown): void {
  if (value !== undefined) throw new Error('桌面 IPC 参数无效。');
}

export function pathPayload(value: unknown): { path: string } {
  const record = exactRecord(value, ['path']);
  return { path: boundedString(record.path, 8192) };
}

export function workspacePayload(value: unknown): { workspace: string } {
  const record = exactRecord(value, ['workspace']);
  return { workspace: boundedString(record.workspace, 8192) };
}

export function connectionPayload(value: unknown): { connectionId: number } {
  const record = exactRecord(value, ['connectionId']);
  return { connectionId: connectionId(record.connectionId) };
}

export function runtimeSendPayload(value: unknown): { connectionId: number; frame: string } {
  const record = exactRecord(value, ['connectionId', 'frame']);
  return {
    connectionId: connectionId(record.connectionId),
    frame: boundedString(record.frame, 1_048_576),
  };
}

export function editorPayload(value: unknown): {
  connectionId: number;
  path: string;
  editor: DesktopEditor;
} {
  const record = exactRecord(value, ['connectionId', 'path', 'editor']);
  const editor = record.editor;
  if (editor !== 'vscode' && editor !== 'zed' && editor !== 'textedit')
    throw new Error('桌面 IPC 参数无效。');
  return {
    connectionId: connectionId(record.connectionId),
    path: boundedString(record.path, 8192),
    editor,
  };
}

export function switchPayload(value: unknown): { expected: BranchSnapshot; branch: string } {
  const record = exactRecord(value, ['expected', 'branch']);
  return {
    expected: branchSnapshot(record.expected),
    branch: boundedString(record.branch, 1024),
  };
}

export function confirmPayload(value: unknown): DesktopConfirmOptions {
  const record = exactRecord(value, ['message', 'title', 'kind'], ['okLabel', 'cancelLabel']);
  if (record.kind !== 'warning' && record.kind !== 'info') throw new Error('桌面 IPC 参数无效。');
  return {
    message: boundedString(record.message, 4096),
    title: boundedString(record.title, 256),
    kind: record.kind,
    ...(record.okLabel === undefined ? {} : { okLabel: boundedString(record.okLabel, 128) }),
    ...(record.cancelLabel === undefined
      ? {}
      : { cancelLabel: boundedString(record.cancelLabel, 128) }),
  };
}

function branchSnapshot(value: unknown): BranchSnapshot {
  const record = exactRecord(value, [
    'workspace',
    'repository',
    'root',
    'current',
    'head',
    'branches',
    'dirty',
    'canSwitch',
  ]);
  if (
    typeof record.repository !== 'boolean' ||
    typeof record.dirty !== 'boolean' ||
    typeof record.canSwitch !== 'boolean' ||
    !nullableString(record.root, 8192) ||
    !nullableString(record.current, 1024) ||
    !nullableString(record.head, 1024) ||
    !Array.isArray(record.branches) ||
    record.branches.length > 10_000 ||
    !record.branches.every((branch) => typeof branch === 'string' && branch.length <= 1024)
  )
    throw new Error('桌面 IPC 参数无效。');
  return {
    workspace: boundedString(record.workspace, 8192),
    repository: record.repository,
    root: record.root,
    current: record.current,
    head: record.head,
    branches: record.branches,
    dirty: record.dirty,
    canSwitch: record.canSwitch,
  };
}

function connectionId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error('桌面 IPC 参数无效。');
  return value as number;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum)
    throw new Error('桌面 IPC 参数无效。');
  return value;
}

function nullableString(value: unknown, maximum: number): value is string | null {
  return (
    value === null || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum)
  );
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('桌面 IPC 参数无效。');
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  )
    throw new Error('桌面 IPC 参数无效。');
  return record;
}
