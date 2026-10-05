import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { McpSelectedSourceSnapshot } from '../../src/mcp-source-configuration';

type Scenario = 'allowed' | 'deny' | 'drift' | 'cold' | 'nested';
async function fixture(scenario: Scenario) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-default-child-source-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
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
        call = { name: 'mcp.connect', input: { serverId: safeId, key: 'parent' } };
      else if (!child && index === (scenario === 'cold' ? 0 : 1))
        call = {
          name: 'task',
          input: {
            key: 'owned-child',
            role: 'worker',
            input: { content: 'CHILD_OWNED_REQUEST' },
            cancellation: 'attached',
            resultDisposition: 'required',
          },
        };
      else if (child && index === 0)
        call = {
          name: 'mcp.connect',
          input: { serverId: safeId, key: grandchild ? 'grandchild' : 'child' },
        };
      else if (child && !grandchild && index === 1 && scenario === 'nested')
        call = {
          name: 'task',
          input: {
            key: 'owned-grandchild',
            role: 'worker',
            input: { content: 'GRANDCHILD_OWNED_REQUEST' },
            cancellation: 'attached',
            resultDisposition: 'required',
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
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `fixed-${bodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${bodies.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
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
      tools: [{ id: 'task', definitionVersion: '1' }],
    }),
  );
  // Default role resolver and durable permission manager; only owned HTTP transport opt-in is supplied.
  const host = createDefaultProcessConfiguration({
    profile,
    mcpSources: { http: { allowLoopbackForTests: true } },
  });
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    extensions: host.extensions,
    supportsExtensionInputs: host.supportsExtensionInputs,
    resolveRunConfiguration: host.resolveRunConfiguration,
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
    rootUri: `file://${workspace}`,
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
        mode: 'ask',
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
        if (
          view.runs.some((run) => run.originCommandId === 'work' && !run.isActive) ||
          command?.status === 'rejected'
        )
          break;
        const sessions = new Set(['parent']);
        for (const id of sessions) {
          for (const execution of (await client.getView(id)).executions)
            if (execution.childSessionId) sessions.add(execution.childSessionId);
        }
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
          if (scenario === 'drift' && card.definitionId === 'agent/worker')
            writeFileSync(sourcePath, '{ changed owned source');
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
    expect(cards.some((card) => card.definitionId === 'task')).toBe(true);
    expect(cards.some((card) => card.definitionId === 'agent/worker')).toBe(true);
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

test('default nested worker completes required results with original source scopes and independent approvals within its three-level fixture budget', async () => {
  const f = await fixture('nested');
  try {
    // This observer budget is specific to three layers of durable independent Ask.
    // Two complete independent diagnostics took 16.15s/16.513s; the original
    // 15s fixture failures remain evidence, not a product deadline or performance SLA.
    const cards = await f.run();
    expect(f.elapsedMs).toBeLessThan(30000);
    expect(cards).toHaveLength(11);
    expect(f.opens).toBe(3);
    expect(f.effects).toBe(1);
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
      (executions) => executions.find((execution) => execution.definitionId === 'task')!,
    );
    expect(carrier.status).toBe('succeeded');
    expect(nested.status).toBe('succeeded');
    for (const [index, originalCarrier] of [carrier, nested].entries()) {
      expect(originalCarrier.delivery).toBe('consumed');
      expect(originalCarrier.resultAcceptance!.runId).toBe(runs[index]!.id);
      expect(originalCarrier.resultAcceptance!.resultRevision).toBe(originalCarrier.resultRevision);
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
      expect(input.resultDisposition).toBe('required');
      expect(input.cancellation).toBe('attached');
      const result = receipt.result as unknown as {
        details: { ref: { executionId: string; childSessionId: string; originStoreId: string } };
      };
      expect(result.details.ref.executionId).toBe([carrier, nested][index]!.id);
      expect(result.details.ref.childSessionId).toBe([carrier, nested][index]!.childSessionId!);
      expect(result.details.ref.originStoreId).toBe(f.expectedStoreId);
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
