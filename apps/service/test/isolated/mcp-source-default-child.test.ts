import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { McpSelectedSourceSnapshot } from '../../src/mcp-source-configuration';

type Scenario = 'allowed' | 'deny' | 'drift' | 'cold' | 'nested';
async function fixture(scenario: Scenario) {
  const root = realpathSync(temporaryDirectory('kite-default-child-source-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const rpc: string[] = [];
  let effects = 0,
    opens = 0;
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body = (await request.json()) as { id?: number; method: string; params?: unknown };
      if (body.id === undefined) return new Response(null, { status: 202 });
      rpc.push(body.method);
      let result: unknown;
      if (body.method === 'initialize') {
        opens++;
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'owned', version: '1' },
          capabilities: { tools: {} },
        };
      } else if (body.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'effect',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string', const: 'exact' } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          ],
        };
      else {
        expect(body.method).toBe('tools/call');
        expect(body.params).toEqual({ name: 'effect', arguments: { value: 'exact' } });
        effects++;
        result = { content: [{ type: 'text', text: 'DEFAULT_CHILD_EFFECT_ONCE' }] };
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  writeFileSync(
    sourcePath,
    JSON.stringify({
      mcpServers: {
        owned: {
          type: 'http',
          url: remote.url.href,
          auth: { type: 'none' },
          unknown: 'PRIVATE_SOURCE_MARKER',
        },
      },
    }),
  );
  const sourceBytes = readFileSync(sourcePath, 'utf8');
  const bodies: Record<string, unknown>[] = [];
  const providerTimeline: { at: number; role: string; index: number }[] = [];
  const counts = { parent: 0, child: 0, grandchild: 0 };
  let elapsedMs = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      const messages = body.messages as { role: string; content: unknown }[];
      const child = messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('CHILD_OWNED_REQUEST'),
      );
      const grandchild = messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('GRANDCHILD_OWNED_REQUEST'),
      );
      const index = counts[grandchild ? 'grandchild' : child ? 'child' : 'parent']++;
      providerTimeline.push({
        at: Date.now(),
        role: grandchild ? 'grandchild' : child ? 'child' : 'parent',
        index,
      });
      const safeId = JSON.stringify(messages).match(/mcp-[a-f0-9]{64}/)?.[0];
      let call: { name: string; input: unknown } | null = null;
      if (!child && scenario !== 'cold' && index === 0)
        call = { name: 'connect_mcp_server', input: { server_id: safeId, key: 'parent' } };
      else if (!child && index === (scenario === 'cold' ? 0 : 1))
        call = {
          name: 'spawn_agent',
          input: {
            prompt: 'CHILD_OWNED_REQUEST',
          },
        };
      else if (child && index === 0)
        call = {
          name: 'connect_mcp_server',
          input: { server_id: safeId, key: grandchild ? 'grandchild' : 'child' },
        };
      else if (child && !grandchild && index === 1 && scenario === 'nested')
        call = {
          name: 'spawn_agent',
          input: {
            prompt: 'GRANDCHILD_OWNED_REQUEST',
          },
        };
      else if (child && index === 1 && scenario !== 'deny') {
        const tools = body.tools as { function: { name: string; parameters: unknown } }[];
        const tool = tools.find((tool) =>
          JSON.stringify(tool.function.parameters).includes('"const":"exact"'),
        );
        expect(tool).toBeDefined();
        call = { name: tool!.function.name, input: { value: 'exact' } };
      }
      // Current spawn is asynchronous; the ordinary event wait keeps each parent at its safe
      // result-adoption boundary without an extra Provider turn or a legacy required obligation.
      const calls = call
        ? [
            call,
            ...(scenario === 'nested' && call.name === 'spawn_agent'
              ? [{ name: 'wait_agent_events', input: { wait_ms: 30000 } }]
              : []),
          ]
        : [];
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `fixed-${bodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: calls.map((selected, index) => ({
                  index,
                  id: `${index === 0 ? 'call' : 'wait'}-${bodies.length}`,
                  type: 'function',
                  function: { name: selected.name, arguments: JSON.stringify(selected.input) },
                })),
              }
            : { content: child ? 'CHILD_DONE_FULL_RESULT' : 'PARENT_DONE_FULL_RESULT' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [
        { id: 'task.spawn', definitionVersion: '1' },
        ...(scenario === 'nested' ? [{ id: 'task.events', definitionVersion: '1' }] : []),
      ],
    }),
  );
  // Default role resolver and durable permission manager; only owned HTTP transport opt-in is supplied.
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    mcpSources: { http: { allowLoopbackForTests: true } },
  });
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  let driftedAtAuthorization = false;
  const withDriftAtAuthorization = (base: NonNullable<typeof host.permissions>) => ({
    ...base,
    async authorize(request: Parameters<typeof base.authorize>[0]) {
      const decision = await base.authorize(request);
      // The owned source changes after the real permission decision, before Core's
      // final freshness check and adapter dispatch. No record-only human card is invented.
      if (
        scenario === 'drift' &&
        !driftedAtAuthorization &&
        decision.allowed &&
        request.kind === 'job' &&
        request.definitionId === 'agent/worker' &&
        request.definitionVersion === '1' &&
        request.sessionId === 'parent'
      ) {
        const execution = await store.getExecution(request.executionId!);
        expect(execution?.status).toBe('planned');
        expect(execution?.authorization?.dispatched).toBe(false);
        driftedAtAuthorization = true;
        writeFileSync(sourcePath, '{ changed owned source');
      }
      return decision;
    },
  });
  const resolveRun = host.resolveRunConfiguration!;
  const runtime = createRuntime({
    store,
    permissions: withDriftAtAuthorization(host.permissions!),
    extensions: host.extensions,
    supportsExtensionInputs: host.supportsExtensionInputs,
    resolveRunConfiguration: async (...args: Parameters<typeof resolveRun>) => {
      const binding = await resolveRun(...args);
      return {
        ...binding,
        permissions: withDriftAtAuthorization(binding.permissions ?? host.permissions!),
      };
    },
    resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
    childConfigurations: host.childConfigurations,
    resolveChildRunConfiguration: host.resolveChildRunConfiguration,
  });
  const permissionManagement = host.permissionManagement?.(runtime);
  const service = await startService({
    runtime,
    permissionManagement,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    subjectId: 'user',
    buildId: 'default-child-owned',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      apiMajor: 1,
      requiredCapabilities: ['commands', 'interactions', 'permission_controls'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(workspace).href,
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 'parent',
    workspaceId: 'w',
    title: 'default child',
  });
  const mode = await client.getPermissionMode('parent', { storeId: expectedStoreId });
  expect(
    (
      await client.setPermissionMode('parent', {
        expectedStoreId,
        commandId: 'ask',
        mode: 'accept_edits',
        ifRevision: mode.revision,
        makeDefault: true,
        ifDefaultRevision: mode.defaultRevision,
      })
    ).state,
  ).toBe('applied');
  const trust = await client.getWorkspaceTrust('w', { storeId: expectedStoreId });
  expect(
    (
      await client.setWorkspaceTrust('w', {
        expectedStoreId,
        commandId: 'trust',
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      })
    ).state,
  ).toBe('applied');
  return {
    root,
    client,
    runtime,
    store,
    bodies,
    providerTimeline,
    counts,
    rpc,
    sourcePath,
    sourceBytes,
    expectedStoreId,
    get opens() {
      return opens;
    },
    get effects() {
      return effects;
    },
    get elapsedMs() {
      return elapsedMs;
    },
    async run(observerMs: 15000 | 30000 = scenario === 'nested' ? 30000 : 15000) {
      const observedAt = Date.now();
      await client.startRun('parent', {
        expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: 'PARENT_OWNED_REQUEST',
      });
      const approved: { definitionId: string; sessionId: string }[] = [];
      const deadline = observedAt + observerMs;
      for (;;) {
        const command = await runtime.getCommand('work');
        const view = await store.getView('parent');
        const rootFinished = view.runs.some(
          (run) => run.originCommandId === 'work' && !run.isActive,
        );
        if (command?.status === 'rejected') break;
        const sessions = new Set(['parent']);
        let settled = true;
        for (const id of sessions) {
          const current = await client.getView(id);
          if (
            current.runs.some((run) => run.isActive) ||
            current.executions.some(
              (execution) =>
                (execution.kind !== 'job' || execution.childSessionId !== null) &&
                ['planned', 'dispatching', 'running'].includes(execution.status),
            )
          )
            settled = false;
          for (const execution of current.executions)
            if (execution.childSessionId) sessions.add(execution.childSessionId);
        }
        // Ordinary parent completion no longer implies its already accepted children settled.
        if (rootFinished && settled) break;
        let card:
          | Awaited<ReturnType<typeof client.listInteractions>>['interactions'][number]
          | undefined;
        let presentation = 'parent';
        for (const id of sessions) {
          card = (await client.listInteractions(id, { storeId: expectedStoreId, state: 'pending' }))
            .interactions[0];
          if (card) {
            presentation = card.presentationSessionId;
            break;
          }
        }
        if (card) {
          const own = (await runtime.getExecution(card.executionId))!;
          const denied =
            scenario === 'deny' &&
            own.sessionId !== 'parent' &&
            card.definitionId === 'mcp.source.connection';
          approved.push({ definitionId: card.definitionId, sessionId: own.sessionId });
          await client.answerInteraction(presentation, card.id, {
            expectedStoreId,
            commandId: `answer-${card.id}`,
            expectedRevision: card.revision,
            answer: denied
              ? { kind: 'approval', decision: 'deny' }
              : { kind: 'approval', decision: 'approve', grant: 'approve_once' },
          });
        }
        if (Date.now() > deadline) {
          for (const id of sessions) {
            console.error(
              'default_child_deadline_scope',
              JSON.stringify({
                session: id,
                runs: (await runtime.getView(id)).runs.map((run) => ({
                  id: run.id,
                  status: run.status,
                  reason: run.reason,
                })),
                executions: (await store.listExecutions(id)).map((execution) => ({
                  id: execution.id,
                  kind: execution.kind,
                  definitionId: execution.definitionId,
                  status: execution.status,
                  result: execution.result,
                })),
                interactions: (await runtime.listInteractions({ expectedStoreId, sessionId: id }))
                  .interactions,
                commands: await Promise.all(
                  (
                    await runtime.listInteractions({ expectedStoreId, sessionId: id })
                  ).interactions.map((card) => runtime.getCommand(`answer-${card.id}`)),
                ),
                accepted: await store.listAcceptedCommands(id),
                lifecycle: runtime.getLifecycleState(),
                modelRecords: (await store.listExecutions(id)).filter(
                  (execution) => execution.kind === 'model',
                ),
                originCommands: await Promise.all(
                  (await store.listExecutions(id))
                    .filter((execution) => execution.kind === 'model')
                    .map((execution) => runtime.getCommand(execution.originCommandId)),
                ),
                providerTimeline,
                counts,
              }),
            );
          }
          throw Error('default_child_deadline');
        }
        await Bun.sleep(30);
      }
      elapsedMs = Date.now() - observedAt;
      await runtime.waitForCommand('work', { timeoutMs: 3000 });
      return approved;
    },
    async assertRecordOnlyCreation(sessionId: string) {
      const executions = await store.listExecutions(sessionId);
      const task = executions.find((execution) => execution.definitionId === 'task.spawn')!;
      const carrier = executions.find((execution) => execution.definitionId === 'agent/worker')!;
      expect(task).toBeDefined();
      expect(carrier).toBeDefined();
      expect(task.id).not.toBe(carrier.id);
      expect(task.status).toBe('succeeded');
      expect(carrier.parentExecutionId).toBe(task.id);
      expect(task.runId).toBeTruthy();
      expect(carrier.runId).toBeNull();
      const work = (await runtime.getCommand('work'))!;
      for (const execution of [task, carrier]) {
        expect(execution.originStoreId).toBe(expectedStoreId);
        expect(execution.sessionId).toBe(sessionId);
        expect(execution.rootWorkCommandId).toBe('work');
        expect(execution.rootWorkSeq).toBe(work.seq);
        expect(execution.definitionVersion).toBe('1');
        expect(execution.authorization?.dispatched).toBe(true);
        const database = new Database(profile.databasePath, { readonly: true });
        let authorization: {
          revision: string;
          snapshot: {
            namespace: string;
            version: string;
            data: { policies: { scope: string; allowed: boolean; snapshot: unknown }[] };
          };
        };
        try {
          const row = database
            .query('SELECT dispatch_authorization_json FROM execution WHERE id=?')
            .get(execution.id) as { dispatch_authorization_json: string };
          authorization = JSON.parse(row.dispatch_authorization_json);
        } finally {
          database.close();
        }
        expect(authorization).toMatchObject({ allowed: true, definitionVersion: '1' });
        const snapshots =
          sessionId === 'parent'
            ? [authorization.snapshot]
            : (() => {
                expect(authorization.snapshot).toMatchObject({
                  namespace: 'agent.permission-intersection',
                  version: '1',
                });
                const policies = authorization.snapshot.data.policies;
                expect(policies.map((policy) => policy.scope)).toEqual(['parent', 'child']);
                expect(policies.every((policy) => policy.allowed === true)).toBe(true);
                return policies.map((policy) => policy.snapshot);
              })();
        for (const snapshot of snapshots)
          expect(snapshot).toMatchObject({
            namespace: 'builtin.permissions',
            version: '1',
            data: {
              mode: 'accept_edits',
              workspaceTrust: true,
              capability: {
                kind: execution.kind,
                definitionId: execution.definitionId,
                definitionVersion: '1',
                internalRecordOnly: true,
                effects: ['record_write'],
              },
            },
          });
        expect(authorization.revision.length).toBeGreaterThan(0);
        expect(execution.authorization?.human).toBeUndefined();
      }
      const accepted = JSON.parse((task.result as { content: string }).content);
      expect(accepted.accepted).toBe(true);
      expect(accepted.agent_id).toBe(carrier.childSessionId);
      expect(accepted.state).toBe('queued');
      expect(accepted.ref).toBeUndefined();
      return { task, carrier };
    },
    async close() {
      await service.close();
      provider.stop(true);
      remote.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default worker role uses inherited raw source through real SDK policy and independently approved child Tool/Job/remote effect', async () => {
  const f = await fixture('allowed');
  try {
    const cards = await f.run();
    expect(f.opens).toBe(2);
    expect(f.effects).toBe(1);
    expect(cards.filter((card) => card.definitionId === 'mcp.connect')).toHaveLength(2);
    expect(cards.filter((card) => card.definitionId === 'mcp.source.connection')).toHaveLength(2);
    expect(cards.some((card) => ['task.spawn', 'agent/worker'].includes(card.definitionId))).toBe(
      false,
    );
    await f.assertRecordOnlyCreation('parent');
    const carrier = (await f.store.listExecutions('parent')).find(
      (execution) => execution.definitionId === 'agent/worker',
    )!;
    expect(carrier.status).toBe('succeeded');
    const child = (await f.store.getView(carrier.childSessionId!)).runs[0]!;
    expect(child.status).toBe('completed');
    const parent = (await f.store.getView('parent')).runs[0]!;
    const parentSources = (
      parent.configuration as unknown as {
        snapshot: { mcp: { sources: McpSelectedSourceSnapshot } };
      }
    ).snapshot.mcp.sources;
    const childSources = (
      child.configuration as unknown as {
        snapshot: { configuration: { mcp: { sources: McpSelectedSourceSnapshot } } };
      }
    ).snapshot.configuration.mcp.sources;
    expect(childSources.inheritance!.parentSnapshot).toEqual(parentSources);
    expect(childSources.inheritance!.parentSessionId).toBe('parent');
    expect(childSources.readSet).toEqual(parentSources.readSet);
    expect(childSources.scopeDigest).toBe(parentSources.scopeDigest);
    expect(JSON.stringify(childSources)).not.toContain('PRIVATE_SOURCE_MARKER');

    const jobs = (await f.store.listExecutions(carrier.childSessionId!)).filter(
      (execution) => execution.definitionId === 'mcp.source.connection',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.originStoreId).toBe(f.expectedStoreId);
    expect(jobs[0]!.sessionId).toBe(carrier.childSessionId!);
    expect(JSON.stringify(f.bodies)).not.toContain('PRIVATE_SOURCE_MARKER');
  } catch (error) {
    console.error('default_child_failure', error, await f.store.getView('parent'), f.rpc);
    throw error;
  } finally {
    await f.close();
  }
}, 20000);

test('default nested worker waits for exact completion results with original source scopes and independent approvals within its three-level fixture budget', async () => {
  const f = await fixture('nested');
  try {
    // This observer budget is specific to three layers of durable independent Ask.
    // Two complete independent diagnostics took 16.15s/16.513s; the original
    // 15s fixture failures remain evidence, not a product deadline or performance SLA.
    const cards = await f.run();
    expect(f.elapsedMs).toBeLessThan(30000);
    expect(cards).toHaveLength(7);
    expect(cards.some((card) => ['task.spawn', 'agent/worker'].includes(card.definitionId))).toBe(
      false,
    );
    expect(f.opens).toBe(3);
    expect(f.effects).toBe(1);
    expect(f.counts).toEqual({ parent: 3, child: 3, grandchild: 3 });
    expect(f.bodies).toHaveLength(9);
    expect(cards.filter((card) => card.definitionId === 'mcp.connect')).toHaveLength(3);
    expect(cards.filter((card) => card.definitionId === 'mcp.source.connection')).toHaveLength(3);
    for (const definitionId of ['mcp.connect', 'mcp.source.connection'])
      expect(
        new Set(
          cards.filter((card) => card.definitionId === definitionId).map((card) => card.sessionId),
        ).size,
      ).toBe(3);
    const parentExecutions = await f.store.listExecutions('parent');
    const carrier = parentExecutions.find(
      (execution) => execution.definitionId === 'agent/worker',
    )!;
    const childExecutions = await f.store.listExecutions(carrier.childSessionId!);
    const nested = childExecutions.find((execution) => execution.definitionId === 'agent/worker')!;
    const grandExecutions = await f.store.listExecutions(nested.childSessionId!);
    await f.assertRecordOnlyCreation('parent');
    await f.assertRecordOnlyCreation(carrier.childSessionId!);
    const runs = await Promise.all(
      ['parent', carrier.childSessionId!, nested.childSessionId!].map(
        async (id) => (await f.store.getView(id)).runs[0]!,
      ),
    );
    const commands = await Promise.all(
      runs.map((run) => f.runtime.getCommand(run.originCommandId)),
    );
    const sources = runs.map((run, index) => {
      const snapshot = (run.configuration as { [key: string]: unknown }).snapshot as {
        [key: string]: unknown;
      };
      return (
        (index === 0 ? snapshot : snapshot.configuration) as {
          mcp: { sources: McpSelectedSourceSnapshot };
        }
      ).mcp.sources;
    });
    const receipts = [parentExecutions, childExecutions].map(
      (executions) => executions.find((execution) => execution.definitionId === 'task.spawn')!,
    );
    for (const [index, executions] of [parentExecutions, childExecutions].entries()) {
      const wait = executions.find((execution) => execution.definitionId === 'task.events')!;
      expect(wait).toMatchObject({ status: 'succeeded', input: { waitMs: 30000 } });
      const final = f.providerTimeline.findIndex(
        (entry) => entry.role === (index === 0 ? 'parent' : 'child') && entry.index === 2,
      );
      expect(final).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(f.bodies[final]!.messages)).toContain('CHILD_DONE_FULL_RESULT');
    }
    expect(carrier.status).toBe('succeeded');
    expect(nested.status).toBe('succeeded');
    for (const [index, originalCarrier] of [carrier, nested].entries()) {
      expect(originalCarrier.delivery).toBe('consumed');
      const accepted = await f.store.getRun(originalCarrier.resultAcceptance!.runId!);
      expect(accepted!.sessionId).toBe(originalCarrier.sessionId);
      expect(accepted!.rootWorkCommandId).toBe(runs[index]!.rootWorkCommandId);
      expect(accepted!.rootWorkSeq).toBe(runs[index]!.rootWorkSeq);
      expect(originalCarrier.resultAcceptance!.runId).toBe(runs[index]!.id);
      expect(originalCarrier.resultAcceptance!.resultRevision).toBe(originalCarrier.resultRevision);
      const context = await f.store.getSelectedContext({
        expectedStoreId: f.expectedStoreId,
        sessionId: originalCarrier.sessionId,
        contextSelectionId: originalCarrier.resultAcceptance!.selectionId,
      });
      expect(
        context.resultSources.find(
          (source) => source.id === originalCarrier.resultAcceptance!.sourceId,
        ),
      ).toMatchObject({
        id: originalCarrier.resultAcceptance!.sourceId,
        executionId: originalCarrier.id,
        resultRevision: originalCarrier.resultRevision,
        sessionId: originalCarrier.sessionId,
        originStoreId: f.expectedStoreId,
        createdSelectionId: originalCarrier.resultAcceptance!.selectionId,
        inclusion: 'automatic',
      });
      const acceptedModel = [parentExecutions, childExecutions]
        [index]!.filter(
          (execution) => execution.kind === 'model' && execution.runId === runs[index]!.id,
        )
        .at(-1)!;
      const prepared = await f.runtime.readModelInput({
        expectedStoreId: f.expectedStoreId,
        sessionId: originalCarrier.sessionId,
        subjectId: 'user',
        executionId: acceptedModel.id,
      });
      expect(prepared.runId).toBe(runs[index]!.id);
      const acceptedSources = prepared.request.messages.filter((message) =>
        message.sourceIds?.includes(originalCarrier.resultAcceptance!.sourceId),
      );
      expect(acceptedSources).toHaveLength(1);
      expect(acceptedSources[0]!.content).toContain('CHILD_DONE_FULL_RESULT');
    }
    expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.sourceBytes);
    for (const run of runs) {
      expect(run.status).toBe('completed');
      expect(run.isActive).toBe(false);
      expect(run.waitingForResults).toEqual([]);
    }
    expect(runs[0]!.deadlineAt).toBeNull();
    for (const run of runs.slice(1)) expect(run.deadlineAt! - run.createdAt).toBe(30 * 60 * 1000);
    for (const command of commands) {
      expect(command!.status).toBe('applied');
      expect(command!.rootWorkCommandId).toBe('work');
      expect(command!.rootWorkSeq).toBe('2');
      expect(command!.originStoreId).toBe(f.expectedStoreId);
    }
    for (const [index, receipt] of receipts.entries()) {
      expect(receipt.status).toBe('succeeded');
      const input = receipt.input as { [key: string]: unknown };
      expect(input.prompt).toBe(index === 0 ? 'CHILD_OWNED_REQUEST' : 'GRANDCHILD_OWNED_REQUEST');
      expect(input).not.toHaveProperty('resultDisposition');
      expect(input).not.toHaveProperty('cancellation');
      const result = receipt.result as unknown as {
        details: { accepted: boolean; agent_id: string; state: string };
      };
      expect(result.details.accepted).toBe(true);
      expect(result.details.agent_id).toBe([carrier, nested][index]!.childSessionId!);
      expect(result.details.state).toBe('queued');
      expect(result.details).not.toHaveProperty('ref');
    }
    expect(sources[1]!.inheritance!.parentSnapshot).toEqual(sources[0]!);
    expect(sources[2]!.inheritance!.parentSnapshot).toEqual(sources[1]!);
    expect(sources[1]!.readSet).toEqual(sources[0]!.readSet);
    expect(sources[2]!.readSet).toEqual(sources[1]!.readSet);
    for (const execution of [carrier, nested, ...grandExecutions])
      expect(execution.cancelRequestedAt).toBeNull();
    const jobs = [parentExecutions, childExecutions, grandExecutions]
      .flat()
      .filter((execution) => execution.definitionId === 'mcp.source.connection');
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job.status).toBe('running');
      expect(job.cancelRequestedAt).toBeNull();
    }
    expect(grandExecutions.filter((execution) => execution.kind === 'model').at(-1)!.status).toBe(
      'succeeded',
    );
    expect(JSON.stringify(f.bodies)).not.toContain('PRIVATE_SOURCE_MARKER');
    console.error(
      'default_nested_qualification',
      JSON.stringify({
        elapsedMs: f.elapsedMs,
        observerBudgetMs: 30000,
        effects: f.effects,
        opens: f.opens,
        carriers: [carrier, nested].map(
          ({ id, status, delivery, resultAcceptance, cancelRequestedAt }) => ({
            id,
            status,
            delivery,
            resultAcceptance,
            cancelRequestedAt,
          }),
        ),
        runs: runs.map(({ id, sessionId, status, deadlineAt, waitingForResults }) => ({
          id,
          sessionId,
          status,
          deadlineAt,
          waitingForResults,
        })),
        commands: commands.map((command) => ({
          id: command!.id,
          status: command!.status,
          receipt: command!.receipt,
        })),
      }),
    );
  } finally {
    await f.close();
  }
}, 35000);

test('default child deny, captured-source drift and cold parent schema boundary preserve exact zero forbidden IO', async () => {
  for (const scenario of ['deny', 'drift', 'cold'] as const) {
    const f = await fixture(scenario);
    try {
      const cards = await f.run();
      expect(f.effects).toBe(0);
      expect(f.opens).toBe(1);
      const carrier = (await f.store.listExecutions('parent')).find(
        (execution) => execution.definitionId === 'agent/worker',
      )!;
      const child = (await f.store.getView(carrier.childSessionId!)).runs[0]!;
      if (scenario === 'cold') {
        expect(child.status).toBe('failed');
        expect(child.reason).toBe('child_tool_scope_exceeds_parent');
      }
      if (scenario === 'deny')
        expect(cards.filter((card) => card.definitionId === 'mcp.source.connection')).toHaveLength(
          2,
        );
      if (scenario === 'drift') expect(f.counts.child).toBe(0);
    } catch (error) {
      console.error(
        'default_child_negative',
        scenario,
        error,
        await f.store.getView('parent'),
        f.rpc,
      );
      throw error;
    } finally {
      await f.close();
    }
  }
}, 40000);
