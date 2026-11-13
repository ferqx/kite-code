import { chmodSync, rmSync } from 'node:fs';
import { createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createProfileTraceRuntime } from '../../src/trace-runtime';
import { createTrajectorySource } from '../../src/trajectory';

test('authenticated generated Client management reaches the default profile Host without inheriting business permissions', async () => {
  const root = temporaryDirectory('kite-trace-http-');
  chmodSync(root, 0o700);
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const model = createFixedModel([]),
    runtime = createRuntime({
      store,
      model,
      permissions: {
        async authorize() {
          throw Error('unexpected_permission_io');
        },
      },
    });
  const trajectory = createTrajectorySource(store);
  const trace = createProfileTraceRuntime({
    profile,
    source: trajectory,
    subjectId: 'actor',
    credentialBackend: createTemporaryCredentialBackend(),
  });
  const service = await startService({
    runtime,
    trajectory,
    traceHost: trace.host,
    subjectId: 'actor',
    buildId: 'trace-http',
    profile: { dataRoot: root, name: 'test', accessKey: profile.profileAccessKey },
    beforeResourceClose: () => trace.close(),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['trace_extensions'],
    },
  });
  try {
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: 'file:///PRIVATE_WORKSPACE',
      name: 'PRIVATE_NAME',
    });
    await store.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      commandId: 'create',
      subjectId: 'actor',
      workspaceId: 'w',
      title: 'PRIVATE_TITLE',
    });
    await client.connect();
    const metadata = await store.getMetadata();
    const installed = await client.traceExtensions.installOpenTelemetry({
      endpoint: 'https://collector.example/v1/traces',
      sampleRate: 1,
    });
    const first = await client.traceExtensions.inspect(installed.installationId);
    expect(first).toMatchObject({
      kind: 'opentelemetry',
      status: 'configured',
      grant: null,
      partitions: [],
    });
    expect(await client.traceExtensions.delivery(installed.installationId)).toEqual({
      kind: 'opentelemetry',
      status: 'not_started',
      inspection: null,
    });
    await expect(
      client.traceExtensions.action(installed.installationId, 'enable'),
    ).rejects.toMatchObject({ code: 'trace_grant_required' });
    const credential = await client.traceExtensions.bindCredential(installed.installationId, {
      origin: 'https://collector.example',
      secret: 'synthetic-test-secret',
    });
    await client.traceExtensions.configure(installed.installationId, {
      settings: { ...first.settings, credentialHandle: credential.handle },
    });
    const authorized = await client.traceExtensions.grant(installed.installationId, {
      scopes: [{ storeId, sessionId: 's' }],
      eventKinds: ['run', 'model'],
      metadata: ['timing', 'usage'],
      evidenceKinds: [],
      origins: ['https://collector.example'],
      originalIdentity: false,
      allowHistory: true,
      credentialHandles: [credential.handle],
    });
    expect(authorized.grant).toMatchObject({
      active: true,
      grant: { originalIdentity: false, evidenceKinds: [] },
    });
    expect(authorized.status).not.toBe('enabled');
    await client.traceExtensions.action(installed.installationId, 'enable');
    const history = await client.traceExtensions.history(installed.installationId, {
      scope: { storeId, sessionId: 's' },
      contentMode: 'metadata',
      fromSequence: '0',
    });
    expect(
      (await client.traceExtensions.partition(installed.installationId, history.partitionId)).lane,
    ).toBe('history');
    await client.traceExtensions.partitionAction(
      installed.installationId,
      history.partitionId,
      'pause',
    );
    expect(
      (await client.traceExtensions.partition(installed.installationId, history.partitionId))
        .status,
    ).toBe('paused');
    await client.traceExtensions.partitionAction(
      installed.installationId,
      history.partitionId,
      'resume',
    );
    await client.traceExtensions.partitionAction(
      installed.installationId,
      history.partitionId,
      'cancel',
    );
    expect(
      (await client.traceExtensions.partition(installed.installationId, history.partitionId))
        .status,
    ).toBe('cancelled');
    await client.traceExtensions.action(installed.installationId, 'disable');
    await client.traceExtensions.action(installed.installationId, 'revoke');
    expect((await client.traceExtensions.inspect(installed.installationId)).grant?.active).toBe(
      false,
    );
    await client.traceExtensions.revokeCredential(installed.installationId, {
      handle: credential.handle,
    });
    await client.traceExtensions.action(installed.installationId, 'uninstall');
    expect((await client.traceExtensions.list()).installations).toHaveLength(0);
    expect(await store.getMetadata()).toEqual(metadata);
    expect(model.requests).toHaveLength(0);
    const response = await fetch(`${service.endpoint}/v1/trace/extensions`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.status).toBe(401);
    const invalid = await fetch(`${service.endpoint}/v1/trace/integrations/opentelemetry/install`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        endpoint: 'https://collector.example/v1/traces',
        subjectId: 'foreign',
        kind: 'third_party',
      }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
