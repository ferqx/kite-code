import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { deriveMcpSourceReadSet, readMcpSources } from '@kite-ai/agent/config';
import type { Extension, Json, OperationRef } from '@kite-ai/agent/extensions';
import { createMcpLifecycle } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { InteractionRecord } from '@kite-ai/agent/storage';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import {
  createMcpSourceConfiguration,
  type McpSelectedSourceSnapshot,
} from '../../src/mcp-source-configuration';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
async function fixture(
  cold = false,
  drift = false,
  permission: 'allow' | 'ask' | 'deny' | 'deny_job' = 'allow',
  zero = false,
) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-delegated-source-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let effects = 0,
    opens = 0;
  const wire: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      wire.push(rpc.method);
      let result: unknown;
      if (rpc.method === 'initialize') {
        opens++;
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'owned', version: '1' },
          capabilities: { tools: {} },
        };
      } else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'effect',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          ],
        };
      else {
        expect(rpc.method).toBe('tools/call');
        effects++;
        result = { content: [{ type: 'text', text: 'actual child effect' }] };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  writeFileSync(
    sourcePath,
    JSON.stringify({
      mcpServers: { same: { type: 'http', url: server.url.href, auth: { type: 'none' } } },
    }),
  );
  let runtime!: ReturnType<typeof createRuntime>;
  const sources = createMcpSourceConfiguration({
    profile,
    runtime: () => runtime,
    credentialVault: {
      async resolve() {
        throw Error('unexpected_vault');
      },
    },
    http: { allowLoopbackForTests: true },
  });
  const lifecycle = createMcpLifecycle({ servers: [], scopedSources: sources.sourcePort });
  let id = '',
    ref: OperationRef | undefined,
    original: McpSelectedSourceSnapshot | undefined;
  let childTemplate: RunConfiguration | undefined;
  const sourceFailures: string[] = [];
  let child = createFixedModel([]),
    parent = createFixedModel([]);
  const delegate: Extension = {
    id: 'owned.delegate',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'owned.delegate',
        version: '1',
        description: 'Owned actual child carrier',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          ref = await context.operations.ensure({
            key: 'child',
            request: {
              kind: 'agent',
              configurationId: 'child',
              input: { content: 'actual child' },
            },
          });
          const result = await context.operations.wait(ref, {
            signal: context.signal,
            timeoutMs: 5000,
          });
          return {
            outcome: result.status === 'succeeded' ? 'succeeded' : 'failed',
            content: JSON.stringify(result.result),
          };
        },
      },
    ],
  };
  const extensions = [sources.extension, lifecycle.extension, delegate];
  const step = async (input: Parameters<typeof lifecycle.readStepCapabilities>[0]) => {
    const dynamic = await lifecycle.readStepCapabilities(input);
    return {
      extensions: dynamic.extensions,
      toolIds: ['mcp.connect', 'mcp.sources.list', 'owned.delegate', ...dynamic.toolIds],
      snapshot: dynamic.snapshot,
    };
  };
  runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    extensions,
    permissions: {
      async authorize(request) {
        if (
          request.sessionId !== 'parent' &&
          ['mcp.connect', 'mcp.source.connection'].includes(request.definitionId) &&
          permission !== 'allow' &&
          (permission !== 'deny_job' || request.definitionId === 'mcp.source.connection')
        )
          return permission === 'deny' || permission === 'deny_job'
            ? { allowed: false, revision: 'independent-child-deny', reason: 'child_source_denied' }
            : {
                allowed: false,
                revision: 'independent-child-ask',
                approval: { request: { effect: 'external' }, grants: ['approve_once'] },
              };
        return { allowed: true, revision: 'owned' };
      },
    },
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        snapshot: {},
        toolIds: ['mcp.connect', 'mcp.sources.list'],
      },
    ],
    async resolveRunConfiguration(input) {
      if (input.session.id === 'unrelated') return childTemplate!;
      const selected = sources.select(await sources.capture(input), {
        present: false,
        configurations: [],
      });
      original = selected.snapshot;
      id = selected.servers[0]!.id;
      const remote = `mcp.${id}.${createHash('sha256').update(JSON.stringify('effect')).digest('hex').slice(0, 32)}`;
      parent = createFixedModel([
        ...(cold ? [] : [call('mcp.connect', { serverId: id, key: 'parent' })]),
        call('owned.delegate', {}),
        [finish],
      ]);
      child = createFixedModel(
        zero
          ? [[finish]]
          : [
              call('mcp.connect', { serverId: id, key: 'child' }),
              call(remote, { value: 'exact' }),
              [finish],
            ],
      );
      return {
        model: parent,
        modelId: 'parent',
        snapshot: { mcp: { sources: selected.snapshot } } as unknown as Json,
        toolIds: ['mcp.connect', 'mcp.sources.list', 'owned.delegate'],
        sources: selected.sources,
        readStepCapabilities: step,
      };
    },
    async resolveChildRunConfiguration(input) {
      const selected = await sources.deriveChildSelection(input, {
        present: zero,
        configurations: [],
      });
      if (drift) writeFileSync(sourcePath, '{ changed source');
      childTemplate = {
        model: child,
        modelId: 'child',
        snapshot: { mcp: { sources: selected.snapshot } } as unknown as Json,
        toolIds: ['mcp.connect', 'mcp.sources.list'],
        sources: {
          async capture(request) {
            try {
              return await selected.sources.capture(request);
            } catch (error) {
              sourceFailures.push((error as Error).message);
              throw error;
            }
          },
        },
        readStepCapabilities: step,
        permissions: {
          async authorize(request) {
            await selected.assertExecutionScope(request);
            return { allowed: true, revision: 'child-owned' };
          },
        },
      };
      return childTemplate;
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 'parent',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'owned',
  });
  return {
    root,
    store,
    runtime,
    parent,
    child,
    wire,
    sources,
    expectedStoreId,
    sourceFailures,
    get effects() {
      return effects;
    },
    get opens() {
      return opens;
    },
    get ref() {
      return ref;
    },
    get original() {
      return original;
    },
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 'parent',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate source' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 8000 });
    },
    async submit() {
      return runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 'parent',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate source' },
      });
    },
    async unrelated() {
      const other = join(root, 'other-workspace');
      mkdirSync(other);
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w2',
        name: 'same server another Workspace',
        rootUri: `file://${other}`,
      });
      await runtime.createSession({
        expectedStoreId,
        commandId: 'create-other',
        sessionId: 'unrelated',
        workspaceId: 'w2',
        subjectId: 'owner',
        title: 'other',
      });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'other-work',
        sessionId: 'unrelated',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'wrong Workspace frozen child template' },
      });
      await runtime.waitForCommand('other-work', { timeoutMs: 5000 });
      return store.getView('unrelated');
    },
    async close() {
      await runtime.close();
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual activated child derives original source selection and opens its own connection without retagging parent', async () => {
  const f = await fixture();
  try {
    await f.run();
    expect(f.effects).toBe(1);
    expect(f.opens).toBe(2);
    const childSessionId = f.ref!.childSessionId!;
    expect(childSessionId).not.toBe('parent');
    expect((await f.store.getSession(childSessionId))!.parentSessionId).toBe('parent');
    const parentRun = (await f.store.getView('parent')).runs[0]!;
    const persisted = (await f.store.getRun(parentRun.id))!.configuration as unknown as {
      snapshot: { mcp: { sources: McpSelectedSourceSnapshot } };
    };
    expect(persisted.snapshot.mcp.sources).toEqual(f.original!);
    const execution = (await f.store.listExecutions('parent')).find(
      (execution) => execution.definitionId === 'owned.delegate',
    )!;
    const actualRun = (await f.store.getRun(parentRun.id))!;
    const session = (await f.store.getSession('parent'))!;
    const workspace = (await f.store.getWorkspace(session.workspaceId))!;
    const command = (await f.store.getCommand(execution.originCommandId))!;
    const selected = await f.sources.deriveChildSelection(
      {
        parentExecution: execution,
        parentRun: actualRun,
        parentSession: session,
        workspace,
        command,
      },
      { present: false, configurations: [] },
    );
    const wireBefore = [...f.wire];
    let rejected = '';
    try {
      await selected.assertExecutionScope({
        kind: 'tool',
        sessionId: 'parent',
        runId: actualRun.id,
        executionId: execution.id,
        definitionId: execution.definitionId,
        definitionVersion: execution.definitionVersion,
        input: execution.input,
        signal: new AbortController().signal,
      });
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected).toContain('mcp_source_scope_invalid');
    rejected = '';
    try {
      await f.sources.deriveChildSelection(
        {
          parentExecution: execution,
          parentRun: { ...actualRun, configuration: { forged: true } },
          parentSession: session,
          workspace,
          command,
        },
        { present: false, configurations: [] },
      );
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected).toContain('mcp_source_scope_invalid');
    expect(f.wire).toEqual(wireBefore);
    const noParent = await f.sources.deriveChildSelection(
      { parentExecution: execution, parentRun: null, parentSession: session, workspace, command },
      { present: false, configurations: [] },
    );
    expect(noParent.servers).toHaveLength(0);
    expect(noParent.snapshot.readSet).toBeNull();
    expect(f.wire).toEqual(wireBefore);
    const unrelated = await f.unrelated();
    expect(unrelated.runs[0]!.status).toBe('failed');
    expect(unrelated.runs[0]!.reason).toBe('execution_failed');
    expect(await f.store.listExecutions('unrelated')).toHaveLength(0);
    expect(f.sourceFailures).toContain('mcp_source_scope_invalid');
    expect(f.wire).toEqual(wireBefore);
  } finally {
    await f.close();
  }
}, 20000);

test('child connect and source Job each require an actual child approval, independently of parent allowed calls', async () => {
  const f = await fixture(false, false, 'ask');
  try {
    await f.submit();
    const approvals: string[] = [];
    for (let i = 0; i < 2; i++) {
      const deadline = Date.now() + 5000;
      let card: InteractionRecord | undefined;
      while (!card) {
        card = (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 'parent',
            state: 'pending',
          })
        ).interactions[0];
        if (Date.now() > deadline) throw Error('child_approval_deadline');
        if (!card) await Bun.sleep(10);
      }
      expect(card.sessionId).not.toBe('parent');
      expect(f.opens).toBe(1);
      approvals.push(card.definitionId);
      await f.runtime.answerInteraction({
        expectedStoreId: f.expectedStoreId,
        commandId: `answer-${i}`,
        presentationSessionId: 'parent',
        interactionId: card.id,
        expectedRevision: card.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
    }
    await f.runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect(approvals).toEqual(['mcp.connect', 'mcp.source.connection']);
    expect(f.opens).toBe(2);
    expect(f.effects).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);

test('source drift after child template capture and independent child denial have zero additional connection or effect', async () => {
  for (const mode of ['drift', 'deny', 'deny_job'] as const) {
    const f = await fixture(false, mode === 'drift', mode === 'drift' ? 'allow' : mode);
    try {
      await f.run();
      expect(f.opens).toBe(1);
      expect(f.effects).toBe(0);
      expect(f.wire).toEqual(['initialize', 'tools/list']);
    } finally {
      await f.close();
    }
  }
}, 20000);

test('cold parent cannot expand its dynamic schema upper bound through a new child catalogue', async () => {
  const f = await fixture(true);
  try {
    await f.run();
    expect(f.opens).toBe(1);
    expect(f.effects).toBe(0);
    const childRuns = (await f.store.getView(f.ref!.childSessionId!)).runs;
    expect(childRuns[0]!.status).toBe('failed');
    expect(childRuns[0]!.reason).toBe('child_tool_scope_exceeds_parent');
  } finally {
    await f.close();
  }
}, 20000);

test('explicit zero child selection remains an ordinary child with no inherited source grant or additional connection', async () => {
  const f = await fixture(false, false, 'allow', true);
  try {
    await f.run();
    expect(f.opens).toBe(1);
    expect(f.effects).toBe(0);
    const view = await f.store.getView(f.ref!.childSessionId!);
    expect(view.runs[0]!.status).toBe('completed');
    expect(
      view.executions.filter(
        (execution) => execution.kind === 'model' && execution.status === 'succeeded',
      ),
    ).toHaveLength(1);
    expect(
      view.executions.some((execution) => execution.definitionId === 'mcp.source.connection'),
    ).toBe(false);
    const saved = (await f.store.getRun(view.runs[0]!.id))!.configuration as unknown as {
      snapshot: { mcp: { sources: McpSelectedSourceSnapshot } };
    };
    expect(saved.snapshot.mcp.sources.readSet).toBeNull();
    expect(saved.snapshot.mcp.sources.inheritance).toBeUndefined();
  } finally {
    await f.close();
  }
}, 20000);

test('strict Session derivation validates both real scopes and rejects same-name sources in another canonical Workspace or parent byte drift', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-source-derivation-'));
  const profilePath = join(root, 'profile'),
    a = join(root, 'a'),
    b = join(root, 'b');
  for (const path of [profilePath, a, b]) mkdirSync(path);
  const raw = JSON.stringify({
    mcpServers: { same: { type: 'http', url: 'https://owned.invalid', auth: { type: 'none' } } },
  });
  const path = join(profilePath, 'mcp.json');
  writeFileSync(path, raw);
  const parent = {
    profilePath,
    workspacePath: a,
    scope: { profileId: 'profile', storeId: 'store', sessionId: 'parent', workspaceId: 'a' },
  };
  const child = { ...parent, scope: { ...parent.scope, sessionId: 'actual-child' } };
  try {
    const original = readMcpSources(parent),
      frozen = JSON.stringify(original.readSet);
    const derived = deriveMcpSourceReadSet(parent, original.readSet, child);
    expect(derived.readSet.scopeDigest).not.toBe(original.readSet.scopeDigest);
    expect(JSON.stringify(original.readSet)).toBe(frozen);
    expect(() =>
      deriveMcpSourceReadSet(parent, original.readSet, {
        ...child,
        workspacePath: b,
        scope: { ...child.scope, workspaceId: 'b' },
      }),
    ).toThrow('mcp_source_scope_invalid');
    expect(() =>
      deriveMcpSourceReadSet(parent, original.readSet, { ...child, workspacePath: b }),
    ).toThrow('mcp_source_stale');
    expect(() =>
      deriveMcpSourceReadSet(
        parent,
        { ...original.readSet, scopeDigest: derived.readSet.scopeDigest },
        child,
      ),
    ).toThrow('mcp_source_stale');
    writeFileSync(path, `${raw}\n`);
    expect(() => deriveMcpSourceReadSet(parent, original.readSet, child)).toThrow(
      'mcp_source_stale',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
