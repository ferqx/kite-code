import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import { createRuntimeModuleRegistry, type RuntimeJsonValue } from '@kite-ai/runtime-spi';
import {
  type AgentMailboxPort,
  SUBAGENT_CAPABILITY_REVISIONS_,
} from '../src/subagent/runtime-module';

const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
const agentOperations = [
  'builtin:list_agents',
  'builtin:wait_agent',
  'builtin:send_message',
  'builtin:followup_task',
  'builtin:interrupt_agent',
] as const;

const caller = Object.freeze({
  sessionId: 'session-1',
  sourceAgentId: 'root-agent',
  runId: 'run-1',
  turnId: 'turn-1',
  modelInvocationId: 'model-1',
});

function execute(
  operationId: (typeof agentOperations)[number],
  input: Record<string, RuntimeJsonValue>,
  port: AgentMailboxPort | undefined,
  facts: Record<string, RuntimeJsonValue> = { toolCallId: 'tool-1' },
) {
  const executor = registry.executor(operationId);
  if (!executor) throw new Error(`${operationId} executor is missing`);
  const revision = SUBAGENT_CAPABILITY_REVISIONS_[operationId];
  return executor.execute(
    {
      invocationId: 'invocation-1',
      capabilityId: operationId,
      capabilityRevision: revision,
      input,
      facts,
    },
    {
      grant: {
        grantId: 'grant-1',
        capabilityId: operationId,
        capabilityRevision: revision,
        authority: {},
      },
      requestDigest: 'request-1',
      signal: new AbortController().signal,
      environment: {
        environmentId: 'test',
        kind: 'in_process',
        mechanisms: port ? { agentMailbox: port } : {},
      },
      attempt: { invocationId: 'invocation-1', attemptId: 'effect-attempt-1' },
    },
  );
}

function portWith(overrides: Partial<AgentMailboxPort> = {}): AgentMailboxPort {
  return {
    caller,
    listAgents: async () => ({ ok: true, agents: [] }),
    waitAgent: async () => ({ ok: true, timed_out: true, reason: 'timeout' }),
    submitMessage: async () => ({ ok: true }),
    interruptAgent: async ({ agentId }) => ({ ok: true, agent_id: agentId, status: 'idle' }),
    ...overrides,
  };
}

function value(receipt: Awaited<ReturnType<typeof execute>>): Record<string, unknown> {
  expect(receipt.status).toBe('succeeded');
  if (!receipt.value || typeof receipt.value !== 'object' || Array.isArray(receipt.value)) {
    throw new Error('Agent mailbox result value is missing');
  }
  return receipt.value as Record<string, unknown>;
}

describe('Builtin Agent mailbox tools', () => {
  test('QueueOnly context exposes list, wait, and send while hiding followup and interrupt', () => {
    const projection = createBuiltinToolCatalogProjection(registry, {
      turnContext: {
        hasTaskAdapter: true,
        featureFlags: { agentMailboxQueueOnly: true },
      },
    });
    expect(Object.keys(projection.toolSet)).toContain('send_message');
    for (const operationId of agentOperations) {
      const name = operationId.slice('builtin:'.length);
      const available =
        operationId === 'builtin:list_agents' ||
        operationId === 'builtin:wait_agent' ||
        operationId === 'builtin:send_message';
      expect(
        projection.entries.find((entry) => entry.operationId === operationId)?.availability,
      ).toBe(available ? 'available' : 'hidden');
      expect(Object.keys(projection.toolSet).includes(name)).toBe(available);
    }
  });

  test('QueueOnly remains restrictive when a general mailbox port is also present', () => {
    const projection = createBuiltinToolCatalogProjection(registry, {
      turnContext: {
        hasTaskAdapter: true,
        featureFlags: { agentMailbox: true, agentMailboxQueueOnly: true },
      },
    });
    for (const name of ['list_agents', 'wait_agent', 'send_message']) {
      expect(Object.keys(projection.toolSet)).toContain(name);
    }
    for (const name of ['followup_task', 'interrupt_agent']) {
      expect(Object.keys(projection.toolSet)).not.toContain(name);
      expect(projection.entries.find((entry) => entry.name === name)?.availability).toBe('hidden');
    }
  });

  test('hide every tool without an admitted Host mailbox surface', () => {
    const hidden = createBuiltinToolCatalogProjection(registry, {
      turnContext: { hasTaskAdapter: true },
    });
    const enabled = hidden.forTurn({
      hasTaskAdapter: true,
      featureFlags: { agentMailbox: true },
    });
    for (const operationId of agentOperations) {
      const name = operationId.slice('builtin:'.length);
      expect(hidden.entries.find((entry) => entry.operationId === operationId)?.availability).toBe(
        'hidden',
      );
      expect(Object.keys(hidden.toolSet)).not.toContain(name);
      expect(enabled.entries.find((entry) => entry.operationId === operationId)?.availability).toBe(
        'available',
      );
      expect(Object.keys(enabled.toolSet)).toContain(name);
    }
  });

  test('enforces exact Agent IDs and 4096 UTF-8 bytes before execution', () => {
    const projection = createBuiltinToolCatalogProjection(registry, {
      turnContext: { featureFlags: { agentMailbox: true } },
    });
    const send = projection.entries.find((entry) => entry.operationId === 'builtin:send_message');
    if (send?.visibility !== 'model') throw new Error('send_message is missing');
    expect(send.parseModelInput({ agent_id: 'agent-1', message: '你好' }).success).toBe(true);
    expect(send.parseModelInput({ agent_id: 'agent-1', message: '界'.repeat(1366) }).success).toBe(
      false,
    );
    expect(send.parseModelInput({ agent_id: 'bad/id', message: 'hello' }).success).toBe(false);
    expect(
      send.parseModelInput({ agent_id: 'agent-1', message: 'hello', task_id: 'old' }).success,
    ).toBe(false);
  });

  test('send and followup forward exact source attempt, preserve modes and return empty success', async () => {
    const calls: unknown[] = [];
    const port = portWith({
      submitMessage: async (input) => {
        calls.push(input);
        return { ok: true, messageId: 'private-message-id', taskId: 'do-not-disclose' };
      },
    });
    const send = value(
      await execute('builtin:send_message', { agent_id: 'child-1', message: 'Guide.' }, port),
    );
    const followup = value(
      await execute('builtin:followup_task', { agent_id: 'child-1', message: 'Continue.' }, port),
    );
    expect(calls).toMatchObject([
      {
        agentId: 'child-1',
        message: 'Guide.',
        mode: 'queue_only',
        scope: { ...caller, toolCallId: 'tool-1', effectAttemptId: 'effect-attempt-1' },
      },
      {
        agentId: 'child-1',
        message: 'Continue.',
        mode: 'trigger_turn',
        scope: { ...caller, toolCallId: 'tool-1', effectAttemptId: 'effect-attempt-1' },
      },
    ]);
    expect(send).toMatchObject({ ok: true, stdout: '', resultMeta: {} });
    expect(followup).toMatchObject({ ok: true, stdout: '', resultMeta: {} });
    expect(JSON.stringify(followup)).not.toContain('private-message-id');
    expect(JSON.stringify(followup)).not.toContain('do-not-disclose');
  });

  test('wait projects only wake reason and does not consume or disclose mailbox body', async () => {
    const calls: unknown[] = [];
    const port = portWith({
      waitAgent: async (input) => {
        calls.push(input);
        return {
          ok: true,
          timed_out: false,
          reason: 'mailbox_update',
          body: 'private body must not enter a wait receipt',
        };
      },
    });
    const result = value(await execute('builtin:wait_agent', {}, port));
    expect(JSON.parse(String(result.stdout))).toEqual({
      timed_out: false,
      reason: 'mailbox_update',
    });
    expect(calls).toMatchObject([
      { scope: { toolCallId: 'tool-1', effectAttemptId: 'effect-attempt-1' }, timeoutMs: 30_000 },
    ]);
    expect(JSON.stringify(result)).not.toContain('private body');
    const released = value(
      await execute(
        'builtin:wait_agent',
        {},
        portWith({
          waitAgent: async () => ({
            ok: true,
            timed_out: false,
            reason: 'agent_update',
            private_body: 'never disclose',
          }),
        }),
      ),
    );
    expect(JSON.parse(String(released.stdout))).toEqual({
      timed_out: false,
      reason: 'agent_update',
    });
  });

  test('list and interrupt project bounded metadata and no private body', async () => {
    const port = portWith({
      listAgents: async () => ({
        ok: true,
        agents: [
          {
            agent_id: 'child-1',
            status: 'idle',
            current_task_id: 'task-2',
            unread_count: 1,
            last_followup_status: 'failed',
            last_followup_submission_id: 'submission-1',
            last_followup_reason: 'authorization_changed',
            private_body: 'never disclose',
          },
        ],
      }),
      interruptAgent: async ({ agentId }) => ({
        ok: true,
        agent_id: agentId,
        status: 'idle',
        private_body: 'never disclose',
      }),
    });
    const list = value(await execute('builtin:list_agents', {}, port));
    const interrupt = value(
      await execute('builtin:interrupt_agent', { agent_id: 'child-1' }, port),
    );
    expect(JSON.parse(String(list.stdout))).toEqual({
      ok: true,
      agents: [
        {
          agent_id: 'child-1',
          status: 'idle',
          current_task_id: 'task-2',
          unread_count: 1,
          last_followup_status: 'failed',
          last_followup_submission_id: 'submission-1',
          last_followup_reason: 'authorization_changed',
        },
      ],
    });
    expect(JSON.parse(String(interrupt.stdout))).toEqual({
      ok: true,
      agent_id: 'child-1',
      status: 'idle',
    });
    expect(JSON.stringify([list, interrupt])).not.toContain('never disclose');
  });

  test('fails closed without a Host port or exact prepared caller identity', async () => {
    expect(
      value(
        await execute('builtin:send_message', { agent_id: 'child-1', message: 'hi' }, undefined),
      ),
    ).toMatchObject({ ok: false });
    expect(
      value(
        await execute(
          'builtin:send_message',
          { agent_id: 'child-1', message: 'hi' },
          portWith(),
          {},
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(
      value(
        await execute(
          'builtin:send_message',
          { agent_id: 'child-1', message: 'hi' },
          portWith({ caller: { ...caller, modelInvocationId: '' } }),
        ),
      ),
    ).toMatchObject({ ok: false });
  });
});
