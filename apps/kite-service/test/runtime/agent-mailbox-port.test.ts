import { describe, expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import type { AgentMailboxInvocationScope } from '@kite-ai/builtin-runtime/subagent';
import {
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import {
  createRootAgentMailboxPort,
  type RootFollowupPolicyEvidence,
} from '#kite-service/bootstrap/runtime/agent-mailbox-port';
import type { RuntimeAgentMailboxCommandCommitInput } from '#kite-service/bootstrap/runtime/state-runner';
import type {
  RuntimeState,
  StateRuntimeStorage,
} from '#kite-service/bootstrap/runtime/state-runtime';

function fixture(withFollowup = false) {
  const base = createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: 'a'.repeat(64),
  });
  let state = {
    ...base,
    activeTaskId: 'root-task',
    tools: {
      ...base.tools,
      calls: {
        tool1: {
          toolCallId: 'tool1',
          name: 'send_message',
          modelMessageId: 'assistant-1',
          args: {},
          modelInvocationId: 'model-1',
          createdAtTurnId: 'turn-1',
          taskId: 'root-task',
          status: 'running' as const,
        },
      },
    },
    transcript: {
      messages: [
        {
          kind: 'assistant' as const,
          messageId: 'assistant-1',
          turnId: 'turn-1',
          ordinal: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          modelInvocationId: 'model-1',
          toolCalls: [{ id: 'tool1', name: 'send_message', args: {} }],
        },
      ],
    },
  } as RuntimeState;
  if (withFollowup) {
    state = {
      ...state,
      session: { ...state.session, canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}` },
      capabilities: {
        ...state.capabilities,
        catalogRevision: 'catalog-v1',
        invocations: {
          'inv-1': {
            invocationId: 'inv-1',
            toolCallId: 'tool1',
            capabilityId: 'builtin:followup_task',
            capabilityRevision: 'capability-v1',
            argumentsDigest: 'arguments-v1',
            authorizationDigest: 'authorization-v1',
            admissionDigest: 'admission-v1',
            effectiveEffectsDigest: 'effects-v1',
            status: 'running',
            recordedAt: new Date().toISOString(),
          },
        },
      },
      resourceBudget: {
        status: 'active',
        runId: 'run-1',
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_,
        reconciledUsage: createZeroResourceUsage(),
        reservations: {},
        waiters: {},
        nextWaiterSequence: 0,
      },
    } as RuntimeState;
  }
  let runId = 'run-1';
  let unreadCount = 0;
  let sequence = 1;
  let lookup: 'missing' | 'replay' | 'digest_mismatch' = 'missing';
  let committed: RuntimeAgentMailboxCommandCommitInput | undefined;
  let commits = 0;
  let policyAvailable = true;
  let authorizeCalls = 0;
  const receipt: RuntimeStoredCommandReceipt = {
    scopeSessionId: 'session-1',
    targetSessionId: 'session-1',
    commandId: 'placeholder',
    requestDigest: 'a'.repeat(64),
    originalReceiptJson: '{}',
    committedRevision: 1,
    committedAt: 1,
  };
  const abort = new AbortController();
  const storage = {
    agentMailbox: {
      listAgents: () => [
        {
          agentId: 'child-1',
          parentAgentId: 'session-1',
          currentTaskId: 'child-task',
          currentSubmissionId: null,
          status: 'active',
          turnOrdinal: 1,
          mailRevision: sequence - 1,
          preparedThroughSequence: 0,
          unreadCount,
        },
      ],
      readAgent: (_sessionId: string, _sourceId: string, targetId: string) =>
        targetId === 'child-1'
          ? {
              agentId: 'child-1',
              parentAgentId: 'session-1',
              currentTaskId: 'child-task',
              currentSubmissionId: null,
              status: 'active' as const,
              turnOrdinal: 1,
              mailRevision: sequence - 1,
              preparedThroughSequence: 0,
              unreadCount,
            }
          : null,
      nextSequence: () => sequence,
      readActiveTaskProof: () => null,
    },
    commandReceipts: {
      lookup: () =>
        lookup === 'missing' ? { status: 'missing' as const } : { status: lookup, receipt },
    },
  } satisfies Pick<StateRuntimeStorage, 'agentMailbox' | 'commandReceipts'>;
  const port = createRootAgentMailboxPort({
    getState: () => state,
    currentRunId: () => runId,
    storage,
    toolCallId: 'tool1',
    signal: abort.signal,
    commitAgentMailboxCommand: async (value) => {
      commits++;
      committed = value;
      return receipt;
    },
    ...(withFollowup
      ? {
          authorizeFollowup: ({ state: current }: { state: Readonly<RuntimeState> }) => {
            authorizeCalls++;
            if (!policyAvailable) return null;
            return {
              phaseCeiling: 'building',
              authorizationDigest: 'authorization-v1',
              admissionDigest: 'admission-v1',
              effectiveEffectsDigest: 'effects-v1',
              capabilityDigest: 'catalog-v1',
              policyRevision: 'policy-v1',
              workspaceDigest: current.session.canonicalWorkspaceDigest!,
              interactionModeRevision: current.interactionModeRevision,
              contextWindowTokens: 1_000,
              maxOutputTokens: 100,
              firstAttemptTimeoutMs: 10_000,
              boundedContext: true,
            } satisfies RootFollowupPolicyEvidence;
          },
        }
      : {}),
  });
  if (!port) throw new Error('Expected a root Agent mailbox port.');
  const scope: AgentMailboxInvocationScope = {
    ...port.caller,
    toolCallId: 'tool1',
    effectAttemptId: 'attempt-1',
  };
  return {
    port,
    scope,
    abort,
    get committed() {
      return committed;
    },
    get commits() {
      return commits;
    },
    get authorizeCalls() {
      return authorizeCalls;
    },
    setPolicyAvailable(value: boolean) {
      policyAvailable = value;
    },
    setLookup(value: typeof lookup) {
      lookup = value;
    },
    setUnreadCount(value: number) {
      unreadCount = value;
    },
    setSequence(value: number) {
      sequence = value;
    },
    setRun(value: string) {
      runId = value;
    },
    setState(value: RuntimeState) {
      state = value;
    },
    state,
  };
}

describe('root Agent mailbox port', () => {
  test('commits TriggerTurn backup, private admission, mail and receipt as one command', async () => {
    const f = fixture(true);
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'please continue',
        mode: 'trigger_turn',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: true });
    expect(f.commits).toBe(1);
    expect(f.committed?.events.map((event) => event.type)).toEqual([
      'resource_budget.reserved',
      'agent.mail_accepted',
    ]);
    const reserved = f.committed?.events[0];
    const mail = f.committed?.events[1];
    const mutation = f.committed?.mutations[0];
    expect(reserved?.type).toBe('resource_budget.reserved');
    expect(mail?.type).toBe('agent.mail_accepted');
    expect(mutation?.kind).toBe('accept_mail');
    if (
      reserved?.type !== 'resource_budget.reserved' ||
      mail?.type !== 'agent.mail_accepted' ||
      mutation?.kind !== 'accept_mail'
    )
      throw new Error('Expected one exact TriggerTurn command.');
    const admission = mutation.followupAdmission!;
    const payload = JSON.parse(admission.canonicalJson) as Record<string, unknown>;
    expect(payload).toMatchObject({
      fundingRunId: 'run-1',
      backupReservationId: reserved.reservation.reservationId,
      deadlineAt: Date.parse((f.state.resourceBudget as { deadlineAt: string }).deadlineAt),
      executableUpperBound: reserved.reservation.executableUpperBound,
      authorization: {
        authorizationDigest: 'authorization-v1',
        admissionDigest: 'admission-v1',
        effectiveEffectsDigest: 'effects-v1',
        workspaceDigest: `sha256:${'b'.repeat(64)}`,
      },
    });
    expect(reserved.reservation.executableUpperBound).toMatchObject({
      counters: { turns: 1, modelRequests: 1, inputTokens: 1_800, outputTokens: 100 },
      gauges: { activeSubagents: 1 },
    });
    expect(mail.followupAdmissionRef).toEqual(admission.ref);
    expect(mail.followupAdmissionDigest).toBe(admission.digest);
    expect(payload.submissionId).toBe(mail.submissionId);
    expect(JSON.stringify(f.committed?.events)).not.toContain('please continue');
    expect(mutation.bodyText).toBe('please continue');
    expect(f.committed?.evidence.commandId).toBe(mail.messageId);
  });

  test('TriggerTurn receipt replay precedes policy and budget planning', async () => {
    const f = fixture(true);
    f.setLookup('replay');
    f.setPolicyAvailable(false);
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'continue',
        mode: 'trigger_turn',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: true });
    expect(f.authorizeCalls).toBe(0);
    expect(f.commits).toBe(0);
    f.setLookup('digest_mismatch');
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'different',
        mode: 'trigger_turn',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: false, code: 'identity_conflict' });
    expect(f.authorizeCalls).toBe(0);
  });

  test('TriggerTurn fails closed without policy proof or enough original deadline', async () => {
    const f = fixture(true);
    f.setPolicyAvailable(false);
    const args = {
      scope: f.scope,
      agentId: 'child-1',
      message: 'continue',
      mode: 'trigger_turn' as const,
      signal: f.abort.signal,
    };
    expect(await f.port.submitMessage(args)).toEqual({ ok: false, code: 'admission_unavailable' });
    expect(f.commits).toBe(0);
    f.setPolicyAvailable(true);
    f.setState({
      ...f.state,
      resourceBudget: {
        ...(f.state.resourceBudget as Extract<
          RuntimeState['resourceBudget'],
          { status: 'active' }
        >),
        deadlineAt: new Date(Date.now() + 20_000).toISOString(),
      },
    });
    expect(await f.port.submitMessage(args)).toEqual({ ok: false, code: 'expired' });
    expect(f.commits).toBe(0);
  });

  test('TriggerTurn rejects changed persisted authorization, exhausted and unknown funding', async () => {
    const f = fixture(true);
    const args = {
      scope: f.scope,
      agentId: 'child-1',
      message: 'continue',
      mode: 'trigger_turn' as const,
      signal: f.abort.signal,
    };
    const active = f.state.resourceBudget as Extract<
      RuntimeState['resourceBudget'],
      { status: 'active' }
    >;
    f.setState({
      ...f.state,
      capabilities: {
        ...f.state.capabilities,
        invocations: {
          ...f.state.capabilities.invocations,
          'inv-1': {
            ...f.state.capabilities.invocations['inv-1']!,
            authorizationDigest: 'changed-authorization',
          },
        },
      },
    });
    expect(await f.port.submitMessage(args)).toEqual({ ok: false, code: 'admission_unavailable' });
    f.setState({
      ...f.state,
      resourceBudget: {
        ...active,
        budget: { ...active.budget, maxRunInputTokens: 100 },
      },
    });
    expect(await f.port.submitMessage(args)).toEqual({ ok: false, code: 'budget_exhausted' });
    f.setState({
      ...f.state,
      resourceBudget: {
        ...active,
        reservations: {
          unknown: {
            version: 1,
            reservationId: 'unknown',
            runId: 'run-1',
            invocationId: 'other',
            resourceKind: 'subagent',
            executableUpperBound: createZeroResourceUsage('versioned_upper_bound', 'test-v1'),
            state: 'unknown',
          },
        },
      },
    });
    expect(await f.port.submitMessage(args)).toEqual({
      ok: false,
      code: 'reconciliation_required',
    });
    expect(f.commits).toBe(0);
  });

  test('commits only metadata event and private transaction mutation', async () => {
    const f = fixture();
    const listed = await f.port.listAgents({ scope: f.scope, signal: f.abort.signal });
    expect(listed).toEqual({
      ok: true,
      agents: [
        {
          agent_id: 'child-1',
          parent_agent_id: 'session-1',
          status: 'active',
          current_task_id: 'child-task',
          unread_count: 0,
        },
      ],
    });
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'hello',
        mode: 'queue_only',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: true });
    expect(f.commits).toBe(1);
    expect(f.committed?.events[0]?.type).toBe('agent.mail_accepted');
    expect(JSON.stringify(f.committed?.events)).not.toContain('hello');
    expect(f.committed?.mutations[0]).toMatchObject({
      kind: 'accept_mail',
      bodyText: 'hello',
      sequence: 1,
    });
    expect(f.committed?.evidence.commandId).toBe(
      (f.committed?.events[0] as { messageId: string }).messageId,
    );
  });

  test('exact receipt replay avoids a second commit; digest conflict rejects', async () => {
    const f = fixture();
    f.setLookup('replay');
    const args = {
      scope: f.scope,
      agentId: 'child-1',
      message: 'hello',
      mode: 'queue_only' as const,
      signal: f.abort.signal,
    };
    expect(await f.port.submitMessage(args)).toEqual({ ok: true });
    f.setLookup('digest_mismatch');
    expect(await f.port.submitMessage(args)).toEqual({ ok: false, code: 'identity_conflict' });
    expect(f.commits).toBe(0);
  });

  test('bounds capacity and refuses unproven controls', async () => {
    const f = fixture();
    f.setUnreadCount(8);
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'hello',
        mode: 'queue_only',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: false, code: 'capacity_exceeded' });
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'a'.repeat(4097),
        mode: 'queue_only',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: false, code: 'capacity_exceeded' });
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'hello',
        mode: 'trigger_turn',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: false, code: 'capacity_exceeded' });
    expect(
      await f.port.interruptAgent({
        scope: f.scope,
        agentId: 'child-1',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: false, code: 'admission_unavailable' });
    expect(f.commits).toBe(0);
  });

  test('rejects child scope and stale Run before storage mutation', async () => {
    const f = fixture();
    const childScope = { ...f.scope, sourceTaskId: 'child-task' };
    expect(await f.port.listAgents({ scope: childScope, signal: f.abort.signal })).toEqual({
      ok: false,
      code: 'invalid_source',
    });
    f.setRun('run-2');
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child-1',
        message: 'hello',
        mode: 'queue_only',
        signal: f.abort.signal,
      }),
    ).toEqual({ ok: false, code: 'invalid_source' });
    expect(f.commits).toBe(0);
  });

  test('wait observes metadata change and times out without private body access', async () => {
    const f = fixture();
    const waiting = f.port.waitAgent({ scope: f.scope, timeoutMs: 500, signal: f.abort.signal });
    f.setSequence(2);
    expect(await waiting).toEqual({ ok: true, timed_out: false, reason: 'mailbox_update' });
    expect(
      await f.port.waitAgent({ scope: f.scope, timeoutMs: 0, signal: f.abort.signal }),
    ).toEqual({ ok: true, timed_out: true, reason: 'timeout' });
  });
});
