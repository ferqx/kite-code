import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { type AgentClient, createClient, type Json } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { NativeMcpSettings } from '../../electron/mcp-settings';
import { verifyNativeMcpSourceAnswer } from '../../electron/mcp-source-answer';
import type { NativeMcpOperation, NativeMcpSubmission } from '../../src/native-bridge';
import { memoryPrivateData } from '../private-data.fixture';

const fullDescription = 'Full Native immutable descriptor 雪🙂 '.repeat(3000);
async function fixture() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-native-mcp-main-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.kite-code'), { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const wire: string[] = [];
  let credentialReads = 0,
    posts = 0,
    gets = 0,
    queries = 0,
    drop = false;
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { method: string; id?: number; params?: unknown };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      wire.push(rpc.method);
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'owned-native', version: '1' },
              capabilities: { tools: {} },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'native_echo',
                    description: fullDescription,
                    inputSchema: {
                      type: 'object',
                      properties: { value: { type: 'string' } },
                      required: ['value'],
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : rpc.method === 'tools/call'
              ? { content: [{ type: 'text', text: 'owned-native-effect' }] }
              : {};
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const user = join(profile.profilePath, 'mcp.json'),
    project = join(workspace, '.kite-code', 'mcp.json'),
    config = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    user,
    `// Native user comment\n${JSON.stringify({ unknown: { keep: true }, mcpServers: { original: { type: 'http', url: remote.url.href, auth: { type: 'none' } }, manual: { type: 'http', url: remote.url.href, auth: { type: 'credential', profile: 'owned-manual', credentialRef: 'credential:00000000-0000-0000-0000-000000000001' } } } })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    project,
    JSON.stringify({
      mcpServers: { project: { type: 'http', url: remote.url.href, auth: { type: 'none' } } },
    }),
    { mode: 0o600 },
  );
  writeFileSync(config, '// Native configuration comment\n{"models":[]}\n', { mode: 0o600 });
  const backend = createTemporaryCredentialBackend();
  const authorizations: string[] = [];
  const host = createDefaultProcessConfiguration({
    profile,
    observerSubjectId: 'owner',
    credentialBackend: {
      ...backend,
      async resolve(id) {
        credentialReads++;
        return backend.resolve(id);
      },
    },
    mcpSources: { http: { allowLoopbackForTests: true } },
    permissions: {
      async authorize(request) {
        authorizations.push(`${request.kind}:${request.definitionId}`);
        return { allowed: true, revision: 'owned-native-policy' };
      },
    },
  });
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const serial = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks!(serial);
  const runtime = createRuntime({
    store,
    workspaceSerialLocks: serial,
    artifacts: createArtifactStore({ profile, store }),
    extensions: host.extensions,
    conditions: host.conditions,
    permissions: host.permissions!,
    initializeRunRequirements: host.initializeRunRequirements,
    resolveRunConfiguration: host.resolveRunConfiguration,
    resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
    supportsExtensionInputs: host.supportsExtensionInputs,
  });
  host.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'Native',
    rootUri: `file://${workspace}/`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Native MCP',
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    subjectId: 'owner',
    buildId: 'native-mcp-owned',
    configurationManagement: host.configurationManagement!(runtime),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: [
        'commands',
        'extension_queries',
        'extensions_actions',
        'interactions',
        'configuration_management',
      ],
    },
  });
  try {
    await client.connect();
  } catch (error) {
    client.disposeNetwork();
    await service.close();
    await runtime.close();
    await store.close();
    remote.stop(true);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const tracked = new Proxy(client, {
    get(target, property) {
      if (property === 'invokeExtension')
        return async (...args: Parameters<AgentClient['invokeExtension']>) => {
          posts++;
          const result = await target.invokeExtension(...args);
          if (drop) {
            drop = false;
            throw Error('fixture_reply_lost');
          }
          return result;
        };
      if (property === 'getCommand')
        return async (...args: Parameters<AgentClient['getCommand']>) => {
          gets++;
          return target.getCommand(...args);
        };
      if (property === 'queryExtension')
        return async (...args: Parameters<AgentClient['queryExtension']>) => {
          queries++;
          return target.queryExtension(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const data = memoryPrivateData(),
    scope = { generation: 1, selection: 1, storeId, sessionId: 's' };
  const manager = new NativeMcpSettings(
    tracked,
    () => scope,
    () => {},
    data,
  );
  return {
    root,
    workspace,
    profile,
    store,
    runtime,
    client,
    tracked,
    manager,
    data,
    scope,
    user,
    project,
    config,
    remote,
    wire,
    authorizations,
    get credentialReads() {
      return credentialReads;
    },
    get posts() {
      return posts;
    },
    get gets() {
      return gets;
    },
    get queries() {
      return queries;
    },
    loseReply() {
      drop = true;
    },
    async close() {
      manager.release();
      client.disposeNetwork();
      await service.close();
      await runtime.close();
      await store.close();
      remote.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function settle(
  f: Awaited<ReturnType<typeof fixture>>,
  submission: NativeMcpSubmission,
  decision?: 'approved' | 'bind' | 'revoke',
): Promise<NativeMcpSubmission> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const page = await f.client.listInteractions('s', {
      storeId: f.scope.storeId,
      state: 'pending',
      limit: 20,
    });
    for (const card of page.interactions) {
      if (card.state !== 'pending') continue;
      const request = card.request as Record<string, Json>;
      if (
        card.kind === 'question' &&
        ['mcp_source_approval', 'mcp_credential_binding'].includes(String(request.kind))
      ) {
        expect(decision).toBeDefined();
        const answer = { kind: 'question' as const, answers: { decision: decision! } };
        verifyNativeMcpSourceAnswer(card, answer, f.scope.storeId);
        expect(() =>
          verifyNativeMcpSourceAnswer(
            card,
            { kind: 'question', answers: { decision: decision!, secret: 'never-save' } },
            f.scope.storeId,
          ),
        ).toThrow('mcp_source_question_invalid');
        await f.client.answerInteraction('s', card.id, {
          expectedStoreId: f.scope.storeId,
          commandId: crypto.randomUUID(),
          expectedRevision: card.revision,
          answer,
        });
      }
    }
    const result = await f.manager.lookup(submission.commandId);
    if (!['submitting', 'pending', 'outcome_unknown'].includes(result.phase)) return result;
    if (Date.now() > deadline) {
      const original = await f.client.getCommand(submission.commandId);
      const receipt = original.receipt as { executionId?: string };
      const execution = receipt.executionId
        ? await f.client.getExecution(receipt.executionId)
        : undefined;
      const fact =
        submission.actionId === 'mcp.source.add' || submission.actionId === 'mcp.source.remove'
          ? await f.client.queryExtension(
              's',
              'builtin.mcp.sources',
              'mcp.source.mutation.result',
              { commandId: submission.commandId },
            )
          : undefined;
      console.error(
        'native MCP original diagnostic',
        JSON.stringify({ original, execution, fact }),
      );
      throw Error(`native_mcp_settle_deadline:${JSON.stringify(result)}`);
    }
    await Bun.sleep(10);
  }
}
async function operate(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: NativeMcpOperation,
  decision?: 'approved' | 'bind' | 'revoke',
) {
  const facts = await f.manager.read();
  if (operation.kind === 'remove')
    await f.manager.removePreview(facts.observationId, operation.serverId, operation.scope);
  const submission = await f.manager.submit(facts.observationId, operation);
  return settle(f, submission, decision);
}

test('Native Main actual HTTP preserves source/selection/binding results, independent connections, immutable descriptors and cold GET-only originals', async () => {
  const f = await fixture();
  try {
    const facts = await f.manager.read();
    expect(facts.servers).toHaveLength(3);
    expect(facts.sources).toHaveLength(3);
    expect(facts.canWrite).toBe(true);
    expect(f.wire).toEqual([]);
    expect(f.credentialReads).toBe(0);
    expect(JSON.stringify(facts)).not.toContain(f.remote.url.href);
    expect(JSON.stringify(facts)).not.toContain('credential:');
    expect(JSON.stringify(facts)).not.toContain('expectedReadSet');
    const original = facts.sources.find((item) => item.name === 'original')!,
      project = facts.sources.find((item) => item.name === 'project')!,
      manual = facts.sources.find((item) => item.name === 'manual')!;
    expect(
      (await operate(f, { kind: 'select', serverId: original.id, scope: 'user', enabled: false }))
        .phase,
    ).toBe('completed');
    expect(readFileSync(f.config, 'utf8')).toContain('Native configuration comment');
    expect(
      (await operate(f, { kind: 'select', serverId: original.id, scope: 'user', enabled: true }))
        .phase,
    ).toBe('completed');
    expect((await operate(f, { kind: 'approve', serverId: project.id }, 'approved')).phase).toBe(
      'completed',
    );
    expect(
      (
        await operate(
          f,
          { kind: 'bind', serverId: manual.id, expiresAt: Date.now() + 3600000 },
          'bind',
        )
      ).phase,
    ).toBe('completed');
    expect(f.wire).toEqual([]);
    expect(f.credentialReads).toBe(0);
    expect(
      (
        await operate(f, {
          kind: 'add',
          scope: 'workspace',
          name: 'added',
          entry: { type: 'http', url: f.remote.url.href },
        })
      ).phase,
    ).toBe('completed');
    const afterAdd = await f.manager.read(),
      added = afterAdd.sources.find((item) => item.name === 'added')!;
    expect(added).toBeDefined();
    expect(
      (await operate(f, { kind: 'remove', scope: 'workspace', serverId: added.id })).phase,
    ).toBe('completed');
    expect(readFileSync(f.user, 'utf8')).toContain('Native user comment');
    expect(readFileSync(f.user, 'utf8')).toContain('"keep":true');
    const connected = await operate(f, { kind: 'connect', serverId: original.id });
    expect(connected.phase).toBe('completed');
    expect(connected.fact && 'ready' in connected.fact && connected.fact.ready?.toolCount).toBe(1);
    expect(f.wire).toEqual(['initialize', 'tools/list']);
    const catalogue = await f.manager.read();
    expect(catalogue.snapshots).toHaveLength(1);
    const tools = await f.manager.tools(
      catalogue.observationId,
      catalogue.snapshots[0]!.recordKey,
      0,
    );
    expect(tools.page.entries).toHaveLength(1);
    const readId = 'descriptor-reader',
      opened = await f.manager.descriptor(catalogue.observationId, tools.page.recordKey, 0, readId);
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = f.manager.descriptorRead(readId, offset, 65536);
      parts.push(Buffer.from(chunk.data, 'base64'));
      offset = chunk.nextOffset;
      if (chunk.eof) break;
    }
    expect(offset).toBe(opened.bodyBytes);
    expect(JSON.parse(Buffer.concat(parts).toString('utf8')).description).toBe(fullDescription);
    f.manager.descriptorClose(readId);
    expect(f.wire).toEqual(['initialize', 'tools/list']);
    const first = f.manager.descriptor(
      catalogue.observationId,
      tools.page.recordKey,
      0,
      'first-reader',
    );
    const second = f.manager.descriptor(
      catalogue.observationId,
      tools.page.recordKey,
      0,
      'second-reader',
    );
    await expect(
      f.manager.descriptor(catalogue.observationId, tools.page.recordKey, 0, 'third-reader'),
    ).rejects.toThrow('mcp_descriptor_observation_changed');
    await expect(
      f.manager.descriptor(catalogue.observationId, tools.page.recordKey, 0, 'second-reader'),
    ).rejects.toThrow('mcp_descriptor_observation_changed');
    f.manager.descriptorClose('first-reader');
    const readers = await Promise.allSettled([first, second]);
    expect(readers[0]!.status).toBe('rejected');
    expect(readers[1]!.status).toBe('fulfilled');
    expect(() => f.manager.descriptorRead('first-reader', 0, 65536)).toThrow(
      'mcp_descriptor_cursor_changed',
    );
    expect(f.manager.descriptorRead('second-reader', 0, 65536).offset).toBe(0);
    f.manager.descriptorClose('second-reader');
    const refresh = await operate(f, {
      kind: 'refresh',
      serverId: original.id,
      commandId: connected.commandId,
    });
    expect(refresh.phase).toBe('completed');
    expect(f.wire.filter((method) => method === 'initialize')).toHaveLength(1);
    expect(f.wire.filter((method) => method === 'tools/list')).toHaveLength(2);
    const reconnected = await operate(f, {
      kind: 'reconnect',
      serverId: original.id,
      commandId: connected.commandId,
    });
    expect(reconnected.phase).toBe('completed');
    expect(
      reconnected.fact && 'oldStop' in reconnected.fact && reconnected.fact.oldStop.confirmed,
    ).toBe(true);
    expect(f.wire.filter((method) => method === 'initialize')).toHaveLength(2);
    f.loseReply();
    const observed = await f.manager.read();
    const unknown = await f.manager.submit(observed.observationId, {
      kind: 'select',
      serverId: original.id,
      scope: 'workspace',
      enabled: false,
    });
    expect(unknown.phase).toBe('outcome_unknown');
    const postCount = f.posts;
    expect((await settle(f, unknown)).phase).toBe('completed');
    expect(f.posts).toBe(postCount);
    const counts = { posts: f.posts, gets: f.gets, queries: f.queries, wire: f.wire.length };
    const cold = new NativeMcpSettings(
      f.tracked,
      () => f.scope,
      () => {},
      f.data,
    );
    expect(cold.submissions).toHaveLength(f.data.mcps().length);
    expect({ posts: f.posts, gets: f.gets, queries: f.queries, wire: f.wire.length }).toEqual(
      counts,
    );
    expect((await cold.lookup(unknown.commandId)).phase).toBe('completed');
    expect(f.posts).toBe(counts.posts);
    expect(f.wire.length).toBe(counts.wire);
    const foreign = new NativeMcpSettings(
      new Proxy(f.tracked, {
        get(target, key) {
          if (key === 'serverInfo') return { ...target.serverInfo, storeId: 'foreign-store' };
          return Reflect.get(target, key);
        },
      }),
      () => ({ ...f.scope, storeId: 'foreign-store' }),
      () => {},
      f.data,
    );
    const before = f.gets,
      beforeRows = f.data.mcps();
    const rejected = await foreign.lookup(unknown.commandId);
    expect(rejected.association).toBe('unavailable');
    expect(rejected.phase).toBe('outcome_unknown');
    expect(f.gets).toBe(before);
    expect(f.posts).toBe(counts.posts);
    expect(f.data.mcps()).toEqual(beforeRows);
    const flaky = new NativeMcpSettings(
      new Proxy(f.tracked, {
        get(target, key) {
          if (key === 'getCommand')
            return async () => {
              throw Error('owned_transient_read_failure');
            };
          return Reflect.get(target, key);
        },
      }),
      () => f.scope,
      () => {},
      f.data,
    );
    expect((await flaky.lookup(unknown.commandId)).phase).toBe('outcome_unknown');
    expect(f.data.mcps()).toEqual(beforeRows);
    flaky.release();
    expect(f.authorizations).toContain('job:builtin.mcp/mcp.connect');
    expect(f.authorizations).toContain('job:mcp.source.connection');
    cold.release();
    foreign.release();
  } finally {
    await f.close();
  }
}, 90000);
