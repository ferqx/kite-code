import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  type AgentClient,
  ClientError,
  createClient,
  type PermissionMutation,
  type SessionView,
} from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { createDesktopController } from '../src';

async function errorCode(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
function gate() {
  let release!: () => void, enter!: () => void;
  return {
    promise: new Promise<void>((r) => {
      release = r;
    }),
    entered: new Promise<void>((r) => {
      enter = r;
    }),
    release: () => release(),
    enter: () => enter(),
  };
}
async function fixture() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-desktop-permission-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const host = createDefaultProcessConfiguration({ profile });
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    permissionManagement: host.permissionManagement!(runtime),
    subjectId: 'owner',
    profile: serverProfile,
    buildId: 'desktop-permissions',
  }).catch(async (error) => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['permission_controls'],
    },
    bootstrap: service.bootstrap,
  });
  await client.connect();
  const storeId = client.serverInfo!.storeId!;
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${workspace}`,
    name: 'temporary project',
  });
  for (const id of ['s', 'other'])
    await client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      title: id,
    });
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('s');
  return {
    root,
    store,
    client,
    desktop,
    storeId,
    async close() {
      desktop.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('actual default host/HTTP/SQL explicit four modes and displayed trust scopes persist without any Run or execution', async () => {
  const f = await fixture();
  try {
    expect(f.desktop.snapshot!.permissions!.trust.readScopes).toEqual(
      (await f.client.getWorkspaceTrust('w', { storeId: f.storeId })).readScopes,
    );
    for (const mode of ['ask', 'accept_edits', 'auto', 'full'] as const) {
      const facts = f.desktop.snapshot!.permissions!;
      const result = await f.desktop.setPermissionMode(mode, mode === 'auto', facts.observationId);
      expect(result.state).toBe('applied');
      expect((await f.client.getPermissionMode('s', { storeId: f.storeId })).mode).toBe(mode);
      expect(await errorCode(f.desktop.setWorkspaceTrust(true, facts.observationId))).toBe(
        'permission_observation_consumed',
      );
      await f.desktop.refreshPermissions();
    }
    expect(f.desktop.snapshot!.permissions!.mode.defaultMode).toBe('auto');
    const facts = f.desktop.snapshot!.permissions!;
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.mode)).toBe(true);
    expect(Object.isFrozen(facts.trust.readScopes)).toBe(true);
    const trust = await f.desktop.setWorkspaceTrust(true, facts.observationId);
    expect(trust.state).toBe('applied');
    expect(trust.receipt).toMatchObject({
      canonicalIdentity: facts.trust.canonicalIdentity,
      externalReadScopeDigest: facts.trust.externalReadScopeDigest,
      trusted: true,
    });
    await f.desktop.refreshPermissions();
    await f.desktop.setWorkspaceTrust(false, f.desktop.snapshot!.permissions!.observationId);
    expect((await f.client.getWorkspaceTrust('w', { storeId: f.storeId })).trusted).toBe(false);
    expect((await f.store.getView('s')).runs).toEqual([]);
    expect(await f.store.listExecutions('s')).toEqual([]);
    expect(f.desktop.permissionSubmissions).toHaveLength(6);
  } finally {
    await f.close();
  }
});
test('in-flight duplicate shares one exact intent; late lost receipt only looks up original identity after view switching', async () => {
  const f = await fixture(),
    barrier = gate();
  const actual = f.client.setPermissionMode.bind(f.client);
  let writes = 0;
  f.client.setPermissionMode = async (...args) => {
    writes++;
    barrier.enter();
    await barrier.promise;
    await actual(...args);
    throw new ClientError('network_outcome_unknown');
  };
  try {
    const observation = f.desktop.snapshot!.permissions!.observationId;
    const first = f.desktop.setPermissionMode('full', false, observation);
    expect(f.desktop.setPermissionMode('full', false, observation)).toBe(first);
    const outcome = errorCode(first);
    await barrier.entered;
    await f.desktop.selectSession('other');
    const other = f.desktop.snapshot!;
    expect(
      await errorCode(f.desktop.setPermissionMode('ask', false, other.permissions!.observationId)),
    ).toBe('permission_intent_pending');
    barrier.release();
    expect(await outcome).toBe('network_outcome_unknown');
    expect(f.desktop.snapshot).toBe(other);
    const saved = f.desktop.permissionSubmissions[0]!;
    expect(saved.sessionId).toBe('s');
    expect(saved.intent.expectedStoreId).toBe(f.storeId);
    expect(saved.phase).toBe('unknown');
    expect(await errorCode(f.desktop.refreshPermissions())).toBe('permission_intent_pending');
    const read = f.desktop.lookupPermissionMutation(saved.intent.commandId);
    expect(f.desktop.lookupPermissionMutation(saved.intent.commandId)).toBe(read);
    expect((await read).state).toBe('applied');
    expect(writes).toBe(1);
    expect(f.desktop.permissionSubmissions[0]!.intent.commandId).toBe(saved.intent.commandId);
    expect((await f.client.getPermissionMode('s', { storeId: f.storeId })).mode).toBe('full');
    expect((await f.client.getPermissionMode('other', { storeId: f.storeId })).mode).toBe(
      other.permissions!.mode.mode,
    );
    expect(await errorCode(f.desktop.setPermissionMode('auto', false, observation))).toBe(
      'permission_observation_changed',
    );
  } finally {
    barrier.release();
    await f.close();
  }
});
test('real competing CAS retains failed choice and requires re-read and a fresh explicit choice', async () => {
  const f = await fixture();
  try {
    const original = f.desktop.snapshot!.permissions!;
    await f.client.setPermissionMode('s', {
      expectedStoreId: f.storeId,
      commandId: 'competing',
      mode: 'auto',
      makeDefault: false,
      ifRevision: original.mode.revision,
      ifDefaultRevision: original.mode.defaultRevision,
    });
    expect(
      await errorCode(f.desktop.setPermissionMode('full', false, original.observationId)),
    ).toBe('host_control_conflict');
    const saved = f.desktop.permissionSubmissions[0]!;
    expect(saved.phase).toBe('failed');
    expect(saved.intent).toMatchObject({ mode: 'full', ifRevision: original.mode.revision });
    expect(await errorCode(f.desktop.setPermissionMode('ask', false, original.observationId))).toBe(
      'permission_observation_consumed',
    );
    await f.desktop.refreshPermissions();
    const newResult = await f.desktop.setPermissionMode(
      'ask',
      false,
      f.desktop.snapshot!.permissions!.observationId,
    );
    expect(newResult.state).toBe('applied');
    expect(newResult.commandId).not.toBe(saved.intent.commandId);
    expect(f.desktop.permissionSubmissions[0]!.intent.commandId).toBe(saved.intent.commandId);
  } finally {
    await f.close();
  }
});
test('capability absent is local read-only; actual child root projection denies writes without transport calls', async () => {
  let writes = 0;
  const view = {
    storeId: 'store',
    snapshotCursor: '0',
    session: {
      id: 'child',
      rootSessionId: 'root',
      parentSessionId: 'root',
      workspaceId: 'w',
      title: 'child',
      controlRevision: '0',
      contextSelectionId: 'selection',
      nextSeq: '0',
      deletedAt: null,
    },
    runs: [],
    messages: [],
    executions: [],
  } satisfies SessionView;
  const client = {
    serverInfo: { storeId: 'store', capabilities: [] as string[] },
    getView: async () => view,
    getPermissionMode: async () => ({
      storeId: 'store',
      sessionId: 'child',
      scopeSessionId: 'root',
      mode: 'ask',
      revision: '0',
      defaultMode: 'ask',
      defaultRevision: '0',
    }),
    getWorkspaceTrust: async () => ({
      storeId: 'store',
      workspaceId: 'w',
      status: 'untrusted',
      trusted: false,
      revision: '0',
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
      readScopes: [],
    }),
    setPermissionMode: async () => {
      writes++;
      return {} as PermissionMutation;
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('child');
  expect(desktop.snapshot!.permissions).toBeUndefined();
  expect(await errorCode(desktop.setPermissionMode('full', false, 1))).toBe(
    'permission_observation_changed',
  );
  client.serverInfo!.capabilities.push('permission_controls');
  await desktop.selectSession('child');
  expect(
    await errorCode(
      desktop.setPermissionMode('full', false, desktop.snapshot!.permissions!.observationId),
    ),
  ).toBe('permission_child_readonly');
  expect(writes).toBe(0);
});

test('bounded saved intents reject the 129th choice; disposal before queued transport performs no late write or service cancellation', async () => {
  let writes = 0,
    networkDisposals = 0,
    cancellations = 0;
  const view = {
    storeId: 'store',
    snapshotCursor: '0',
    session: {
      id: 's',
      rootSessionId: 's',
      parentSessionId: null,
      workspaceId: 'w',
      title: 's',
      controlRevision: '0',
      contextSelectionId: 'selection',
      nextSeq: '0',
      deletedAt: null,
    },
    runs: [],
    messages: [],
    executions: [],
  } satisfies SessionView;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['permission_controls'] },
    getView: async () => view,
    getPermissionMode: async () => ({
      storeId: 'store',
      sessionId: 's',
      scopeSessionId: 's',
      mode: 'ask',
      revision: String(writes),
      defaultMode: 'ask',
      defaultRevision: '0',
    }),
    getWorkspaceTrust: async () => ({
      storeId: 'store',
      workspaceId: 'w',
      status: 'untrusted',
      trusted: false,
      revision: '0',
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
      readScopes: [],
    }),
    async setPermissionMode(
      _session: string,
      input: { commandId: string; mode: 'ask'; makeDefault: boolean },
    ) {
      writes++;
      return {
        commandId: input.commandId,
        kind: 'permission.mode',
        state: 'applied',
        receipt: {
          status: 'applied',
          mode: input.mode,
          makeDefault: input.makeDefault,
          revision: String(writes),
          defaultRevision: '0',
        },
      };
    },
    disposeNetwork() {
      networkDisposals++;
    },
    cancel() {
      cancellations++;
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({
    admittedClient: client,
    onSnapshot() {},
    stopPairedService: async () => {
      cancellations++;
    },
  });
  await desktop.selectSession('s');
  for (let index = 0; index < 128; index++) {
    await desktop.setPermissionMode('ask', false, desktop.snapshot!.permissions!.observationId);
    await desktop.refreshPermissions();
  }
  expect(desktop.permissionSubmissions).toHaveLength(128);
  expect(
    await errorCode(
      desktop.setPermissionMode('ask', false, desktop.snapshot!.permissions!.observationId),
    ),
  ).toBe('permission_intent_limit');
  expect(writes).toBe(128);
  const fresh = createDesktopController({
    admittedClient: client,
    onSnapshot() {},
    stopPairedService: async () => {
      cancellations++;
    },
  });
  await fresh.selectSession('s');
  const queued = fresh.setPermissionMode('ask', false, fresh.snapshot!.permissions!.observationId);
  const result = errorCode(queued);
  fresh.disposeNetwork();
  expect(await result).toBe('controller_disposed');
  expect(writes).toBe(128);
  expect(networkDisposals).toBe(1);
  expect(cancellations).toBe(0);
  expect(fresh.permissionSubmissions[0]!.phase).toBe('failed');
});
