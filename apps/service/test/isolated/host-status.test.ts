import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createDefaultHostStatusSource } from '../../src/host-status';

test('real default HTTP status reads current controls and host facts without creating work or touching providers/credentials', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-host-status-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  let provider = 0,
    vault = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put() {
        vault++;
      },
      async remove() {
        vault++;
      },
      async resolve() {
        vault++;
        return 'secret';
      },
    },
  });
  const {
    diagnosticSource,
    permissionManagement,
    configurationManagement: _management,
    ...binding
  } = host;
  const runtime = createRuntime({
    ...binding,
    permissions: host.permissions!,
    store,
    resolveRunConfiguration: async (input) => {
      provider++;
      return host.resolveRunConfiguration!(input);
    },
  });
  const permissions = permissionManagement!(runtime);
  const metadata = await runtime.getMetadata();
  const identity = { expectedStoreId: metadata.storeId, subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId: metadata.storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}`,
  });
  await runtime.createWorkspace({
    expectedStoreId: metadata.storeId,
    id: 'other',
    name: 'other',
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({
    ...identity,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'owned',
  });
  const service = await startService({
    runtime,
    diagnosticSource,
    permissionManagement: permissions,
    subjectId: 'owner',
    buildId: 'owned-status',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      instanceId: service.bootstrap.instanceId,
      buildId: service.bootstrap.buildId,
      requiredCapabilities: ['host_status'],
    },
  });
  const get = (query: string, token = service.bootstrap.token) =>
    fetch(`${service.endpoint}/v1/diagnostics/host-status${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    await client.connect();
    const before = await runtime.getChanges({ after: '0' });
    const baseline = await client.getHostStatus();
    expect(baseline.scope).toEqual({ workspaceId: null, sessionId: null });
    expect(baseline.identity).toEqual({
      instanceId: service.bootstrap.instanceId,
      buildId: 'owned-status',
      apiMajor: 1,
      profileAccessKey: profile.profileAccessKey,
      dataAvailability: 'available',
      storeId: metadata.storeId,
    });
    expect(baseline.execution.sandbox).toEqual({
      backend: 'none',
      available: false,
      qualification: 'unqualified',
    });
    expect(baseline.execution.shell).toMatchObject({
      configured: false,
      available: false,
      qualification: 'not_configured',
    });
    expect(baseline.execution.permissions).toMatchObject({
      state: 'unbound',
      scope: 'default',
      mode: 'auto',
      defaultMode: 'auto',
      workspaceTrust: 'unbound',
    });
    expect(baseline.release).toEqual({
      state: 'available',
      active: false,
      production: null,
      qualification: 'unverified',
      reason: 'release_manifest_not_bound',
    });
    expect(baseline.telemetry).toEqual({
      state: 'available',
      enabled: false,
      exporterConfigured: false,
      diskSpool: false,
      reason: 'exporter_not_configured',
    });
    const scoped = await client.getHostStatus({ workspaceId: 'w', sessionId: 's' });
    expect(scoped.execution.permissions).toMatchObject({
      scope: 'session',
      mode: 'auto',
      workspaceTrust: 'untrusted',
    });
    expect(await runtime.getChanges({ after: '0' })).toEqual(before);
    expect((await runtime.getView('s')).runs).toHaveLength(0);
    expect((await runtime.getView('s')).executions).toHaveLength(0);
    expect(await runtime.listWorkspaces()).toHaveLength(2);
    expect(await runtime.listSessions()).toHaveLength(1);
    expect(provider).toBe(0);
    expect(vault).toBe(0);
    expect(client.lastAppliedCursor).toBeUndefined();
    const aliasedOptions = { externalPermissionAuthority: true };
    const sealedSource = createDefaultHostStatusSource(aliasedOptions);
    aliasedOptions.externalPermissionAuthority = false;
    expect(
      (
        await sealedSource.snapshot({
          runtime,
          permissions,
          subjectId: 'owner',
          storeId: metadata.storeId,
        })
      ).execution.permissions,
    ).toMatchObject({ state: 'unavailable', mode: null, reason: 'permission_source_unavailable' });
    const encoded = JSON.stringify(scoped);
    for (const hidden of [root, workspace, service.bootstrap.token, service.endpoint, 'secret'])
      expect(encoded).not.toContain(hidden);
    for (const query of [
      '?subjectId=other',
      '?ownerGeneration=1',
      '?sandbox=seatbelt',
      '?telemetry=true',
      '?workspaceId=w&workspaceId=other',
      '?workspaceId=%2Fprivate%2Ftmp',
    ])
      expect((await get(query)).status).toBe(400);
    expect((await get('', 'wrong-token')).status).toBe(401);
    expect((await get('?workspaceId=other&sessionId=s')).status).toBe(409);
    expect((await get('?workspaceId=missing')).status).toBe(404);
    expect(await runtime.getChanges({ after: '0' })).toEqual(before);
    const mode = await permissions.readMode({ ...identity, sessionId: 's' });
    await permissions.setMode({
      ...identity,
      sessionId: 's',
      commandId: 'ask-default',
      mode: 'ask',
      ifRevision: mode.revision,
      makeDefault: true,
      ifDefaultRevision: mode.defaultRevision,
    });
    const trust = await permissions.readTrust({ ...identity, workspaceId: 'w' });
    await permissions.setTrust({
      ...identity,
      workspaceId: 'w',
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    const afterControls = await runtime.getChanges({ after: '0' });
    expect(
      (await client.getHostStatus({ sessionId: 's', workspaceId: 'w' })).execution.permissions,
    ).toMatchObject({ mode: 'ask', defaultMode: 'ask', workspaceTrust: 'trusted' });
    expect((await client.getHostStatus()).execution.permissions.defaultMode).toBe('ask');
    writeFileSync(join(profile.profilePath, 'userconfig.jsonc'), '{ broken config');
    expect((await client.getHostStatus({ sessionId: 's', workspaceId: 'w' })).release.reason).toBe(
      'release_manifest_not_bound',
    );
    expect(await runtime.getChanges({ after: '0' })).toEqual(afterControls);
    expect(provider).toBe(0);
    expect(vault).toBe(0);
  } finally {
    client.disposeNetwork();
    await service.close();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic Store unavailable remains real authenticated HTTP; advertised host status cannot be spoofed', async () => {
  const service = await startService({
    diagnosticSource: createDefaultHostStatusSource({}),
    buildId: 'diagnostic',
    profile: { dataRoot: '/owned/no-store', name: 'owned', accessKey: 'owned-key' },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      requiredCapabilities: ['host_status'],
    },
  });
  try {
    await client.connect();
    const facts = await client.getHostStatus({ workspaceId: undefined, sessionId: undefined });
    expect(facts.identity.dataAvailability).toBe('unavailable');
    expect(facts.identity.storeId).toBeNull();
    expect(facts.scope).toEqual({ workspaceId: null, sessionId: null });
    expect(facts.execution.permissions).toMatchObject({
      state: 'unavailable',
      reason: 'data_unavailable',
      mode: null,
    });
    expect(facts.execution.state).toBe('available');
    expect(facts.release.reason).toBe('release_manifest_not_bound');
    expect(facts.telemetry.exporterConfigured).toBe(false);
    expect(
      (
        await fetch(`${service.endpoint}/v1/sessions`, {
          headers: { authorization: `Bearer ${service.bootstrap.token}` },
        })
      ).status,
    ).toBe(503);
  } finally {
    client.disposeNetwork();
    await service.close();
  }
  const unavailable = await startService({
    capabilities: ['host_status'],
    buildId: 'no-source',
    profile: { dataRoot: '/owned/no-store', name: 'owned', accessKey: 'owned-key' },
  });
  try {
    expect(unavailable.bootstrap.capabilities).not.toContain('host_status');
    const response = await fetch(`${unavailable.endpoint}/v1/diagnostics/host-status`, {
      headers: { authorization: `Bearer ${unavailable.bootstrap.token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).execution).toMatchObject({
      state: 'unavailable',
      reason: 'diagnostic_source_unavailable',
    });
  } finally {
    await unavailable.close();
  }
});

(process.platform === 'darwin' ? test : test.skip)(
  'trusted Shell asset verification is supervision only and does not start a Job',
  async () => {
    const source = createDefaultHostStatusSource({
      shell: {
        platform: 'darwin',
        configurationId: 'owned',
        env: {},
        supervisorPath: new URL(
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
          import.meta.url,
        ).pathname,
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
      },
    });
    const facts = await source.snapshot({ subjectId: 'owner', storeId: null });
    expect(facts.execution.shell).toMatchObject({
      configured: true,
      available: true,
      supervision: 'posix_group',
      qualification: 'darwin_supervision_only',
    });
    expect(facts.execution.sandbox).toEqual({
      backend: 'none',
      available: false,
      qualification: 'unqualified',
    });
    const unavailable = createDefaultHostStatusSource({
      shell: {
        platform: 'darwin',
        configurationId: 'owned',
        env: {},
        supervisorPath: '/missing-owned-asset',
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
      },
    });
    expect(
      (await unavailable.snapshot({ subjectId: 'owner', storeId: null })).execution.shell,
    ).toMatchObject({ configured: true, available: false, reason: 'shell_asset_unavailable' });
  },
);
