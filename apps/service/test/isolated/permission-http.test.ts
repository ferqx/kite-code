import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';

async function rejected(work: Promise<unknown>, code: string, status?: number) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
  if (status !== undefined) expect((error as { status?: number })?.status).toBe(status);
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-permission-http-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  async function open(subjectId = 'owner') {
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const host = createDefaultProcessConfiguration({ profile });
    const runtime = createRuntime({
      store,
      permissions: host.permissions!,
      resolveRunConfiguration: host.resolveRunConfiguration,
    });
    const permissionManagement = host.permissionManagement!(runtime);
    const serverProfile = {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    };
    const service = await startService({
      runtime,
      permissionManagement,
      subjectId,
      profile: serverProfile,
      buildId: 'permission-api',
    }).catch(async (error) => {
      await runtime.close();
      throw error;
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: serverProfile,
        apiMajor: 1,
        requiredCapabilities: ['permission_controls', 'sessions'],
      },
      bootstrap: service.bootstrap,
    });
    await client.connect();
    const storeId = client.serverInfo!.storeId!;
    const request = (path: string, body?: unknown) =>
      fetch(service.endpoint + path, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          authorization: `Bearer ${service.bootstrap.token}`,
          'content-type': 'application/json',
        },
      });
    return {
      store,
      runtime,
      client,
      storeId,
      request,
      async close() {
        client.disposeNetwork();
        await service.close();
      },
    };
  }
  return { root, workspace, open, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('actual default host, SQL, HTTP and Native Client preserve explicit mode/trust choices across restart without Model or execution effects', async () => {
  const f = await fixture();
  let server = await f.open().catch((error) => {
    f.close();
    throw error;
  });
  try {
    const { client, storeId } = server;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${f.workspace}`,
      name: 'Permission API',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Permission API',
    });
    const initial = await client.getPermissionMode('s', { storeId });
    expect(initial).toEqual({
      storeId,
      sessionId: 's',
      scopeSessionId: 's',
      mode: 'auto',
      revision: '0',
      defaultMode: 'auto',
      defaultRevision: '0',
    });
    const observed = await client.getWorkspaceTrust('w', { storeId });
    expect(observed).toMatchObject({
      storeId,
      workspaceId: 'w',
      status: 'untrusted',
      trusted: false,
      revision: '0',
    });
    expect(observed.readScopes).toEqual([
      { kind: 'workspace', description: '当前工作区内的文件、项目指令与 Skill 资料' },
    ]);
    expect(JSON.stringify(observed).includes(f.root)).toBe(false);
    const choice = {
      expectedStoreId: storeId,
      commandId: 'mode',
      mode: 'ask' as const,
      ifRevision: initial.revision,
      makeDefault: true,
      ifDefaultRevision: initial.defaultRevision,
    };
    const mode = await client.setPermissionMode('s', choice);
    expect(mode).toMatchObject({
      commandId: 'mode',
      kind: 'permission.mode',
      state: 'applied',
      receipt: { status: 'applied', mode: 'ask', makeDefault: true },
    });
    expect(await client.setPermissionMode('s', choice)).toEqual(mode);
    expect(await client.getPermissionMutation('mode', { storeId })).toEqual(mode);
    await rejected(
      client.setPermissionMode('s', { ...choice, commandId: 'stale-mode', mode: 'full' }),
      'host_control_conflict',
      409,
    );
    const trust = await client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      canonicalIdentity: observed.canonicalIdentity,
      externalReadScopeDigest: observed.externalReadScopeDigest,
      trusted: true,
      ifRevision: observed.revision,
    });
    expect(trust).toMatchObject({
      kind: 'workspace.trust',
      state: 'applied',
      receipt: {
        trusted: true,
        canonicalIdentity: observed.canonicalIdentity,
        externalReadScopeDigest: observed.externalReadScopeDigest,
      },
    });
    const trusted = await client.getWorkspaceTrust('w', { storeId });
    expect(trusted).toMatchObject({ trusted: true, status: 'trusted' });
    const current = await client.getPermissionMode('s', { storeId });
    expect(current).toMatchObject({ mode: 'ask', defaultMode: 'ask' });
    expect((await server.runtime.getView('s'))!.executions).toHaveLength(0);
    await server.close();
    server = await f.open();
    expect(server.storeId).toBe(storeId);
    expect(await server.client.getPermissionMode('s', { storeId })).toEqual(current);
    expect(await server.client.getWorkspaceTrust('w', { storeId })).toEqual(trusted);
    expect(await server.client.getPermissionMutation('mode', { storeId })).toEqual(mode);
    await server.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create-next',
      sessionId: 'next',
      workspaceId: 'w',
      title: 'Next',
    });
    expect(await server.client.getPermissionMode('next', { storeId })).toMatchObject({
      mode: 'ask',
      revision: '0',
      defaultMode: 'ask',
      defaultRevision: current.defaultRevision,
    });
    const revoked = await server.client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'revoke',
      canonicalIdentity: trusted.canonicalIdentity,
      externalReadScopeDigest: trusted.externalReadScopeDigest,
      trusted: false,
      ifRevision: trusted.revision,
    });
    expect(revoked).toMatchObject({ state: 'applied', receipt: { trusted: false } });
    expect(await server.client.getWorkspaceTrust('w', { storeId })).toMatchObject({
      trusted: false,
      status: 'untrusted',
    });
    expect((await server.runtime.getView('s'))!.executions).toHaveLength(0);
    expect((await server.runtime.getView('next'))!.executions).toHaveLength(0);
    const events = await server.store.getChanges({ after: '0', limit: 100 });
    expect(events.events.filter((e) => e.type === 'host_control.changed')).toHaveLength(3);
  } finally {
    await server.close();
    f.close();
  }
});

test('permission API rejects foreign Store, hidden authority fields, duplicate queries and stale root identities; failed scope writes remain queryable', async () => {
  const f = await fixture();
  const server = await f.open().catch((error) => {
    f.close();
    throw error;
  });
  try {
    const { client, storeId } = server;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${f.workspace}`,
      name: 'Strict',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Strict',
    });
    const query = `?storeId=${storeId}`;
    const read = await server.request(`/v1/sessions/s/permission-mode${query}`);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    await read.json();
    for (const path of [
      '/v1/sessions/s/permission-mode',
      `/v1/sessions/s/permission-mode${query}&subjectId=intruder`,
      `/v1/sessions/s/permission-mode${query}&storeId=${storeId}`,
      `/v1/workspaces/w/trust${query}&path=/arbitrary`,
    ])
      expect((await server.request(path)).status).toBe(400);
    expect((await server.request('/v1/sessions/s/permission-mode?storeId=foreign')).status).toBe(
      409,
    );
    const choice = {
      expectedStoreId: storeId,
      commandId: 'forged',
      mode: 'full',
      ifRevision: '0',
      makeDefault: false,
      ifDefaultRevision: '0',
    };
    expect(
      (await server.request('/v1/sessions/s/permission-mode', { ...choice, subjectId: 'intruder' }))
        .status,
    ).toBe(400);
    expect(
      (await server.request('/v1/sessions/s/permission-mode', { ...choice, allowed: true })).status,
    ).toBe(400);
    expect(
      await server.runtime.getHostMutation({
        expectedStoreId: storeId,
        subjectId: 'owner',
        commandId: 'forged',
      }),
    ).toBeNull();
    const observed = await client.getWorkspaceTrust('w', { storeId });
    renameSync(f.workspace, `${f.workspace}-old`);
    mkdirSync(f.workspace);
    await rejected(
      client.setWorkspaceTrust('w', {
        expectedStoreId: storeId,
        commandId: 'changed-root',
        canonicalIdentity: observed.canonicalIdentity,
        externalReadScopeDigest: observed.externalReadScopeDigest,
        trusted: true,
        ifRevision: observed.revision,
      }),
      'workspace_scope_changed',
      409,
    );
    expect(await client.getPermissionMutation('changed-root', { storeId })).toMatchObject({
      state: 'failed',
      receipt: { status: 'failed', code: 'workspace_scope_changed' },
    });
    expect(await client.getWorkspaceTrust('w', { storeId })).toMatchObject({
      trusted: false,
      revision: '0',
    });
    await rejected(
      client.getPermissionMutation('missing', { storeId }),
      'permission_mutation_not_found',
      404,
    );
    expect((await server.runtime.getView('s'))!.executions).toHaveLength(0);
  } finally {
    await server.close();
    f.close();
  }
});
