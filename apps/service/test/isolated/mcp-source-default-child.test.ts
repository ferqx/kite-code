import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { expect, test } from '#kite-test';
import { serve as fixtureServe } from '../../../../scripts/tooling/http';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { McpSelectedSourceSnapshot } from '../../src/mcp-source-configuration';

type Scenario = 'allowed' | 'deny' | 'drift' | 'cold' | 'completion' | 'followup' | 'unconnected';

test(
  'a failed child retains successful MCP metadata receipts without claiming a remote business effect',
  async () => {
    const f = await fixture('unconnected');
    try {
      await f.run();
      const carrier = (await f.store.listExecutions('parent')).find(
        (entry) => entry.childSessionId,
      )!;
      expect(carrier.status).toBe('failed');
      expect(carrier.result).toMatchObject({
        outcome: 'failed',
        content: 'child_tool_scope_exceeds_parent',
      });
      const child = await f.store.getView(carrier.childSessionId!);
      const tools = (await f.store.listExecutions(carrier.childSessionId!)).filter(
        (entry) => entry.kind === 'tool',
      );
      expect(tools.map((entry) => ({ id: entry.definitionId, status: entry.status }))).toEqual([
        { id: 'mcp.connect', status: 'succeeded' },
      ]);
      expect(f.opens).toBe(1);
      expect(f.effects).toBe(0);
      expect(carrier.result).toMatchObject({
        details: {
          evidence: {
            sessionId: carrier.childSessionId,
            runId: child.runs[0]!.id,
            reportVerification: 'not_verified',
            coverage: 'selected_history',
            tools: [{ tool: 'mcp.connect', definitionVersion: '1', outcomes: { succeeded: 1 } }],
          },
        },
      });
    } finally {
      await f.close();
    }
  },
  process.platform === 'win32' ? 150000 : 30000,
);

test(
  'idle default child follow-up keeps the exact inherited MCP source and reaches its second model/tool turn',
  async () => {
    const f = await fixture('followup');
    try {
      await f.run();
      const first = (await f.store.listExecutions('parent')).find(
        (execution) => execution.childSessionId,
      )!;
      expect(first.status).toBe('succeeded');
      const childId = first.childSessionId!;
      expect(f.effects).toBe(1);
      await f.run(15000, { commandId: 'work-followup', content: `FOLLOW_UP_CHILD:${childId}` });
      const carriers = (await f.store.listExecutions('parent')).filter(
        (execution) => execution.childSessionId,
      );
      expect(carriers).toHaveLength(2);
      expect(carriers.every((carrier) => carrier.childSessionId === childId)).toBe(true);
      expect(carriers.map((carrier) => carrier.status)).toEqual(['succeeded', 'succeeded']);
      const child = await f.store.getView(childId);
      expect(child.runs.map((run) => run.status)).toEqual(['completed', 'completed']);
      expect(f.counts.child).toBe(6);
      expect(f.effects).toBe(2);
      const second = child.runs[1]!;
      expect(second.carrierExecutionId).toBe(carriers[1]!.id);
      const origin = (await f.store.getCommand(second.originCommandId))!;
      expect(origin.kind).toBe('input.follow_up');
      const sources = (
        second.configuration as unknown as {
          snapshot: { configuration: { mcp: { sources: McpSelectedSourceSnapshot } } };
        }
      ).snapshot.configuration.mcp.sources;
      expect(sources.inheritance?.parentExecutionId).toBe(carriers[1]!.parentExecutionId!);
      expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.sourceBytes);
    } finally {
      await f.close();
    }
  },
  process.platform === 'win32' ? 150000 : 30000,
);

async function fixture(scenario: Scenario) {
  const root = realpathSync(temporaryDirectory('kite-default-child-source-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const rpc: string[] = [];
  let effects = 0,
    opens = 0;
  let followupSent = false;
  const remote = await fixtureServe({
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
  const counts = { parent: 0, child: 0 };
  let elapsedMs = 0;
  const provider = await fixtureServe({
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
      const index = counts[child ? 'child' : 'parent']++;
      providerTimeline.push({ at: Date.now(), role: child ? 'child' : 'parent', index });
      const safeId = JSON.stringify(messages).match(/mcp-[a-f0-9]{64}/)?.[0];
      let call: { name: string; input: unknown } | null = null;
      const followupTarget = /FOLLOW_UP_CHILD:([A-Za-z0-9-]+)/.exec(JSON.stringify(messages))?.[1];
      if (!child && scenario === 'followup' && followupTarget && !followupSent) {
        followupSent = true;
        call = {
          name: 'follow_up_agent',
          input: { agent_id: followupTarget, content: 'CHILD_FOLLOW_UP_REQUEST' },
        };
      } else if (!child && scenario !== 'cold' && scenario !== 'unconnected' && index === 0)
        call = { name: 'connect_mcp_server', input: { server_id: safeId } };
      else if (!child && index === (scenario === 'cold' || scenario === 'unconnected' ? 0 : 1))
        call = {
          name: 'spawn_agent',
          input: {
            prompt: 'CHILD_OWNED_REQUEST',
          },
        };
      else if (child && (index === 0 || (scenario === 'followup' && index === 3)))
        call = {
          name: 'connect_mcp_server',
          input: {
            server_id: safeId,
          },
        };
      else if (
        child &&
        (index === 1 || (scenario === 'followup' && index === 4)) &&
        scenario !== 'deny'
      ) {
        const tools = body.tools as { function: { name: string; parameters: unknown } }[];
        const tool = tools.find((tool) =>
          JSON.stringify(tool.function.parameters).includes('"const":"exact"'),
        );
        expect(tool).toBeDefined();
        call = { name: tool!.function.name, input: { value: 'exact' } };
      }
      // Current spawn is asynchronous; the ordinary event wait keeps the parent at its safe
      // result-adoption boundary without an extra Provider turn or a legacy required obligation.
      const calls = call
        ? [
            call,
            ...(scenario === 'completion' && call.name === 'spawn_agent'
              ? [
                  {
                    name: 'wait_agent_events',
                    input: { wait_ms: process.platform === 'win32' ? 180000 : 30000 },
                  },
                ]
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
        ...(scenario === 'followup' ? [{ id: 'task.follow_up', definitionVersion: '1' }] : []),
        ...(scenario === 'completion' ? [{ id: 'task.events', definitionVersion: '1' }] : []),
      ],
    }),
  );
  // Default role resolver and durable permission manager; only owned HTTP transport opt-in is supplied.
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    mcpSources: { http: { allowLoopbackForTests: true } },
    ...(scenario === 'followup'
      ? {
          afterTurn: {
            async authorize() {
              return {
                allowed: false,
                revision: 'owned-explicit-followup',
                reason: 'explicit_observation',
              };
            },
          },
        }
      : {}),
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
        request.definitionId === 'agent/general' &&
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
    async run(
      observerMs: 15000 | 30000 = scenario === 'completion' ? 30000 : 15000,
      work = { commandId: 'work', content: 'PARENT_OWNED_REQUEST' },
    ) {
      const observedAt = Date.now();
      await client.startRun('parent', {
        expectedStoreId,
        commandId: work.commandId,
        kind: 'run.start',
        content: work.content,
      });
      const approved: { definitionId: string; sessionId: string }[] = [];
      const deadline = observedAt + (process.platform === 'win32' ? observerMs * 6 : observerMs);
      for (;;) {
        const command = await runtime.getCommand(work.commandId);
        const view = await store.getView('parent');
        const rootFinished = view.runs.some(
          (run) => run.originCommandId === work.commandId && !run.isActive,
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
              : { kind: 'approval', decision: 'approve', optionId: 'once' },
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
        await sleepTimer(30);
      }
      elapsedMs = Date.now() - observedAt;
      await runtime.waitForCommand('work', { timeoutMs: 3000 });
      return approved;
    },
    async assertRecordOnlyCreation(sessionId: string) {
      const executions = await store.listExecutions(sessionId);
      const task = executions.find((execution) => execution.definitionId === 'task.spawn')!;
      const carrier = executions.find((execution) => execution.definitionId === 'agent/general')!;
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
        for (const item of snapshots) {
          const saved = item as { namespace: string; data: { gate: unknown; current: unknown } };
          if (saved.namespace === 'builtin.business.permissions') {
            expect(saved.data.gate).toMatchObject({
              namespace: 'builtin.planning',
              data: { planning: { status: 'disabled' } },
            });
          }
          const snapshot =
            saved.namespace === 'builtin.business.permissions' ? saved.data.current : saved;
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
        }
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

test(
  'default general role uses inherited raw source through real SDK policy and independently approved child Tool/Job/remote effect',
  async () => {
    const f = await fixture('allowed');
    try {
      const cards = await f.run();
      expect(f.opens).toBe(2);
      expect(f.effects).toBe(1);
      expect(cards.filter((card) => card.definitionId === 'mcp.connect')).toHaveLength(2);
      expect(cards.filter((card) => card.definitionId === 'mcp.source.connection')).toHaveLength(2);
      expect(
        cards.some((card) => ['task.spawn', 'agent/general'].includes(card.definitionId)),
      ).toBe(false);
      await f.assertRecordOnlyCreation('parent');
      const carrier = (await f.store.listExecutions('parent')).find(
        (execution) => execution.definitionId === 'agent/general',
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
  },
  process.platform === 'win32' ? 150000 : 20000,
);

test(
  'default general waits for exact completion results with original source scopes and independent MCP Tool and connection approvals',
  async () => {
    const f = await fixture('completion');
    try {
      const cards = await f.run();
      expect(f.elapsedMs).toBeLessThan(process.platform === 'win32' ? 180000 : 30000);
      expect(cards).toHaveLength(5);
      expect(
        cards.some((card) => ['task.spawn', 'agent/general'].includes(card.definitionId)),
      ).toBe(false);
      expect(f.opens).toBe(2);
      expect(f.effects).toBe(1);
      expect(f.counts).toEqual({ parent: 3, child: 3 });
      expect(f.bodies).toHaveLength(6);
      expect(cards.filter((card) => card.definitionId === 'mcp.connect')).toHaveLength(2);
      expect(cards.filter((card) => card.definitionId === 'mcp.source.connection')).toHaveLength(2);
      for (const definitionId of ['mcp.connect', 'mcp.source.connection'])
        expect(
          new Set(
            cards
              .filter((card) => card.definitionId === definitionId)
              .map((card) => card.sessionId),
          ).size,
        ).toBe(2);
      const parentExecutions = await f.store.listExecutions('parent');
      const carrier = parentExecutions.find(
        (execution) => execution.definitionId === 'agent/general',
      )!;
      const childExecutions = await f.store.listExecutions(carrier.childSessionId!);
      await f.assertRecordOnlyCreation('parent');
      expect(childExecutions.some((execution) => execution.childSessionId)).toBe(false);
      const runs = await Promise.all(
        ['parent', carrier.childSessionId!].map(async (id) => (await f.store.getView(id)).runs[0]!),
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
      const receipts = [parentExecutions].map(
        (executions) => executions.find((execution) => execution.definitionId === 'task.spawn')!,
      );
      for (const [index, executions] of [parentExecutions].entries()) {
        const wait = executions.find((execution) => execution.definitionId === 'task.events')!;
        expect(wait).toMatchObject({
          status: 'succeeded',
          input: { waitMs: process.platform === 'win32' ? 180000 : 30000 },
        });
        const final = f.providerTimeline.findIndex(
          (entry) => entry.role === (index === 0 ? 'parent' : 'child') && entry.index === 2,
        );
        expect(final).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(f.bodies[final]!.messages)).toContain('CHILD_DONE_FULL_RESULT');
      }
      expect(carrier.status).toBe('succeeded');
      for (const [index, originalCarrier] of [carrier].entries()) {
        expect(originalCarrier.delivery).toBe('consumed');
        const accepted = await f.store.getRun(originalCarrier.resultAcceptance!.runId!);
        expect(accepted!.sessionId).toBe(originalCarrier.sessionId);
        expect(accepted!.rootWorkCommandId).toBe(runs[index]!.rootWorkCommandId);
        expect(accepted!.rootWorkSeq).toBe(runs[index]!.rootWorkSeq);
        expect(originalCarrier.resultAcceptance!.runId).toBe(runs[index]!.id);
        expect(originalCarrier.resultAcceptance!.resultRevision).toBe(
          originalCarrier.resultRevision,
        );
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
        expect(run).not.toHaveProperty('waitingForResults');
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
        expect(input.prompt).toBe('CHILD_OWNED_REQUEST');
        expect(input).not.toHaveProperty('resultDisposition');
        expect(input).not.toHaveProperty('cancellation');
        const result = receipt.result as unknown as {
          details: { accepted: boolean; agent_id: string; state: string };
        };
        expect(result.details.accepted).toBe(true);
        expect(result.details.agent_id).toBe([carrier][index]!.childSessionId!);
        expect(result.details.state).toBe('queued');
        expect(result.details).not.toHaveProperty('ref');
      }
      expect(sources[1]!.inheritance!.parentSnapshot).toEqual(sources[0]!);
      expect(sources[1]!.readSet).toEqual(sources[0]!.readSet);
      for (const execution of [carrier, ...childExecutions])
        expect(execution.cancelRequestedAt).toBeNull();
      const jobs = [parentExecutions, childExecutions]
        .flat()
        .filter((execution) => execution.definitionId === 'mcp.source.connection');
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.status).toBe('running');
        expect(job.cancelRequestedAt).toBeNull();
      }
      expect(childExecutions.filter((execution) => execution.kind === 'model').at(-1)!.status).toBe(
        'succeeded',
      );
      expect(JSON.stringify(f.bodies)).not.toContain('PRIVATE_SOURCE_MARKER');
      console.error(
        'default_child_result_qualification',
        JSON.stringify({
          elapsedMs: f.elapsedMs,
          observerBudgetMs: process.platform === 'win32' ? 180000 : 30000,
          effects: f.effects,
          opens: f.opens,
          carriers: [carrier].map(
            ({ id, status, delivery, resultAcceptance, cancelRequestedAt }) => ({
              id,
              status,
              delivery,
              resultAcceptance,
              cancelRequestedAt,
            }),
          ),
          runs: runs.map(({ id, sessionId, status, deadlineAt }) => ({
            id,
            sessionId,
            status,
            deadlineAt,
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
  },
  process.platform === 'win32' ? 240000 : 35000,
);

test(
  'default child deny, captured-source drift and cold parent schema boundary preserve exact zero forbidden IO',
  async () => {
    for (const scenario of ['deny', 'drift', 'cold'] as const) {
      const f = await fixture(scenario);
      try {
        const cards = await f.run();
        expect(f.effects).toBe(0);
        expect(f.opens).toBe(1);
        const carrier = (await f.store.listExecutions('parent')).find(
          (execution) => execution.definitionId === 'agent/general',
        )!;
        const child = (await f.store.getView(carrier.childSessionId!)).runs[0]!;
        if (scenario === 'cold') {
          expect(child.status).toBe('failed');
          expect(child.reason).toBe('child_tool_scope_exceeds_parent');
        }
        if (scenario === 'deny')
          expect(
            cards.filter((card) => card.definitionId === 'mcp.source.connection'),
          ).toHaveLength(2);
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
  },
  process.platform === 'win32' ? 240000 : 40000,
);
