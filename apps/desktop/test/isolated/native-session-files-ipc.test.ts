import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import * as windowsArtifacts from '../../../../packages/agent/src/platform/windows-artifact-files';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { initializeLivePermissionFixture } from '../../../service/test/fixtures/live-permission-fixture';
import { NativeCaller } from '../../electron/native-caller';
import { registerNativeIpc } from '../../electron/native-ipc';
import type { NativeBridge, NativeReply, NativeState } from '../../src/native-bridge';
import { memoryPrivateData } from '../private-data.fixture';

async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('native_file_fixture_deadline');
    await Bun.sleep(5);
  }
}

test('built preload and Main file IPC retry failed Artifact writes and preserve uploaded originals across lost replies', async () => {
  const root = temporaryDirectory('kite-native-file-ipc-');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'fixture' });
  privateDirectory(profile.profilePath);
  let models = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      await request.json();
      models++;
      const chunk = {
        id: 'native-file',
        object: 'chat.completion.chunk',
        model: 'local',
        choices: [{ index: 0, delta: { content: 'Saved input observed' }, finish_reason: null }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const config = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    config,
    JSON.stringify({
      modelId: 'local',
      models: [
        {
          id: 'local',
          provider: 'compatible',
          model: 'local',
          baseURL: `${provider.url.origin}/v1`,
        },
      ],
    }),
  );
  const host = createDefaultProcessConfiguration({ profile, userConfigurationPath: config });
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const locks = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks!(locks);
  const runtime = createRuntime({
    ...host,
    permissions: host.permissions!,
    store,
    artifacts: createArtifactStore({ profile, store }),
    workspaceSerialLocks: locks,
  });
  host.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'Files',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Files',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId: storeId,
    subjectId: 'owner',
    sessionId: 's',
    workspaceId: 'w',
    mode: 'full',
    trusted: true,
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    subjectId: 'owner',
    buildId: 'native-file-ipc',
    configurationManagement: host.configurationManagement!(runtime),
    permissionManagement: host.permissionManagement!(runtime),
  });
  const connect = async () => {
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'input_files', 'configuration_management'],
      },
    });
    await client.connect();
    return client;
  };
  const data = memoryPrivateData();
  const saveDraft = data.save.bind(data);
  data.save = (scope, revision, content) => {
    const draft = saveDraft(scope, revision, content);
    // The memory port uses readable scope IDs; caller proofs require the production hash shape.
    draft.id = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    return draft;
  };
  let client = await connect(),
    caller = new NativeCaller(client, () => {}, data, [profile.dataRoot]);
  const frame = { url: pathToFileURL(join(root, 'renderer.html')).href },
    contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  let event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, payload: unknown) => Promise<NativeReply>
  >();
  const ipcMain = {
    handle: (
      key: string,
      handler: (event: IpcMainInvokeEvent, payload: unknown) => Promise<NativeReply>,
    ) => handlers.set(key, handler),
    removeHandler: (key: string) => handlers.delete(key),
  } as unknown as IpcMain;
  const unregister = registerNativeIpc({
    ipcMain,
    window: () => window,
    rendererUrl: frame.url,
    caller: async () => caller,
  });
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../electron/preload.ts')],
    target: 'node',
    format: 'cjs',
    packages: 'bundle',
    external: ['electron'],
  });
  expect(built.success).toBe(true);
  let bridge!: NativeBridge;
  runInNewContext(await built.outputs[0]!.text(), {
    exports: {},
    module: { exports: {} },
    require: (name: string) => {
      if (name !== 'electron') throw Error('unexpected_preload_dependency');
      return {
        contextBridge: {
          exposeInMainWorld: (_key: string, value: NativeBridge) => {
            bridge = value;
          },
        },
        ipcRenderer: {
          invoke: (key: string, payload: unknown) => handlers.get(key)!(event, payload),
          on() {},
          removeListener() {},
        },
        webUtils: { getPathForFile: () => join(root, 'selected.txt') },
      };
    },
  });
  const realFetch = globalThis.fetch;
  let loseUpload = true,
    loseCommand = true,
    loseLookup = false;
  const wire: { method: string; path: string; commandId?: string }[] = [];
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const url = new URL(String(args[0])),
        method = args[1]?.method ?? 'GET';
      const tracked = url.origin === new URL(service.endpoint).origin;
      if (tracked) {
        let commandId: string | undefined;
        if (method === 'POST' && url.pathname === '/v1/sessions/s/commands')
          commandId = JSON.parse(String(args[1]?.body)).commandId;
        wire.push({ method, path: url.pathname, commandId });
      }
      const response = await realFetch(...args);
      if (
        tracked &&
        response.ok &&
        ((loseUpload && method === 'POST' && url.pathname === '/v1/sessions/s/input-files') ||
          (loseCommand && method === 'POST' && url.pathname === '/v1/sessions/s/commands') ||
          (loseLookup && method === 'GET' && url.pathname === '/v1/commands/native-file-input'))
      ) {
        if (url.pathname.includes('input-files')) loseUpload = false;
        else if (method === 'POST') loseCommand = false;
        else loseLookup = false;
        await response.arrayBuffer();
        throw new TypeError('discarded_successful_response');
      }
      return response;
    },
    { preconnect: realFetch.preconnect },
  );
  const attach = async () => {
    const state = (await bridge.request({ method: 'attach' })) as NativeState;
    await until(async () => ((caller.state().environmentRevision ?? 0) > 0 ? true : null));
    await bridge.request({ method: 'select', generation: state.generation, sessionId: 's' });
    await until(async () => (caller.state().selection?.viewLoading === false ? true : null));
    return state.generation;
  };
  try {
    let generation = await attach();
    const partial = {
      method: 'input.files.begin' as const,
      generation,
      id: 'cancelled',
      name: 'partial.txt',
      mediaType: 'text/plain',
      size: 10,
    };
    await bridge.request(partial);
    await bridge.request({
      method: 'input.files.append',
      generation,
      id: 'cancelled',
      offset: 0,
      data: new Uint8Array([1]),
    });
    await expect(
      bridge.request({ method: 'input.files.finish', generation, id: 'cancelled' }),
    ).rejects.toMatchObject({ code: 'native_file_incomplete' });
    await bridge.request({ method: 'input.files.release', generation, id: 'cancelled' });
    await expect(
      bridge.request({
        method: 'input.files.append',
        generation,
        id: 'cancelled',
        offset: 1,
        data: new Uint8Array([2]),
      }),
    ).rejects.toMatchObject({ code: 'native_file_chunk_invalid' });
    expect(wire.filter((r) => r.path.includes('/input-files'))).toHaveLength(0);
    const originalEvent = event;
    event = { ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent;
    await expect(bridge.request({ ...partial, id: 'foreign' })).rejects.toMatchObject({
      code: 'native_sender_denied',
    });
    event = originalEvent;
    await bridge.request({ ...partial, id: 'superseded' });
    const old = generation;
    generation = await attach();
    await expect(
      bridge.request({ method: 'input.files.finish', generation: old, id: 'superseded' }),
    ).rejects.toMatchObject({ code: 'native_generation_changed' });
    const bytes = Buffer.from('完整 Native 文件\r\nSOURCE_BYTES_SAVED'),
      copied = Buffer.from(bytes);
    await bridge.request({
      method: 'input.files.begin',
      generation,
      id: 'saved',
      name: '附件.txt',
      mediaType: 'text/plain',
      size: bytes.length,
    });
    await bridge.request({
      method: 'input.files.append',
      generation,
      id: 'saved',
      offset: 0,
      data: bytes,
    });
    bytes.fill(0);
    await bridge.request({ method: 'input.files.finish', generation, id: 'saved' });
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: storeId,
      commandId: 'native-file-input',
      content: 'Read this saved original',
    };
    const savedDraft = await bridge.request({
      method: 'draft.write',
      generation,
      sessionId: 's',
      revision: 0,
      content: intent.content,
    });
    const submission = {
      method: 'submit' as const,
      generation,
      sessionId: 's',
      intent,
      fileIds: ['saved'],
    };

    const importId = createHash('sha256')
      .update(JSON.stringify([storeId, 's', 'saved']))
      .digest('hex');
    let injectedDiskFailures = 0;
    if (process.platform === 'win32') {
      const createTemporary = windowsArtifacts.createWindowsArtifactTemporary;
      let closedFailedTemporary = false;
      const fault = spyOn(windowsArtifacts, 'createWindowsArtifactTemporary').mockImplementation(
        (path) => {
          const temporary = createTemporary(path);
          if (path !== profile.profilePath) return temporary;
          let failed = false;
          return {
            ...temporary,
            write(chunk) {
              if (injectedDiskFailures === 0) {
                expect(Buffer.from(chunk)).toEqual(copied);
                injectedDiskFailures++;
                failed = true;
                throw Object.assign(new Error('injected artifact write ENOSPC'), {
                  code: 'ENOSPC',
                });
              }
              temporary.write(chunk);
            },
            close() {
              temporary.close();
              if (failed) closedFailedTemporary = true;
            },
          };
        },
      );
      let failedUpload: unknown;
      try {
        await bridge.request(submission);
      } catch (error) {
        failedUpload = error;
      } finally {
        fault.mockRestore();
      }
      expect(failedUpload).toMatchObject({ code: 'service_unavailable' });
      expect(injectedDiskFailures).toBe(1);
      expect(closedFailedTemporary).toBe(true);
      expect(
        readdirSync(join(profile.profilePath, 'blobs')).filter((name) =>
          name.startsWith('.publish-'),
        ),
      ).toEqual([]);
      expect(
        await runtime.getInputFileImport({
          expectedStoreId: storeId,
          sessionId: 's',
          subjectId: 'owner',
          id: importId,
        }),
      ).toBeNull();
      expect(await store.getCommand(intent.commandId)).toBeNull();
      expect(data.callers()).toHaveLength(0);
      expect(models).toBe(0);
      expect(await bridge.request({ method: 'draft.read', generation, sessionId: 's' })).toEqual(
        savedDraft,
      );
      expect(
        wire.filter((entry) => entry.method === 'POST' && entry.path === '/v1/sessions/s/commands'),
      ).toHaveLength(0);
      // Retry the same prepared ID without rereading or replenishing its bytes.
      // This injects the native write boundary, not a physical full-volume qualification.
    }
    // Await normally so the SQLite Worker can deliver replies before asserting the error.
    let unknownUpload: unknown;
    try {
      await bridge.request(submission);
    } catch (error) {
      unknownUpload = error;
    }
    expect(unknownUpload).toMatchObject({ code: 'network_outcome_unknown' });
    expect(await store.getCommand(intent.commandId)).toBeNull();
    expect(data.callers()).toHaveLength(0);
    await bridge.request(submission);
    await runtime.waitForCommand(intent.commandId, { timeoutMs: 5000 });
    expect(data.callers()[0]!.phase).toBe('unknown');
    const imported = await client.getInputFileImport('s', importId);
    expect(imported).toMatchObject({ state: 'bound', boundCommandId: intent.commandId });
    expect(imported.reference.hash).toBe(createHash('sha256').update(copied).digest('hex'));
    const downloaded = await client.readArtifact('s', {
      expectedStoreId: storeId,
      refId: imported.reference.id,
      scope: imported.reference.scope,
    });
    expect(Buffer.from(downloaded.content)).toEqual(copied);
    const savedIntent = data.callers()[0]!.intent;
    expect(savedIntent.request).toMatchObject({
      files: [{ name: '附件.txt', reference: imported.reference }],
    });
    await caller.close();
    client = await connect();
    caller = new NativeCaller(client, () => {}, data, [profile.dataRoot]);
    generation = await attach();
    expect(data.callers()[0]!.intent).toEqual(savedIntent);
    loseLookup = true;
    expect(
      await bridge.request({ method: 'caller.lookup', generation, commandId: intent.commandId }),
    ).toMatchObject({ phase: 'unknown' });
    expect(
      await bridge.request({ method: 'caller.lookup', generation, commandId: intent.commandId }),
    ).toMatchObject({ phase: 'applied' });
    expect(
      wire.filter((r) => r.method === 'POST' && r.path === '/v1/sessions/s/input-files'),
    ).toHaveLength(1 + injectedDiskFailures);
    expect(
      wire.filter((r) => r.method === 'POST' && r.commandId === intent.commandId),
    ).toHaveLength(1);
    expect(models).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
    unregister();
    await caller.close();
    data.close();
    await service.close();
    await runtime.close();
    await locks.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
