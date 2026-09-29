import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import {
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import type { PreparedToolInvocationIdentity } from '@kite-ai/runtime-spi';
import {
  type CrossSessionQueueMailPort,
  createCrossSessionRootMailboxPort,
  type RootFollowupPolicyEvidence,
} from '#kite-service/bootstrap/runtime/agent-mailbox-port';
import type { RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';
import type { AppToolPipelinePreparedRequest } from '#kite-service/bootstrap/runtime/tool-pipeline-prepared';

function fixture(bindPrepared = true) {
  const base = createInitialAgentState({
    threadId: 'parent',
    userId: 'user',
    workspace: '/workspace',
    turnId: 'turn',
    recoveryIdentityKey: 'a'.repeat(64),
  });
  const state = {
    ...base,
    session: { ...base.session, canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}` },
    tools: {
      ...base.tools,
      calls: {
        follow: {
          toolCallId: 'follow',
          name: 'followup_task',
          modelMessageId: 'assistant',
          args: {},
          modelInvocationId: 'model',
          createdAtTurnId: 'turn',
          status: 'running',
          attemptsStarted: 1,
        },
      },
    },
    transcript: {
      messages: [
        {
          kind: 'assistant',
          messageId: 'assistant',
          turnId: 'turn',
          ordinal: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          modelInvocationId: 'model',
          toolCalls: [{ id: 'follow', name: 'followup_task', args: {} }],
        },
      ],
    },
    capabilities: {
      ...base.capabilities,
      catalogRevision: 'catalog-v1',
      invocations: {
        'follow-invocation': {
          invocationId: 'follow-invocation',
          toolCallId: 'follow',
          capabilityId: 'builtin:followup_task',
          capabilityRevision: 'capability-v1',
          argumentsDigest: 'arguments-v1',
          recordedAt: new Date().toISOString(),
          status: 'running',
          authorizationDigest: 'authorization-v1',
          admissionDigest: 'admission-v1',
          effectiveEffectsDigest: 'effects-v1',
        },
      },
    },
    resourceBudget: {
      status: 'active',
      runId: 'run',
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 180_000).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_,
      reconciledUsage: createZeroResourceUsage(),
      reservations: {},
      waiters: {},
      nextWaiterSequence: 0,
    },
  } as RuntimeState;
  let receiptStatus: 'missing' | 'replay' | 'digest_mismatch' = 'missing';
  let targetParent = 'parent';
  let targetStatus: 'active' | 'completed' = 'active';
  let checkpointReady = false;
  let originRole: 'explore' | 'plan' | 'code' | 'review' | undefined = 'explore';
  let originalGrantDigest: string | undefined = `sha256:${'c'.repeat(64)}`;
  let policyAvailable = true;
  let policyRevisionOverride: string | null = null;
  let acceptCount = 0;
  let policyCalls = 0;
  const scheduled: string[] = [];
  const accepted: NonNullable<CrossSessionQueueMailPort['acceptFollowupCommand']> extends (
    input: infer Input,
  ) => Promise<void>
    ? Input[]
    : never = [];
  const storage: CrossSessionQueueMailPort = {
    readActiveChildGrant: () => null,
    readTarget: () => null,
    nextSourceSequence: () => 1,
    lookupOutbox: () => null,
    async acceptQueueMailCommand() {
      throw new Error('QueueOnly path must not run.');
    },
    async deliverQueueMail() {
      throw new Error('Target routing must not run in source acceptance.');
    },
    readFollowupTarget: (_source, target) =>
      target === 'child'
        ? {
            sessionId: 'child',
            parentSessionId: targetParent,
            status: targetStatus,
            checkpointReady,
            originRole,
            originalGrantDigest,
            observedTargetRevision: 4,
          }
        : null,
    lookupFollowupReceipt: ({ scopeSessionId, commandId, requestDigest }) => {
      if (receiptStatus === 'missing') return { status: 'missing' };
      const receipt: RuntimeStoredCommandReceipt = {
        scopeSessionId,
        commandId,
        requestDigest,
        targetSessionId: scopeSessionId,
        originalReceiptJson: '{}',
        committedRevision: 2,
        committedAt: 1,
      };
      return { status: receiptStatus, receipt };
    },
    async acceptFollowupCommand(input) {
      acceptCount++;
      accepted.push(input);
    },
  };
  const abort = new AbortController();
  const port = createCrossSessionRootMailboxPort({
    getState: () => state,
    currentRunId: () => 'run',
    storage,
    toolCallId: 'follow',
    signal: abort.signal,
    scheduleFollowup: (sourceSessionId, submissionId) => {
      if (sourceSessionId !== 'parent') throw new Error('Wrong followup source Session.');
      scheduled.push(submissionId);
    },
    authorizeFollowup: ({ state: current, preparedPolicyDigest }) => {
      policyCalls++;
      if (!policyAvailable) return null;
      return {
        phaseCeiling: 'building',
        authorizationDigest: 'authorization-v1',
        admissionDigest: 'admission-v1',
        effectiveEffectsDigest: 'effects-v1',
        capabilityDigest: 'catalog-v1',
        policyRevision: policyRevisionOverride ?? preparedPolicyDigest,
        workspaceDigest: current.session.canonicalWorkspaceDigest!,
        interactionModeRevision: current.interactionModeRevision,
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        firstAttemptTimeoutMs: 10_000,
        boundedContext: true,
      } satisfies RootFollowupPolicyEvidence;
    },
  });
  if (!port) throw new Error('Expected a bound source Tool.');
  const preparedIdentity = {
    invocationId: 'follow-invocation',
    attemptId: 'follow-invocation:attempt:1',
    toolCallId: 'follow',
    turnId: 'turn',
    modelMessageId: 'assistant',
    isDynamicMcp: false,
    operationId: 'builtin:followup_task',
    exposedToolName: 'followup_task',
    capabilityId: 'builtin:followup_task',
    capabilityRevision: 'capability-v1',
    policyDigest: 'prepared-policy-v1',
    authorizationDigest: 'authorization-v1',
    admissionDigest: 'admission-v1',
    effectiveEffectsDigest: 'effects-v1',
    argumentsDigest: 'arguments-v1',
    schemaDigest: 'schema-v1',
    bindingId: null,
  } as PreparedToolInvocationIdentity;
  const preparedRequest = {
    schema: 'kite.tool-pipeline-prepared-request.v1',
    authorizationKind: 'policy_allow',
    grantUsed: 'none',
    interactionMode: 'accept_edits',
    sandboxScope: null,
    policyEffects: {},
    effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
    receiptRequirement: 'control_receipt',
    retryEligibility: 'none',
    taskId: null,
    planId: null,
    planStepId: null,
    capabilityRequestFacts: null,
  } as AppToolPipelinePreparedRequest;
  if (
    bindPrepared &&
    !port.bindPreparedFollowupAuthority({ identity: preparedIdentity, request: preparedRequest })
  )
    throw new Error('Expected a prepared followup Tool binding.');
  const request = {
    scope: { ...port.caller, toolCallId: 'follow', effectAttemptId: 'follow-invocation:attempt:1' },
    agentId: 'child',
    message: 'Resume this child.',
    mode: 'trigger_turn' as const,
    signal: abort.signal,
  };
  return {
    port,
    request,
    accepted,
    scheduled,
    state,
    preparedIdentity,
    preparedRequest,
    get acceptCount() {
      return acceptCount;
    },
    get policyCalls() {
      return policyCalls;
    },
    setReceipt(value: typeof receiptStatus) {
      receiptStatus = value;
    },
    setTargetParent(value: string) {
      targetParent = value;
    },
    setTargetStatus(value: typeof targetStatus) {
      targetStatus = value;
    },
    setPolicyAvailable(value: boolean) {
      policyAvailable = value;
    },
    setPolicyRevisionOverride(value: string | null) {
      policyRevisionOverride = value;
    },
    setCheckpointReady(value: boolean) {
      checkpointReady = value;
    },
    setOriginProof(role: typeof originRole, grantDigest: string | undefined) {
      originRole = role;
      originalGrantDigest = grantDigest;
    },
  };
}

test('source TriggerTurn seals a full independent child turn from trusted origin proof', async () => {
  const f = fixture();
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: true });
  expect(f.acceptCount).toBe(1);
  expect(f.scheduled).toEqual([f.accepted[0]!.intent.submissionId]);
  const accepted = f.accepted[0]!;
  expect(accepted.event.mode).toBe('trigger_turn');
  expect(accepted.event.submissionId).toBe(accepted.intent.submissionId);
  expect(accepted.reservationEvent.reservation).toMatchObject({
    runId: 'run',
    invocationId: accepted.intent.submissionId,
    resourceKind: 'subagent',
    state: 'queued',
  });
  expect(accepted.reservationEvent.reservation.executableUpperBound.counters).toMatchObject({
    turns: 0,
    modelRequests: 0,
    toolInvocations: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  expect(accepted.reservationEvent.reservation.executableUpperBound).toMatchObject({
    unboundedToolInvocations: true,
    independentFollowupTurn: true,
    durationOnlyChildRun: true,
    gauges: { elapsedRunMs: 30 * 60_000, activeWriters: 0 },
  });
  expect(accepted.receipt).toMatchObject({
    scopeSessionId: 'parent',
    targetSessionId: 'parent',
    commandId: accepted.event.messageId,
  });
  const admission = accepted.intent.admission;
  expect(admission.digest).toBe(
    `sha256:${createHash('sha256').update(admission.canonicalJson).digest('hex')}`,
  );
  expect(JSON.parse(admission.canonicalJson)).toMatchObject({
    schema: 'kite.cross-session-followup-admission.v2',
    sourceSessionId: 'parent',
    targetSessionId: 'child',
    sourceRunId: 'run',
    bodyDigest: accepted.event.bodyDigest,
    source: { effectAttemptId: 'follow-invocation:attempt:1', toolCallId: 'follow' },
    policy: {
      authorizationDigest: 'authorization-v1',
      boundedContext: true,
      executionMode: 'independent_turn_v2',
      targetRole: 'explore',
      targetGrantDigest: `sha256:${'c'.repeat(64)}`,
    },
    preparedTool: {
      invocationId: 'follow-invocation',
      operationId: 'builtin:followup_task',
      toolCallId: 'follow',
      argumentsDigest: 'arguments-v1',
      schemaDigest: 'schema-v1',
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
      effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
    },
  });
  expect(JSON.parse(admission.canonicalJson).policy.preparedTool).toBeUndefined();
  expect(JSON.stringify(accepted.event)).not.toContain('Resume this child.');
  expect(accepted.intent.bodyText).toBe('Resume this child.');
});

test('source TriggerTurn refuses missing persisted target origin proof', async () => {
  const f = fixture();
  f.setOriginProof(undefined, undefined);
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: false, code: 'target_unavailable' });
  expect(f.acceptCount).toBe(0);
});

test('source TriggerTurn keeps the code role without reserving a writer slot', async () => {
  const f = fixture();
  f.setOriginProof('code', `sha256:${'d'.repeat(64)}`);
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: true });
  const accepted = f.accepted[0]!;
  expect(accepted.reservationEvent.reservation.executableUpperBound.gauges.activeWriters).toBe(0);
  expect(JSON.parse(accepted.intent.admission.canonicalJson).policy).toMatchObject({
    targetRole: 'code',
    targetGrantDigest: `sha256:${'d'.repeat(64)}`,
  });
});

test('source receipt replay precedes policy and budget planning; conflicts fail closed', async () => {
  const f = fixture();
  f.setReceipt('replay');
  f.setPolicyAvailable(false);
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: true });
  expect(f.policyCalls).toBe(0);
  expect(f.acceptCount).toBe(0);
  expect(f.scheduled).toHaveLength(1);
  f.setReceipt('digest_mismatch');
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: false, code: 'identity_conflict' });
  expect(f.acceptCount).toBe(0);
});

test('source TriggerTurn rejects foreign or checkpointless targets and missing policy', async () => {
  const f = fixture();
  f.setTargetParent('foreign');
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: false, code: 'agent_not_found' });
  f.setTargetParent('parent');
  f.setTargetStatus('completed');
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: false, code: 'target_unavailable' });
  f.setCheckpointReady(true);
  f.setPolicyAvailable(false);
  expect(await f.port.submitMessage(f.request)).toEqual({
    ok: false,
    code: 'admission_unavailable',
  });
  expect(f.acceptCount).toBe(0);
});

test('source followup requires one exact prepared Tool policy binding', async () => {
  const f = fixture(false);
  expect(await f.port.submitMessage(f.request)).toEqual({
    ok: false,
    code: 'admission_unavailable',
  });
  expect(f.policyCalls).toBe(0);
  expect(
    f.port.bindPreparedFollowupAuthority({
      identity: { ...f.preparedIdentity, toolCallId: 'different' },
      request: f.preparedRequest,
    }),
  ).toBe(false);
  expect(
    f.port.bindPreparedFollowupAuthority({
      identity: { ...f.preparedIdentity, attemptId: 'different:attempt:1' },
      request: f.preparedRequest,
    }),
  ).toBe(false);
  expect(
    f.port.bindPreparedFollowupAuthority({
      identity: f.preparedIdentity,
      request: { ...f.preparedRequest, interactionMode: 'auto' },
    }),
  ).toBe(false);
  expect(
    f.port.bindPreparedFollowupAuthority({
      identity: f.preparedIdentity,
      request: f.preparedRequest,
    }),
  ).toBe(true);
  expect(
    f.port.bindPreparedFollowupAuthority({
      identity: f.preparedIdentity,
      request: f.preparedRequest,
    }),
  ).toBe(false);
  expect(
    await f.port.submitMessage({
      ...f.request,
      scope: { ...f.request.scope, effectAttemptId: 'follow-invocation:attempt:2' },
    }),
  ).toEqual({ ok: false, code: 'admission_unavailable' });
  expect(await f.port.submitMessage(f.request)).toEqual({ ok: true });
  expect(f.acceptCount).toBe(1);
  expect(JSON.parse(f.accepted[0]!.intent.admission.canonicalJson).policy.policyRevision).toBe(
    'prepared-policy-v1',
  );
});

test('source followup rejects a policy proof that does not match prepared governance', async () => {
  const f = fixture();
  f.setPolicyRevisionOverride('different-policy');
  expect(await f.port.submitMessage(f.request)).toEqual({
    ok: false,
    code: 'admission_unavailable',
  });
  expect(f.acceptCount).toBe(0);
});
