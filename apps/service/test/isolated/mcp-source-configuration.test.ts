import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { createMcpLifecycle } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src/index';
import {
  createMcpSourceConfiguration,
  type McpSourceSelectionInput,
} from '../../src/mcp-source-configuration';
import { createPermissionPolicy } from '../../src/permissions';

const object = (value: unknown) => value as Record<string, Json>;
async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('source_fixture_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  project = false,
  credentialAuth = false,
  dns = false,
  stdio = false,
  safePolicy = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-scoped-mcp-source-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const wire: string[] = [];
  let lookups = 0;
  let beforeLookup: (() => void) | undefined;
  let afterDns: (() => void) | undefined;
  const backend = createTemporaryCredentialBackend();
  const vault = createCredentialVault({
    backend: {
      ...backend,
      async resolve(id) {
        lookups++;
        const value = await backend.resolve(id);
        beforeLookup?.();
        return value;
      },
    },
  });
  const credential = await vault.put('owned-temporary-bearer');
  const network = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { method: string; id?: number };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      wire.push(rpc.method);
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'owned', version: '1' },
              capabilities: { tools: {}, resources: {}, prompts: {} },
            }
          : rpc.method === 'tools/list'
            ? { tools: [] }
            : rpc.method === 'resources/list'
              ? { resources: [] }
              : rpc.method === 'prompts/list'
                ? { prompts: [] }
                : {};
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const ledger = join(root, 'stdio-wire.jsonl');
  const built = stdio
    ? await Bun.build({
        entrypoints: [
          join(import.meta.dir, '../../../../packages/agent/src/mcp/stdio-guardian.ts'),
        ],
        outdir: root,
        naming: 'qualified-guardian.js',
        target: 'bun',
      })
    : undefined;
  if (built) expect(built.success).toBe(true);
  const raw = {
    ...(stdio
      ? {
          command: process.execPath,
          args: [
            join(import.meta.dir, '../../../../tests/fixtures/mcp-leaf/resources-prompts.ts'),
            ledger,
          ],
          cwd: workspace,
          env: {},
        }
      : {}),
    type: stdio ? 'stdio' : 'http',
    url: dns ? network.url.href.replace('127.0.0.1', 'owned.fixture.invalid') : network.url.href,
    auth: credentialAuth
      ? { type: 'credential', credentialRef: credential.id, profile: 'owned' }
      : { type: 'none' },
    unknown: { private: 'RAW_PRIVATE_VALUE' },
  };
  const userPath = join(profile.profilePath, 'mcp.json');
  writeFileSync(userPath, JSON.stringify({ mcpServers: { local: raw } }));
  const projectPath = join(workspace, '.kite-code', 'mcp.json');
  if (project) {
    mkdirSync(join(workspace, '.kite-code'));
    writeFileSync(projectPath, JSON.stringify({ mcpServers: { local: raw } }));
  }
  let runtime!: ReturnType<typeof createRuntime>;
  let selection: McpSourceSelectionInput = { present: false, configurations: [] };
  let sourcePermission: 'allow' | 'deny' | 'ask' = 'allow';
  const sources = createMcpSourceConfiguration({
    profile,
    runtime: () => runtime,
    credentialVault: vault,
    selection: () => selection,
    ...(built
      ? { stdio: { guardianPath: built.outputs[0]!.path, bunExecutable: process.execPath } }
      : {}),
    http: {
      allowLoopbackForTests: true,
      resolveAddresses: async () => {
        afterDns?.();
        return [{ address: '127.0.0.1', family: 4 }];
      },
    },
  });
  const lifecycle = createMcpLifecycle({ servers: [], scopedSources: sources.sourcePort });
  const modelBodies: Record<string, unknown>[] = [];
  let directoryModel = false;
  let beforeModelReply: (() => void) | undefined;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      modelBodies.push(body);
      const call = directoryModel && modelBodies.length === 1;
      beforeModelReply?.();
      const chunk = {
        id: 'fixed',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'source-directory',
                      type: 'function',
                      function: { name: 'mcp.sources.list', arguments: '{}' },
                    },
                  ],
                }
              : { content: 'done' },
            finish_reason: null,
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const model = createSdkModelAdapter({
    models: new Map([
      [
        'local',
        createCompatibleModelBinding({ baseURL: `${provider.url.href}v1`, modelId: 'local' }),
      ],
    ]),
  });
  runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'local',
    extensions: [sources.extension, lifecycle.extension],
    permissions: safePolicy
      ? createPermissionPolicy({
          readPolicy: () => ({
            mode: 'ask',
            workspaceTrust: true,
            revision: 'source-default-policy',
            allowed: [
              { kind: 'model', definitionId: 'local', definitionVersion: '1' },
              { kind: 'tool', definitionId: 'mcp.sources.list', definitionVersion: '1' },
            ],
          }),
          describeCapability: (request) =>
            request.kind === 'model'
              ? {
                  kind: 'model',
                  definitionId: request.definitionId,
                  definitionVersion: request.definitionVersion,
                  revision: 'model-fixed',
                  effects: ['unknown'],
                  hardAllowed: true,
                  safeRead: false,
                }
              : sources.describe(request),
        })
      : {
          async authorize(request) {
            if (request.definitionId === 'mcp.source.connection' && sourcePermission !== 'allow')
              return sourcePermission === 'deny'
                ? { allowed: false, revision: 'source-denied', reason: 'source_job_denied' }
                : {
                    allowed: false,
                    revision: 'source-ask',
                    approval: {
                      request: { effects: ['external'] },
                      grants: ['approve_once'],
                    },
                  };
            return { allowed: true, revision: 'wide-policy' };
          },
        },
    resolveRunConfiguration: async (input) => {
      const capture = await sources.capture(input),
        selected = sources.select(capture, selection);
      return {
        model,
        modelId: 'local',
        snapshot: { mcp: { sources: selected.snapshot } } as unknown as Json,
        toolIds: ['mcp.connect', 'mcp.sources.list'],
        sources: selected.sources,
      };
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}/`,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create-a',
    sessionId: 'a',
    workspaceId: 'w',
    subjectId: 'user',
    title: 'owned',
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'scoped-source-owned',
    subjectId: 'user',
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
  async function query() {
    return object(
      (await client.queryExtension('a', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!.payload,
    );
  }
  async function invoke(actionId: string, input: Json, commandId: string) {
    await client.invokeExtension('a', {
      kind: 'extension.invoke',
      commandId,
      expectedStoreId,
      extensionId:
        actionId.startsWith('mcp.source.') || actionId.startsWith('mcp.credential.')
          ? 'builtin.mcp.sources'
          : 'builtin.mcp',
      actionId,
      definitionVersion: '1',
      input,
    });
    await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    return (await store.listExecutions('a')).find((e) => e.originCommandId === commandId)!;
  }
  return {
    root,
    profile,
    workspace,
    userPath,
    projectPath,
    raw,
    store,
    runtime,
    sources,
    lifecycle,
    client,
    wire,
    ledger,
    modelBodies,
    directoryModel(before?: () => void) {
      directoryModel = true;
      modelBodies.splice(0);
      beforeModelReply = before;
    },
    expectedStoreId,
    credential,
    query,
    invoke,
    get lookups() {
      return lookups;
    },
    afterDns(value: () => void) {
      afterDns = value;
    },
    beforeLookup(value: () => void) {
      beforeLookup = value;
    },
    setSelection(value: McpSourceSelectionInput) {
      selection = value;
    },
    permission(value: 'allow' | 'deny' | 'ask') {
      sourcePermission = value;
    },
    async close(expectedUnknown = false) {
      try {
        if (expectedUnknown) {
          const before = await store.listExecutions('a');
          expect(await runtime.close().catch((error: unknown) => error)).toMatchObject({
            code: 'shutdown_cleanup_unconfirmed',
          });
          expect(runtime.getLifecycleState().state).toBe('drain_failed');
          expect(await store.listExecutions('a')).toEqual(before);
          await lifecycle.close();
          await store.close();
        } else await service.close();
      } finally {
        network.stop(true);
        provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('cold safe directory exposes selected source identity without credentials, connection or raw data', async () => {
  const f = await fixture();
  try {
    const metadata = await f.query();
    expect(object((metadata.items as Json[])[0]).id).toMatch(/^mcp-/);
    expect(JSON.stringify(metadata)).not.toContain(f.raw.url);
    expect(JSON.stringify(metadata)).not.toContain('RAW_PRIVATE_VALUE');
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
    const registry = f.sources.registry({
      storeId: f.expectedStoreId,
      sessionId: 'a',
      workspaceId: 'w',
      workspacePath: f.workspace,
    });
    expect(registry.servers).toHaveLength(1);
    expect(f.wire).toEqual([]);
    expect(f.lifecycle.extension.jobs!.map((j) => j.id)).toEqual(['mcp.source.connection']);
  } finally {
    await f.close();
  }
});

test('explicit empty selection is empty; pending project shadows enabled same-name user and wide policy is no approval', async () => {
  const f = await fixture(true);
  try {
    const metadata = await f.query(),
      server = object((metadata.items as Json[])[0]);
    expect(server.admitted).toBe(false);
    expect(object(server.source).kind).toBe('workspace');
    const failed = await f.invoke(
      'mcp.connect',
      { serverId: server.id!, key: 'blocked' },
      'connect-pending',
    );
    expect(failed.status).toBe('failed');
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
    const scope = {
      profileId: f.profile.profileAccessKey,
      storeId: f.expectedStoreId,
      sessionId: 'a',
      workspaceId: 'w',
    };
    const capture = {
      version: 1 as const,
      scope,
      scopeDigest: String(object(metadata.readSet).scopeDigest),
      readSet: metadata.readSet as never,
      registryRevision: String(metadata.registryRevision),
      servers: metadata.items as never,
    };
    expect(f.sources.select(capture, { present: true, configurations: [] }).snapshot).toMatchObject(
      { servers: [], readSet: null, selection: { present: true, serverIds: [] } },
    );
  } finally {
    await f.close();
  }
});

test('project approval is actual accepted question and original HostMutation; source connect uses safe ordinary Job input', async () => {
  const f = await fixture(true);
  try {
    const metadata = await f.query(),
      server = object((metadata.items as Json[])[0]);
    const pending = f.invoke(
      'mcp.source.approve',
      { serverId: server.id!, expectedReadSet: metadata.readSet! },
      'approve-source',
    );
    const card = await until(
      async () =>
        (
          await f.store.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 'a',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    expect(card.kind).toBe('question');
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      commandId: 'answer-source',
      presentationSessionId: card.presentationSessionId,
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'question', answers: { decision: 'approved' } },
    });
    const approved = await pending;
    expect(approved.status).toBe('succeeded');
    expect(readFileSync(join(f.profile.profilePath, 'mcp-approvals.json'), 'utf8')).toContain(
      card.id,
    );
    const next = await f.query();
    expect(object((next.items as Json[])[0]).admitted).toBe(true);
    const connected = await f.invoke(
      'mcp.connect',
      { serverId: server.id!, key: 'first' },
      'connect-source',
    );
    expect(connected.status).toBe('succeeded');
    expect(f.wire).toContain('initialize');
    const job = (await f.store.listExecutions('a')).find(
      (e) => e.definitionId === 'mcp.source.connection',
    )!;
    expect(job.definitionVersion).toBe('1');
    expect(job.originStoreId).toBe(f.expectedStoreId);
    expect(object(job.input).parentExecutionId).toBe(connected.id);
    expect(JSON.stringify(job.input)).not.toContain(f.raw.url);
    expect(JSON.stringify(job.input)).not.toContain('RAW_PRIVATE_VALUE');
  } finally {
    await f.close();
  }
});

async function answer(
  f: Awaited<ReturnType<typeof fixture>>,
  decision: string,
  before?: () => void,
) {
  const card = await until(
    async () =>
      (
        await f.store.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'a',
          state: 'pending',
        })
      ).interactions[0] ?? null,
  );
  before?.();
  await f.runtime.answerInteraction({
    expectedStoreId: f.expectedStoreId,
    subjectId: 'user',
    commandId: `answer-${card.id}`,
    presentationSessionId: card.presentationSessionId,
    interactionId: card.id,
    expectedRevision: card.revision,
    answer: { kind: 'question', answers: { decision } },
  });
  return card;
}

test('actual reject and source drift after accepted approval are independent zero-wire outcomes', async () => {
  for (const mode of ['rejected', 'drift']) {
    const f = await fixture(true);
    try {
      const metadata = await f.query(),
        server = object((metadata.items as Json[])[0]);
      const pending = f.invoke(
        'mcp.source.approve',
        { serverId: server.id!, expectedReadSet: metadata.readSet! },
        `approve-${mode}`,
      );
      await answer(
        f,
        mode === 'rejected' ? 'rejected' : 'approved',
        mode === 'drift'
          ? () =>
              writeFileSync(
                f.projectPath,
                JSON.stringify({ mcpServers: { local: { ...f.raw, unknown: { changed: true } } } }),
              )
          : undefined,
      );
      const execution = await pending;
      expect(execution.status).toBe(mode === 'rejected' ? 'succeeded' : 'failed');
      expect(f.wire).toEqual([]);
      expect(f.lookups).toBe(0);
      if (mode === 'rejected')
        expect(object(((await f.query()).items as Json[])[0]).reason).toBe(
          'mcp_project_approval_rejected',
        );
    } finally {
      await f.close();
    }
  }
});

test('opaque credential is unavailable until actual independent bind; cold Query and approval never lookup vault', async () => {
  const f = await fixture(false, true);
  try {
    let metadata = await f.query(),
      server = object((metadata.items as Json[])[0]);
    expect(server.admitted).toBe(false);
    expect(server.reason).toBe('mcp_credential_binding_required');
    expect(JSON.stringify(metadata)).not.toContain(f.credential.id);
    expect(f.lookups).toBe(0);
    const pending = f.invoke(
      'mcp.credential.bind',
      { serverId: server.id!, expectedReadSet: metadata.readSet!, expiresAt: Date.now() + 60000 },
      'bind-credential',
    );
    const card = await answer(f, 'bind');
    const bound = await pending;
    expect(bound.status).toBe('succeeded');
    expect(readFileSync(join(f.profile.profilePath, 'mcp-auth-bindings.json'), 'utf8')).toContain(
      card.id,
    );
    metadata = await f.query();
    server = object((metadata.items as Json[])[0]);
    expect(server.admitted).toBe(true);
    expect(f.lookups).toBe(0);
    expect(f.wire).toEqual([]);
    const connected = await f.invoke(
      'mcp.connect',
      { serverId: server.id!, key: 'auth' },
      'connect-auth',
    );
    expect(connected.status).toBe('succeeded');
    expect(f.lookups).toBeGreaterThan(0);
    expect(f.wire).toContain('initialize');
  } finally {
    await f.close();
  }
});

test('source drift after real DNS admission blocks socket and preserves unknown original connection Job', async () => {
  const f = await fixture(false, false, true);
  const unknown = true;
  try {
    const metadata = await f.query(),
      server = object((metadata.items as Json[])[0]);
    f.afterDns(() =>
      writeFileSync(
        f.userPath,
        JSON.stringify({ mcpServers: { local: { ...f.raw, unknown: { drift: 'after-dns' } } } }),
      ),
    );
    const connected = await f.invoke(
      'mcp.connect',
      { serverId: server.id!, key: 'dns-drift' },
      'connect-dns-drift',
    );
    expect(connected.status).toBe('failed');
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
    const all = await f.store.listExecutions('a');
    console.log('DNS first execution snapshot', JSON.stringify(all));
    const job = all.find((e) => e.definitionId === 'mcp.source.connection')!;
    expect(job.status).toBe('outcome_unknown');
    expect(job.rootWorkCommandId).toBe('connect-dns-drift');
    expect(job.originCommandId).toBe(
      String(object(object(object(connected.result).details).operationRef).commandId),
    );
    expect(object(job.input).parentExecutionId).toBe(connected.id);
    console.log(
      'source DNS drift original unknown facts',
      JSON.stringify({ job, command: await f.runtime.getCommand('connect-dns-drift') }),
    );
  } finally {
    await f.close(unknown);
  }
});

test('source drift during actual vault lookup blocks socket after credentials resolve; original handle cleanup remains supervised', async () => {
  const f = await fixture(false, true);
  try {
    const metadata = await f.query(),
      server = object((metadata.items as Json[])[0]);
    const binding = f.invoke(
      'mcp.credential.bind',
      { serverId: server.id!, expectedReadSet: metadata.readSet!, expiresAt: Date.now() + 60000 },
      'bind-lookup-drift',
    );
    await answer(f, 'bind');
    expect((await binding).status).toBe('succeeded');
    f.beforeLookup(() =>
      writeFileSync(
        f.userPath,
        JSON.stringify({ mcpServers: { local: { ...f.raw, unknown: { drift: 'after-vault' } } } }),
      ),
    );
    const connected = await f.invoke(
      'mcp.connect',
      { serverId: server.id!, key: 'vault-drift' },
      'connect-vault-drift',
    );
    expect(connected.status).toBe('failed');
    expect(f.lookups).toBeGreaterThan(0);
    expect(f.wire).toEqual([]);
    const old = await f.lifecycle.readStepCapabilities({
      command: { originStoreId: f.expectedStoreId },
      session: { id: 'a' },
    });
    expect(old.toolIds).toEqual([]);
  } finally {
    await f.close();
  }
});

test('owned stdio source uses qualified guardian asset and original scoped ordinary Job; cached Query does not reconnect', async () => {
  const f = await fixture(false, false, false, true);
  try {
    const metadata = await f.query(),
      server = object((metadata.items as Json[])[0]);
    expect(server.admitted).toBe(true);
    const connected = await f.invoke(
      'mcp.connect',
      { serverId: server.id!, key: 'stdio' },
      'connect-stdio-source',
    );
    expect(connected.status).toBe('succeeded');
    const ledger = readFileSync(f.ledger, 'utf8');
    expect(ledger).toContain('initialize');
    expect(ledger).toContain('tools/list');
    const record = (await f.store.getExtensionRecord({
      sessionId: 'a',
      extensionId: 'builtin.mcp',
      key: `connection/${server.id}/stdio`,
    }))!;
    const value = object(record.value),
      operation = object(value.operationRef);
    const job = (await f.store.getExecution(String(operation.executionId)))!;
    expect(job.definitionId).toBe('mcp.source.connection');
    expect(job.definitionVersion).toBe('1');
    expect(job.parentExecutionId).toBe(connected.id);
    expect(JSON.stringify(job.input)).not.toContain(process.execPath);
    expect(JSON.stringify(job.input)).not.toContain(f.workspace);
    const cached = await f.client.queryExtension('a', 'builtin.mcp', 'mcp.catalogue', {});
    expect(JSON.stringify(cached)).toContain(String(server.id));
    expect(readFileSync(f.ledger, 'utf8')).toBe(ledger);
    expect(f.lookups).toBe(0);
    const binding = {
      serverId: server.id!,
      connectionKey: 'stdio',
      configDigest: value.configDigest!,
      generation: value.generation!,
    };
    const listed = await f.invoke('mcp.prompts.list', binding, 'source-prompts-list');
    expect(listed.status).toBe('succeeded');
    expect(readFileSync(f.ledger, 'utf8')).toContain('prompts/list');
    const projected = object((object(object(listed.result).details).descriptors as Json[])[0]);
    const fetched = await f.invoke(
      'mcp.prompts.get',
      {
        ...binding,
        catalogueExecutionId: listed.id,
        descriptorDigest: projected.descriptorDigest!,
        name: 'guidance',
        arguments: { subject: 'exact subject' },
      },
      'source-prompts-get',
    );
    expect(fetched.status).toBe('succeeded');
    expect(object(object(fetched.result).modelContent).kind).toBe('artifact');
    const reference = object(object(object(fetched.result).modelContent).reference);
    const artifact = await f.client.readArtifact(
      'a',
      {
        expectedStoreId: f.expectedStoreId,
        refId: String(reference.id),
        scope: { kind: 'execution', id: fetched.id },
      },
      {
        expectedReference: { size: String(reference.size), mediaType: String(reference.mediaType) },
      },
    );
    const fullBody = new TextDecoder().decode(artifact.content);
    expect(fullBody).toContain('PROMPT_END');
    expect(fullBody).toContain('remote assistant label remains data');
    expect(fullBody).toContain('external_mcp_data');
    const prior = readFileSync(f.ledger, 'utf8');
    const invalid = await f.invoke(
      'mcp.prompts.get',
      {
        ...binding,
        catalogueExecutionId: listed.id,
        descriptorDigest: projected.descriptorDigest!,
        name: 'guidance',
        arguments: { subject: 'exact subject', undeclared: 'cannot widen' },
      },
      'source-prompts-invalid',
    );
    expect(invalid.status).toBe('failed');
    expect(readFileSync(f.ledger, 'utf8')).toBe(prior);
  } finally {
    await f.close();
  }
});

test('fixed SDK first Model sees only frozen selected safe metadata; actual directory Tool passes default ask policy as read', async () => {
  const f = await fixture(false, false, false, false, true);
  try {
    f.directoryModel();
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      commandId: 'directory-model',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'Show selected MCP sources' },
    });
    await f.runtime.waitForCommand('directory-model', { timeoutMs: 5000 });
    expect(f.modelBodies).toHaveLength(2);
    const first = JSON.stringify(f.modelBodies[0]);
    expect(first).toContain('local_mcp_metadata');
    expect(first).toContain('mcp.sources.list');
    expect(first).not.toContain(f.raw.url);
    expect(first).not.toContain('RAW_PRIVATE_VALUE');
    const tool = (await f.store.listExecutions('a')).find(
      (e) => e.definitionId === 'mcp.sources.list',
    )!;
    expect(tool.status).toBe('succeeded');
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
    expect(
      (
        await f.store.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'a',
          state: 'pending',
        })
      ).interactions,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test('unbound standalone composition is pure zero-source authority even with actual files present; wrong host facts still reject', async () => {
  const f = await fixture();
  try {
    let hosts = 0,
      vault = 0;
    const unbound = createMcpSourceConfiguration({
      profile: f.profile,
      runtime: () => {
        hosts++;
        throw Error('host-unbound');
      },
      credentialVault: {
        async resolve() {
          vault++;
          throw Error('no-vault');
        },
      },
    });
    const facts = {
      command: { originStoreId: f.expectedStoreId, sessionId: 'a' },
      session: { id: 'a', workspaceId: 'w' },
      workspace: { id: 'w' },
    };
    const selected = unbound.unboundSelection(facts, {
      present: true,
      configurations: [{ id: 'mcp-' + 'a'.repeat(64) }],
    });
    expect(selected.snapshot).toMatchObject({
      servers: [],
      readSet: null,
      selection: { present: true, serverIds: [] },
    });
    expect(hosts).toBe(0);
    expect(vault).toBe(0);
    expect(f.wire).toEqual([]);
    expect(() =>
      unbound.unboundSelection({ ...facts, command: { ...facts.command, sessionId: 'other' } }),
    ).toThrow('mcp_source_scope_invalid');
  } finally {
    await f.close();
  }
});

test('schema-valid saved approval cannot self-report original accepted decision authority', async () => {
  const f = await fixture(true);
  try {
    const metadata = await f.query(),
      server = object((metadata.items as Json[])[0]);
    const pending = f.invoke(
      'mcp.source.approve',
      { serverId: server.id!, expectedReadSet: metadata.readSet! },
      'approve-original',
    );
    await answer(f, 'approved');
    expect((await pending).status).toBe('succeeded');
    const path = join(f.profile.profilePath, 'mcp-approvals.json'),
      saved = JSON.parse(readFileSync(path, 'utf8'));
    const key = Object.keys(saved.records)[0]!;
    saved.records[key].proof.interactionId = 'forged-but-well-formed';
    saved.records[key].proof.decisionId =
      'forged-but-well-formed@' + saved.records[key].proof.acceptedRevision;
    writeFileSync(path, JSON.stringify(saved));
    expect(object(((await f.query()).items as Json[])[0]).admitted).toBe(true); // File schema admission is not a Tool grant.
    const failed = await f.invoke(
      'mcp.connect',
      { serverId: server.id!, key: 'forged' },
      'connect-forged-proof',
    );
    expect(failed.status).toBe('failed');
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
    expect(
      (await f.store.listExecutions('a')).filter((e) => e.definitionId === 'mcp.source.connection'),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test('old Run source capture refuses local directory drift; next Run captures changed source without changing old projection', async () => {
  const f = await fixture(false, false, false, false, true);
  try {
    const before = await f.query(),
      oldDigest = object((before.items as Json[])[0]).rawEntryDigest;
    let changed = false;
    f.directoryModel(() => {
      if (changed) return;
      changed = true;
      writeFileSync(
        f.userPath,
        JSON.stringify({ mcpServers: { local: { ...f.raw, unknown: { newRun: true } } } }),
      );
    });
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      commandId: 'old-source-run',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'Read source' },
    });
    await f.runtime.waitForCommand('old-source-run', { timeoutMs: 5000 });
    const old = (await f.store.listExecutions('a')).find(
      (e) => e.definitionId === 'mcp.sources.list' && e.rootWorkCommandId === 'old-source-run',
    )!;
    expect(old.status).toBe('failed');
    expect(object(old.result).content).toBe('mcp_source_stale');
    const oldRun = (await f.runtime.getRun(old.runId!))!;
    expect(JSON.stringify(oldRun.configuration)).toContain(String(oldDigest));
    f.directoryModel();
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      commandId: 'new-source-run',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'Read new source' },
    });
    await f.runtime.waitForCommand('new-source-run', { timeoutMs: 5000 });
    const next = (await f.store.listExecutions('a')).find(
      (e) => e.definitionId === 'mcp.sources.list' && e.rootWorkCommandId === 'new-source-run',
    )!;
    expect(next.status).toBe('succeeded');
    expect(next.runId).not.toBe(old.runId);
    expect((await f.runtime.getRun(old.runId!))!.configuration).toEqual(oldRun.configuration);
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
  } finally {
    await f.close();
  }
});

test('unrelated fixed Model completes with malformed source and zero selected source dependencies', async () => {
  const f = await fixture(false, false, false, false, true);
  try {
    writeFileSync(f.userPath, '{ malformed private source');
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'a',
      commandId: 'plain-model',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'Ordinary task without MCP' },
    });
    await f.runtime.waitForCommand('plain-model', { timeoutMs: 5000 });
    expect(f.modelBodies).toHaveLength(1);
    const model = (await f.store.listExecutions('a')).find((e) => e.kind === 'model')!;
    expect(model.status).toBe('succeeded');
    const run = (await f.runtime.getRun(model.runId!))!,
      snapshot = object(object(run.configuration).snapshot),
      selected = object(object(snapshot.mcp).sources);
    expect(selected.servers).toEqual([]);
    expect(selected.readSet).toBe(null);
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
  } finally {
    await f.close();
  }
});

test('source connection Job has independent deny and Ask; approved grant cannot override captured source drift before port IO', async () => {
  for (const mode of ['deny', 'ask'] as const) {
    const f = await fixture();
    try {
      const metadata = await f.query(),
        server = object((metadata.items as Json[])[0]);
      f.permission(mode);
      const pending = f.invoke(
        'mcp.connect',
        { serverId: server.id!, key: mode },
        `source-job-${mode}`,
      );
      if (mode === 'ask') {
        const card = await until(
          async () =>
            (
              await f.store.listInteractions({
                expectedStoreId: f.expectedStoreId,
                sessionId: 'a',
                state: 'pending',
              })
            ).interactions[0] ?? null,
        );
        expect(card.kind).toBe('approval');
        expect(f.wire).toEqual([]);
        expect(f.lookups).toBe(0);
        writeFileSync(
          f.userPath,
          JSON.stringify({
            mcpServers: { local: { ...f.raw, unknown: { changedDuringGrant: true } } },
          }),
        );
        await f.runtime.answerInteraction({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'user',
          commandId: `grant-${card.id}`,
          presentationSessionId: card.presentationSessionId,
          interactionId: card.id,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
        });
      }
      const failed = await pending;
      expect(failed.status).toBe('failed');
      expect(f.wire).toEqual([]);
      expect(f.lookups).toBe(0);
      const job = (await f.store.listExecutions('a')).find(
        (e) => e.definitionId === 'mcp.source.connection',
      )!;
      expect(job.status).toBe('failed');
      expect(
        (await f.store.listExecutions('a')).filter((e) => e.status === 'outcome_unknown'),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }
});

test('supported macOS ancestor alias binds actual canonical source root while final Workspace symlink rejects locally', async () => {
  const f = await fixture();
  try {
    const canonical = await f.query();
    const alias = f.workspace.startsWith('/private/var/')
      ? f.workspace.replace('/private/var/', '/var/')
      : f.workspace;
    await f.runtime.createWorkspace({
      expectedStoreId: f.expectedStoreId,
      id: 'alias-w',
      name: 'owned alias',
      rootUri: `file://${alias}/`,
    });
    await f.runtime.createSession({
      expectedStoreId: f.expectedStoreId,
      commandId: 'create-alias',
      sessionId: 'alias-a',
      workspaceId: 'alias-w',
      subjectId: 'user',
      title: 'alias',
    });
    const metadata = object(
      (await f.client.queryExtension('alias-a', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!
        .payload,
    );
    expect(object((metadata.items as Json[])[0]).admitted).toBe(true);
    expect(object(object(metadata.readSet).workspace).identity).toEqual(
      object(object(canonical.readSet).workspace).identity,
    );
    const link = join(f.root, 'workspace-symlink');
    symlinkSync(f.workspace, link);
    await f.runtime.createWorkspace({
      expectedStoreId: f.expectedStoreId,
      id: 'symlink-w',
      name: 'owned final link',
      rootUri: `file://${link}`,
    });
    await f.runtime.createSession({
      expectedStoreId: f.expectedStoreId,
      commandId: 'create-symlink',
      sessionId: 'symlink-a',
      workspaceId: 'symlink-w',
      subjectId: 'user',
      title: 'symlink',
    });
    const unavailable = object(
      (await f.client.queryExtension('symlink-a', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!
        .payload,
    );
    expect(unavailable).toMatchObject({
      items: [],
      readSet: null,
      errors: ['workspace_configuration_unavailable'],
    });
    expect(f.wire).toEqual([]);
    expect(f.lookups).toBe(0);
  } finally {
    await f.close();
  }
});
