import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { type McpSourceReadSet, mcpCanonical } from '@kite-ai/agent/config';
import type { AuthorizationRequest, Extension, Json, ToolResult } from '@kite-ai/agent/extensions';
import { createMcpAdapter } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src/index';
import { createMcpConfiguration } from '../../src/mcp-configuration';
import { createMcpSourceConfiguration } from '../../src/mcp-source-configuration';

const object = (value: unknown): Record<string, Json> => value as Record<string, Json>;
function readSet(value: unknown): McpSourceReadSet {
  const row = object(value);
  const string = (value: Json | undefined) => {
    if (typeof value !== 'string') throw new Error('fixture_read_set_invalid');
    return value;
  };
  const nullableString = (value: Json | undefined) => (value === null ? null : string(value));
  const document = (value: unknown): McpSourceReadSet['user'] => {
    const row = object(value),
      identity = object(row.identity);
    if (identity.kind !== 'user' && identity.kind !== 'workspace')
      throw new Error('fixture_read_set_invalid');
    return {
      identity: {
        kind: identity.kind,
        pathDigest: string(identity.pathDigest),
        rootIdentity: string(identity.rootIdentity),
      },
      etag: nullableString(row.etag),
      error: nullableString(row.error),
    };
  };
  return {
    scopeDigest: string(row.scopeDigest),
    user: document(row.user),
    workspace: row.workspace === null ? null : document(row.workspace),
    approvalEtag: nullableString(row.approvalEtag),
    bindingEtag: nullableString(row.bindingEtag),
    variablesDigest: string(row.variablesDigest),
  };
}
async function until<T>(read: () => Promise<T | null>) {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= end) throw new Error('replacement_fixture_deadline');
    await Bun.sleep(5);
  }
}
// This fixture qualifies Service's replacement resolver against a real Action/Command.
// It does not replace Core's stop/open/fence or independent connection-Job approval tests.
async function fixture(observerSubjectId = 'owner') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-replacement-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  let revision = 1;
  const writeSource = () =>
    writeFileSync(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          local: { type: 'http', url: `http://127.0.0.1:1/revision-${revision}` },
        },
      }),
      { mode: 0o600 },
    );
  writeSource();
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  let runtime!: ReturnType<typeof createRuntime>;
  let selected = true,
    vaultCalls = 0,
    drift = false;
  const sources = createMcpSourceConfiguration({
    profile,
    runtime: () => runtime,
    observerSubjectId,
    selection: () => ({ present: !selected, configurations: [] }),
    credentialVault: {
      async resolve() {
        vaultCalls++;
        throw new Error('unexpected_vault');
      },
    },
    http: {
      allowLoopbackForTests: true,
      resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    },
  });
  const extension: Extension = {
    apiMajor: 1,
    id: 'builtin.mcp',
    version: '1',
    actions: [
      {
        id: 'mcp.reconnect',
        version: '1',
        description: 'Owned resolver qualification only',
        inputSchema: { type: 'object' },
        prepare: async (input) => input,
        async execute(input, context): Promise<ToolResult> {
          try {
            const request = object(input),
              replacement = object(request.replacement);
            const resolved = await sources.sourcePort.resolveReplacement!(
              {
                serverId: String(request.serverId),
                sessionId: context.sessionId,
                executionId: context.executionId,
                expectedConfigDigest: String(replacement.expectedConfigDigest),
                expectedReadSet: readSet(replacement.expectedReadSet),
              },
              { signal: context.signal },
            );
            if (drift) {
              revision++;
              writeSource();
            }
            resolved.assertFresh({ signal: context.signal });
            return {
              outcome: 'succeeded',
              content: 'resolved',
              details: {
                configDigest: createMcpAdapter(resolved.server).getCatalogue().configDigest,
                captureDigest: resolved.captureDigest,
                snapshotDigest: resolved.snapshotDigest ?? null,
                adapterAttempted: false,
              },
            };
          } catch (error) {
            return {
              outcome: 'failed',
              content: error instanceof Error ? error.message : 'unknown',
              details: { adapterAttempted: false },
            };
          }
        },
      },
    ],
  };
  runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: createSdkModelAdapter({
      models: new Map([
        [
          'unused',
          createCompatibleModelBinding({ baseURL: 'http://127.0.0.1:1/v1', modelId: 'unused' }),
        ],
      ]),
    }),
    modelId: 'unused',
    extensions: [extension, sources.extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned-resolver-policy' };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}/`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'owned',
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'replacement-resolver',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      apiMajor: 1,
      requiredCapabilities: ['extension_queries', 'extensions_actions'],
    },
  });
  await client.connect();
  async function input(): Promise<Json> {
    const view = await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {});
    const payload = object(view[0]!.payload),
      server = object((payload.items as Json[])[0]);
    return {
      serverId: server.id!,
      key: 'replacement',
      target: {
        carrierExecutionId: 'old-carrier',
        carrierKey: 'old',
        operationRef: {
          commandId: 'old-command',
          sessionId: 's',
          originStoreId: storeId,
          extensionId: 'builtin.mcp',
          key: `connection/${server.id}/old`,
          executionId: 'old-connection',
        },
        connectionExecutionId: 'old-connection',
        configDigest: '0'.repeat(64),
        currentGeneration: 1,
      },
      replacement: {
        kind: 'source',
        expectedConfigDigest: server.configDigest!,
        expectedReadSet: payload.readSet!,
      },
    };
  }
  async function invoke(value: Json, commandId = 'r') {
    await client.invokeExtension('s', {
      kind: 'extension.invoke',
      expectedStoreId: storeId,
      commandId,
      extensionId: 'builtin.mcp',
      actionId: 'mcp.reconnect',
      definitionVersion: '1',
      input: value,
    });
    return until(
      async () =>
        (await store.listExecutions('s')).find(
          (e) =>
            e.originCommandId === commandId &&
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(e.status),
        ) ?? null,
    );
  }
  return {
    input,
    invoke,
    store,
    storeId,
    async selected() {
      return sources.select(
        await sources.capture({
          command: (await store.getCommand('create'))!,
          session: (await store.getSession('s'))!,
          workspace: (await store.getWorkspace('w'))!,
        }),
        { present: false, configurations: [] },
      );
    },
    bump() {
      revision++;
      writeSource();
    },
    deselect() {
      selected = false;
    },
    drift() {
      drift = true;
    },
    get vaultCalls() {
      return vaultCalls;
    },
    async close() {
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('replacement resolver binds a real R and current source independently of old target digest', async () => {
  const f = await fixture();
  try {
    const old = await f.input();
    const oldSelection = await f.selected();
    f.bump();
    const current = await f.input();
    expect(object(object(old).replacement).expectedConfigDigest).not.toBe(
      object(object(current).replacement).expectedConfigDigest,
    );
    const result = await f.invoke(current);
    expect(result.status).toBe('succeeded');
    expect(object(result.result).details).toMatchObject({
      configDigest: object(object(current).replacement).expectedConfigDigest,
      adapterAttempted: false,
    });
    const details = object(object(result.result).details);
    const jobInput: Json = {
      serverId: object(current).serverId!,
      configDigest: details.configDigest!,
      originStoreId: f.storeId,
      key: 'replacement',
      bootstrapId: 'owned-bootstrap',
      parentExecutionId: result.id,
      parentInputDigest: createHash('sha256').update(mcpCanonical(result.input)).digest('hex'),
      captureDigest: details.captureDigest!,
    };
    const admission = (input: Json, sessionId = 's') =>
      oldSelection.admissionError({
        kind: 'job',
        sessionId,
        runId: null,
        executionId: 'pending-job',
        definitionId: 'mcp.source.connection',
        definitionVersion: '1',
        input,
        signal: new AbortController().signal,
      });
    // Pure permission selection association; this is not a bootstrap/open permit.
    expect(admission(jobInput)).toBeNull();
    expect(admission({ ...object(jobInput), parentExecutionId: 'foreign-parent' })).toBe(
      'mcp_definition_version_unavailable',
    );
    expect(admission({ ...object(jobInput), captureDigest: '0'.repeat(64) })).toBe(
      'mcp_definition_version_unavailable',
    );
    expect(admission(jobInput, 'foreign-session')).toBe('mcp_definition_version_unavailable');
    expect(
      admission({ serverId: object(current).serverId!, configDigest: details.configDigest! }),
    ).toBe('mcp_definition_version_unavailable');
    const second = await f.invoke({ ...object(current), key: 'replacement-two' }, 'r-two');
    expect(second.status).toBe('succeeded');
    const secondDetails = object(object(second.result).details);
    expect(secondDetails.snapshotDigest).toBe(details.snapshotDigest);
    expect(secondDetails.captureDigest).not.toBe(details.captureDigest);
    expect(result.runId).toBeNull();
    expect(f.vaultCalls).toBe(0);
    expect((await f.store.getView('s')).runs.length).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);

for (const scenario of [
  'stale',
  'deselected',
  'foreign-observer',
  'final-drift',
  'extra-input',
  'invalid-ref-path',
  'ref-execution-mismatch',
  'foreign-ref-store',
  'foreign-ref-session',
  'reused-carrier-key',
  'reused-operation-key',
] as const) {
  test(`replacement resolver rejects ${scenario} before transport`, async () => {
    const f = await fixture(scenario === 'foreign-observer' ? 'other' : 'owner');
    try {
      let input = await f.input();
      if (scenario === 'stale') f.bump();
      if (scenario === 'deselected') f.deselect();
      if (scenario === 'final-drift') f.drift();
      if (scenario === 'extra-input') input = { ...object(input), unexpected: true };
      if (
        scenario.startsWith('invalid-ref') ||
        scenario.startsWith('ref-execution') ||
        scenario.startsWith('foreign-ref') ||
        scenario.startsWith('reused-')
      ) {
        const value = object(input),
          target = object(value.target),
          ref = object(target.operationRef);
        if (scenario === 'invalid-ref-path') ref.key = 'old';
        if (scenario === 'ref-execution-mismatch') ref.executionId = 'other-connection';
        if (scenario === 'foreign-ref-store') ref.originStoreId = 'foreign-store';
        if (scenario === 'foreign-ref-session') ref.sessionId = 'foreign-session';
        if (scenario === 'reused-carrier-key') value.key = target.carrierKey!;
        if (scenario === 'reused-operation-key') {
          target.carrierKey = 'other-carrier';
          value.key = 'old';
        }
        input = { ...value, target: { ...target, operationRef: ref } };
      }
      const result = await f.invoke(input);
      expect(result.status).toBe('failed');
      expect(object(result.result).details).toMatchObject({ adapterAttempted: false });
      expect(f.vaultCalls).toBe(0);
      expect(
        (await f.store.listExecutions('s')).filter(
          (e) => e.definitionId === 'mcp.source.connection',
        ),
      ).toHaveLength(0);
      expect((await f.store.getView('s')).runs).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 10000);
}

test('static replacement admission is fixed to the actual factory digest and selected server', () => {
  const configured = createMcpConfiguration({
    servers: [{ id: 'fixed', transport: { type: 'http', url: 'https://example.invalid/mcp' } }],
    transportPort: {
      async open() {
        throw new Error('no_io');
      },
    },
  });
  const selected = configured.select([{ id: 'fixed' }]);
  const digest = selected.snapshot.servers[0]!.configDigest;
  const request = (serverId: string, replacement: Json): AuthorizationRequest => ({
    sessionId: 's',
    runId: null,
    executionId: 'static-replacement',
    signal: new AbortController().signal,
    kind: 'job',
    definitionId: 'builtin.mcp/mcp.reconnect',
    definitionVersion: '1',
    input: { serverId, replacement },
  });
  expect(
    selected.admissionError(request('fixed', { kind: 'static', expectedConfigDigest: digest })),
  ).toBeNull();
  expect(
    selected.admissionError(
      request('fixed', { kind: 'static', expectedConfigDigest: '0'.repeat(64) }),
    ),
  ).toBe('mcp_definition_version_unavailable');
  expect(
    selected.admissionError(request('fixed', { kind: 'source', expectedConfigDigest: digest })),
  ).toBe('mcp_definition_version_unavailable');
  expect(
    configured
      .select()
      .admissionError(request('fixed', { kind: 'static', expectedConfigDigest: digest })),
  ).toBe('mcp_server_not_selected');
});
