import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentClient, Execution, Message } from '@kite-ai/client';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { editorFileTarget } from '../electron/editor';
import { NativeFileChanges } from '../electron/file-changes';
import type { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest, registerNativeIpc } from '../electron/native-ipc';
import type { NativeFileChangeScope } from '../src/file-changes-bridge';
import { type NativeReply, nativeChannel } from '../src/native-bridge';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-files-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const path = 'space name 雪.txt',
    text = 'confirmed old bytes\r\n';
  writeFileSync(join(workspace, path), text);
  const stat = statSync(join(workspace, path), { bigint: true });
  const baseline = {
    hash: createHash('sha256').update(text).digest('hex'),
    size: Buffer.byteLength(text),
    device: String(stat.dev),
    inode: String(stat.ino),
  };
  let scope: NativeFileChangeScope = {
    generation: 1,
    viewSelection: 1,
    historyEpoch: 0,
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
  };
  const messages = new Map<string, Message>(),
    executions = new Map<string, Execution>(),
    reads: string[] = [];
  function add(
    id: string,
    definitionId = 'files.write',
    status: Execution['status'] = 'succeeded',
    saved = true,
    version = '2',
  ) {
    const content = JSON.stringify({ path, baseline });
    messages.set(id, {
      id,
      sessionId: 's',
      runId: `run-${id}`,
      seq: String(messages.size + 1),
      status: 'complete',
      role: 'tool',
      content,
      toolCallId: 'repeated-call',
      sourceIds: [`execution-${id}`],
    });
    executions.set(`execution-${id}`, {
      id: `execution-${id}`,
      originStoreId: 'store',
      sessionId: 's',
      runId: `run-${id}`,
      kind: 'tool',
      definitionId,
      definitionVersion: version,
      status,
      resultRevision: '1',
      cancelRequestedAt: null,
      result: {
        outcome: status,
        content,
        ...(saved
          ? {
              details: {
                fileChange: {
                  version: 1,
                  format: 'file_content',
                  path,
                  before: null,
                  after: baseline,
                  text: 'SAVED_ORIGINAL_TOOL_PREVIEW',
                  truncated: false,
                },
              },
            }
          : {}),
      },
    });
  }
  for (const id of ['first', 'second']) add(id);
  add('mcp', 'mcp.other.write');
  add('unknown', 'files.write', 'outcome_unknown');
  add('old', 'files.edit', 'succeeded', false);
  add('unsupported', 'files.write', 'succeeded', true, 'future');
  const registered = { id: 'w', name: 'owned', rootUri: pathToFileURL(workspace).href };
  const client = {
    serverInfo: { storeId: 'store' },
    verifyConnection: async () => {},
    getWorkspace: async () => registered,
    getView: async (id: string) => ({ storeId: 'store', session: { id, workspaceId: 'w' } }),
    getExecution: async (id: string) => {
      reads.push(id);
      return executions.get(id)!;
    },
  } as unknown as AgentClient;
  const manager = new NativeFileChanges(
    client,
    () => scope,
    (id) => messages.get(id),
    () => registered,
    [join(workspace, 'protected')],
  );
  return {
    root,
    workspace,
    path,
    client,
    manager,
    messages,
    executions,
    reads,
    add,
    get scope() {
      return scope;
    },
    set scope(value) {
      scope = value;
    },
    async list(ids = ['first', 'second', 'mcp', 'unknown', 'old', 'unsupported']) {
      return manager.list({
        readId: crypto.randomUUID(),
        messageIds: ids,
        viewSelection: scope.viewSelection,
        historyEpoch: scope.historyEpoch,
      });
    },
    close() {
      manager.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('PC file list accepts exact succeeded file receipts, retains repeated calls independently, and explicitly leaves old/unknown formats unavailable', async () => {
  const f = fixture();
  try {
    const page = await f.list();
    expect(page.entries.map((entry) => entry.messageId)).toEqual([
      'first',
      'second',
      'old',
      'unsupported',
    ]);
    expect(page.entries[0]!.changeId).not.toBe(page.entries[1]!.changeId);
    expect(page.entries.map((entry) => entry.preview)).toEqual([
      'available',
      'available',
      'unavailable',
      'unavailable',
    ]);
    expect(page.entries[3]!.path).toBeUndefined();
    expect(page.entries[3]!.openable).toBe(false);
    writeFileSync(join(f.workspace, f.path), 'external current contents');
    const detail = await f.manager.detail(page.entries[0]!.changeId, 'body');
    expect(detail.text).toBe('SAVED_ORIGINAL_TOOL_PREVIEW');
    expect(await f.manager.detail(page.entries[2]!.changeId, 'old-body')).toEqual({
      kind: 'fileChanges.detail',
      changeId: page.entries[2]!.changeId,
    });
    const opened: [string, string][] = [];
    await f.manager.open(page.entries[0]!.changeId, 'zed', async (editor, target) => {
      opened.push([editor, target]);
    });
    expect(opened).toEqual([['zed', join(f.workspace, f.path)]]);
    expect(f.reads).toContain('execution-first');
    expect(f.reads).toContain('execution-second');
    f.scope = { ...f.scope, historyEpoch: 1 };
    const before = f.reads.length;
    await expect(
      f.manager.open(page.entries[0]!.changeId, 'vscode', async () => {
        throw Error('must not launch');
      }),
    ).rejects.toMatchObject({ code: 'file_change_observation_unavailable' });
    expect(f.reads.length).toBe(before);
  } finally {
    f.close();
  }
});

test('editor opening rechecks actual registered root identity, confines symlinks and protected files, and keeps same-Workspace Fork history readable', async () => {
  const f = fixture();
  let opened = 0;
  const perform = async () => {
    opened++;
  };
  try {
    const message = f.messages.get('first')!;
    f.messages.set('copy', {
      ...message,
      id: 'copy',
      runId: null,
      originMessage: {
        storeId: 'store',
        sessionId: 'original',
        messageId: 'first',
        runId: message.runId,
      },
    });
    f.executions.get('execution-first')!.sessionId = 'original';
    const copied = (await f.list(['copy'])).entries[0]!;
    expect(copied.openable).toBe(true);
    expect((await f.manager.detail(copied.changeId, 'copy-body')).text).toBe(
      'SAVED_ORIGINAL_TOOL_PREVIEW',
    );
    await f.manager.open(copied.changeId, 'textedit', perform);
    expect(opened).toBe(1);
    const outside = join(f.root, 'outside');
    writeFileSync(outside, 'outside');
    rmSync(join(f.workspace, f.path));
    symlinkSync(outside, join(f.workspace, f.path));
    await expect(f.manager.open(copied.changeId, 'vscode', perform)).rejects.toMatchObject({
      code: 'file_editor_target_unavailable',
    });
    expect(opened).toBe(1);
    rmSync(join(f.workspace, f.path));
    writeFileSync(join(f.workspace, f.path), 'current ordinary file');
    renameSync(f.workspace, `${f.workspace}-old`);
    mkdirSync(f.workspace);
    writeFileSync(join(f.workspace, f.path), 'replacement root');
    await expect(f.manager.open(copied.changeId, 'vscode', perform)).rejects.toMatchObject({
      code: 'workspace_directory_unavailable',
    });
    expect(opened).toBe(1);
    expect(() => editorFileTarget(f.workspace, '../outside')).toThrow();
    expect(() => editorFileTarget(f.workspace, 'bad\nname')).toThrow();
    const foreign = (await f.list(['copy'])).entries[0]!;
    f.client.getView = (async (id: string) => ({
      storeId: 'store',
      session: { id, workspaceId: 'other' },
    })) as AgentClient['getView'];
    await expect(f.manager.open(foreign.changeId, 'vscode', perform)).rejects.toMatchObject({
      code: 'file_editor_target_unavailable',
    });
    expect(opened).toBe(1);
    const result = f.executions.get('execution-second')!.result as Record<string, unknown>;
    mkdirSync(join(f.workspace, 'protected'));
    writeFileSync(join(f.workspace, 'protected/file'), 'protected');
    result.content = JSON.stringify({
      path: 'protected/file',
      baseline: JSON.parse(String(result.content)).baseline,
    });
    f.messages.get('second')!.content = String(result.content);
    const protectedEntry = (await f.list(['second'])).entries[0]!;
    await expect(f.manager.open(protectedEntry.changeId, 'vscode', perform)).rejects.toMatchObject({
      code: 'file_editor_target_unavailable',
    });
    expect(opened).toBe(1);
  } finally {
    f.close();
  }
});

test('closing a file read aborts only its GET and rejects a late result; mismatched original Run cannot supply a preview', async () => {
  const f = fixture();
  try {
    const entry = (await f.list(['first'])).entries[0]!;
    let release!: (execution: Execution) => void,
      signal: AbortSignal | undefined,
      started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.client.getExecution = async (_id, options) => {
      signal = options?.signal;
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const reading = f.manager.detail(entry.changeId, 'held');
    await ready;
    f.manager.close('held');
    expect(signal!.aborted).toBe(true);
    release(f.executions.get('execution-first')!);
    await expect(reading).rejects.toMatchObject({ code: 'native_selection_changed' });
    f.client.getExecution = async (id) => f.executions.get(id)!;
    f.executions.get('execution-first')!.runId = 'another-run';
    await expect(f.manager.detail(entry.changeId, 'wrong-run')).rejects.toMatchObject({
      code: 'file_change_identity_mismatch',
    });
  } finally {
    f.close();
  }
});

test('finite editor IPC rejects renderer paths/apps and rechecks a replaced frame immediately before launch', async () => {
  const valid = {
    method: 'fileChanges.open',
    generation: 1,
    changeId: 'observed',
    editor: 'vscode',
  } as const;
  expect(decodeNativeRequest(valid)).toEqual(valid);
  for (const invalid of [
    { ...valid, path: '/arbitrary' },
    { ...valid, editor: '/bin/sh' },
    { ...valid, workspaceId: 'w' },
    {
      method: 'fileChanges.list',
      generation: 1,
      readId: 'r',
      viewSelection: 1,
      historyEpoch: 0,
      messageIds: Array.from({ length: 33 }, (_, index) => `m${index}`),
    },
  ])
    expect(() => decodeNativeRequest(invalid)).toThrow();
  const frame = { url: 'file:///owned/index.html' },
    contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  let handler!: (event: IpcMainInvokeEvent, payload: unknown) => Promise<NativeReply>,
    launches = 0,
    replace = false;
  const caller = {
    async openChangedFile(
      _request: unknown,
      perform: (editor: 'vscode', target: string) => Promise<void>,
    ) {
      if (replace) contents.mainFrame = { url: frame.url };
      await perform('vscode', '/qualified/file');
    },
  } as unknown as NativeCaller;
  const remove = registerNativeIpc({
    ipcMain: {
      handle(channel: string, value: typeof handler) {
        expect(channel).toBe(nativeChannel);
        handler = value;
      },
      removeHandler() {},
    } as unknown as IpcMain,
    window: () => window,
    rendererUrl: frame.url,
    caller: async () => caller,
    openEditor: async (editor, target) => {
      expect(editor).toBe('vscode');
      expect(target).toBe('/qualified/file');
      launches++;
    },
  });
  try {
    expect(await handler(event, valid)).toEqual({ ok: true, value: null });
    expect(launches).toBe(1);
    replace = true;
    expect(await handler(event, valid)).toEqual({ ok: false, code: 'native_sender_denied' });
    expect(launches).toBe(1);
  } finally {
    remove();
  }
});
