import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AgentState,
  assertAgentStateInvariants,
  childThreadIdForToolAttempt,
  reduceAgentState,
} from '@kite-ai/agent-kernel';
import { createCapabilitySnapshot } from '@kite-ai/builtin-runtime/skills';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
} from '@kite-ai/runtime-host/kernel-adapter';
import { delegatedToolSurface } from '../src/bootstrap/runtime/model-effect';
import {
  planChildFollowupTurn,
  verifiedTargetFollowupCatalog,
} from '../src/bootstrap/runtime/subagent/child-followup-turn';

test('fresh target grant rejects stale or changed dynamic catalog evidence', () => {
  const empty = createCapabilitySnapshot([]);
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'target-catalog',
    userId: 'user',
    workspace: '/workspace',
  });
  const state: AgentState = {
    ...initial,
    revision: 7,
    capabilities: { ...initial.capabilities, catalogRevision: empty.revision },
  };
  const proof = {
    state,
    observedTargetRevision: 7,
    mcpSnapshot: null,
    skillCatalog: null,
  };
  expect(verifiedTargetFollowupCatalog(proof)).toBe(true);
  expect(verifiedTargetFollowupCatalog({ ...proof, observedTargetRevision: 6 })).toBe(false);
  expect(
    verifiedTargetFollowupCatalog({
      ...proof,
      state: {
        ...state,
        capabilities: { ...state.capabilities, catalogRevision: 'changed-catalog' },
      },
    }),
  ).toBe(false);
  expect(
    verifiedTargetFollowupCatalog({
      ...proof,
      mcpSnapshot: { ...empty, revision: 'unverified-directory' },
    }),
  ).toBe(false);
});

test('settled child plans one fresh zero-Tool followup Run from its exact checkpoint', () => {
  const childThreadId = childThreadIdForToolAttempt({
    parentSessionId: 'parent-followup-test',
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    attempt: 1,
  });
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: childThreadId,
    userId: 'user',
    workspace: '/workspace',
  });
  const workspaceDigest = `sha256:${'a'.repeat(64)}` as const;
  const originalRef = {
    artifactId: `pa_${'b'.repeat(64)}`,
    kind: 'subagent_task' as const,
    integrityIdentifier: `sha256:${'b'.repeat(64)}`,
    byteLength: 10,
  };
  const state: AgentState = {
    ...initial,
    revision: 1,
    session: { ...initial.session, canonicalWorkspaceDigest: workspaceDigest },
    turn: { ...initial.turn, turnId: 'first-child-run', status: 'completed' as const },
    activeTaskId: null,
    tasks: {
      'first-child-task': {
        taskId: 'first-child-task',
        userGoal: 'First task',
        status: 'completed' as const,
        startedAtTurnId: 'first-child-run',
        completedAtTurnId: 'first-child-run',
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' as const },
        planHistory: [],
      },
    },
    terminalOutcome: {
      version: 1 as const,
      status: 'completed' as const,
      reasonCode: 'completed' as const,
      knownExternalEffects: 'known' as const,
      safeRetry: false,
      recoveryEntry: 'none' as const,
      pendingVerification: false,
    },
    childSessionOrigin: {
      parentSessionId: 'parent-followup-test',
      parentInvocationId: 'parent-invocation',
      parentToolCallId: 'parent-tool',
      attempt: 1,
      childInvocationId: 'first-child-task',
      grantDigest: `sha256:${'c'.repeat(64)}`,
      taskArtifactRef: originalRef,
      taskArtifactDigest: originalRef.integrityIdentifier,
      taskTextDigest: `sha256:${'d'.repeat(64)}`,
      taskInputAdmitted: true,
      role: 'code' as const,
      fundingRunId: 'parent-run',
      delegatedReservationId: 'delegated-1',
      delegatedUpperBoundDigest: `sha256:${'e'.repeat(64)}`,
      deadlineAt: '2026-09-25T00:10:00.000Z',
      terminal: {
        status: 'completed' as const,
        resultRef: originalRef,
        cleanupConfirmed: true,
        cancelRequested: false,
        terminalReceiptId: 'terminal-1',
        sealedRevision: 1,
      },
    },
  };
  const checkpointJson = JSON.stringify({
    artifactFormatVersion: 1,
    childSessionId: state.session.threadId,
    terminalRunId: state.turn.turnId,
    terminalTaskId: 'first-child-task',
    terminalRevision: 1,
    terminalStatus: 'completed',
    transcript: state.transcript,
  });
  const digest = `sha256:${createHash('sha256').update(checkpointJson).digest('hex')}`;
  const upper = createZeroResourceUsage('versioned_upper_bound', 'followup-test-v1');
  upper.counters.turns = 1;
  upper.counters.modelRequests = 1;
  upper.counters.inputTokens = 100;
  upper.counters.outputTokens = 64;
  upper.gauges.activeSubagents = 1;
  const plan = planChildFollowupTurn({
    state,
    admission: {
      sourceSessionId: 'parent-followup-test',
      targetSessionId: childThreadId,
      sourceRunId: 'parent-run',
      submissionId: 'submission-1',
      fundingRunId: 'parent-run',
      backupReservationId: `backup_${'f'.repeat(64)}`,
      deadlineAt: Date.parse('2026-09-25T00:01:00.000Z'),
      executableUpperBound: upper,
      policy: {
        phaseCeiling: 'building',
        authorizationDigest: `sha256:${'1'.repeat(64)}`,
        admissionDigest: `sha256:${'2'.repeat(64)}`,
        effectiveEffectsDigest: `sha256:${'3'.repeat(64)}`,
        capabilityDigest: 'source-catalog',
        workspaceDigest,
        policyRevision: `sha256:${'4'.repeat(64)}`,
        interactionModeRevision: 0,
        boundedContext: true,
        contextWindowTokens: 4_096,
        maxOutputTokens: 64,
        firstAttemptTimeoutMs: 10_000,
      },
    },
    sourceAdmissionRef: {
      artifactId: `pa_${'5'.repeat(64)}`,
      kind: 'agent_followup_admission',
      integrityIdentifier: `sha256:${'5'.repeat(64)}`,
      byteLength: 100,
    },
    sourceAdmissionDigest: `sha256:${'5'.repeat(64)}`,
    checkpoint: {
      ref: {
        artifactId: `pa_${digest.slice(7)}`,
        kind: 'subagent_checkpoint',
        integrityIdentifier: digest,
        byteLength: Buffer.byteLength(checkpointJson, 'utf8'),
      },
      canonicalJson: checkpointJson,
      terminalRevision: 1,
    },
    nowMs: Date.parse('2026-09-25T00:00:00.000Z'),
    targetPolicy: {
      workspaceDigest,
      interactionModeRevision: state.interactionModeRevision,
      capabilityDigest: state.capabilities.catalogRevision,
      phaseCeiling: 'building',
    },
  });
  expect(plan.events.map((event) => event.type)).toEqual([
    'agent.followup_turn_prepared',
    'resource_budget.configured',
    'task.started',
    'turn.started',
  ]);
  expect(plan.budget).toMatchObject({
    maxTurns: 1,
    maxModelRequests: 1,
    maxToolInvocations: 0,
    maxArtifactBytes: 0,
    maxConcurrentSubagents: 0,
    maxConcurrentWriters: 0,
    maxConcurrentToolInvocations: 0,
    maxConcurrentShellInvocations: 0,
  });
  expect(JSON.parse(plan.mutation.grant.canonicalJson)).toMatchObject({
    denyTools: true,
    allowedTools: [],
    firstAttemptTimeoutMs: 10_000,
  });
  const projected = plan.events.reduce<AgentState>(
    (current, event) => reduceAgentState(current, event),
    state,
  );
  assertAgentStateInvariants(projected);
  expect(projected.activeFollowupTurn?.submissionId).toBe('submission-1');
  expect(projected.childSessionOrigin?.terminal).toEqual(state.childSessionOrigin?.terminal);
  expect(projected.transcript.messages).toEqual(state.transcript.messages);
  expect(
    Object.keys(
      delegatedToolSurface({ shell_execute: {}, read_file: {} }, projected, {
        grantDigest: plan.mutation.grantDigest,
        role: 'code',
        allowedTools: [],
        denyTools: true,
      }),
    ),
  ).toEqual([]);
  expect(() =>
    delegatedToolSurface({ shell_execute: {} }, projected, {
      grantDigest: plan.mutation.grantDigest,
      role: 'code',
      allowedTools: [],
    }),
  ).toThrow('deny every Tool');

  const independentUpper = createZeroResourceUsage('versioned_upper_bound', 'followup-test-v2');
  independentUpper.counters.turns = 1;
  independentUpper.counters.modelRequests = 12;
  independentUpper.counters.inputTokens = 20_000;
  independentUpper.counters.outputTokens = 8_000;
  independentUpper.counters.artifactBytes = 10_000;
  independentUpper.gauges.elapsedRunMs = 30 * 60_000;
  independentUpper.gauges.activeSubagents = 1;
  independentUpper.gauges.activeWriters = 1;
  independentUpper.gauges.activeToolInvocations = 1;
  independentUpper.gauges.activeShellInvocations = 1;
  independentUpper.unboundedToolInvocations = true;
  independentUpper.independentFollowupTurn = true;
  const startedAt = Date.parse('2026-09-25T01:00:00.000Z');
  const independent = planChildFollowupTurn({
    state,
    admission: {
      sourceSessionId: 'parent-followup-test',
      targetSessionId: childThreadId,
      sourceRunId: 'parent-run',
      submissionId: 'submission-v2',
      fundingRunId: 'parent-run',
      backupReservationId: `backup_${'f'.repeat(64)}`,
      deadlineAt: Date.parse('2026-09-25T00:01:00.000Z'),
      executableUpperBound: independentUpper,
      policy: {
        phaseCeiling: 'building',
        authorizationDigest: `sha256:${'1'.repeat(64)}`,
        admissionDigest: `sha256:${'2'.repeat(64)}`,
        effectiveEffectsDigest: `sha256:${'3'.repeat(64)}`,
        capabilityDigest: 'source-catalog',
        workspaceDigest,
        policyRevision: `sha256:${'4'.repeat(64)}`,
        interactionModeRevision: 0,
        boundedContext: true,
        contextWindowTokens: 4_096,
        maxOutputTokens: 64,
        firstAttemptTimeoutMs: 10_000,
        executionMode: 'independent_turn_v2',
        targetRole: 'code',
        targetGrantDigest: state.childSessionOrigin!.grantDigest,
      },
    },
    sourceAdmissionRef: {
      artifactId: `pa_${'5'.repeat(64)}`,
      kind: 'agent_followup_admission',
      integrityIdentifier: `sha256:${'5'.repeat(64)}`,
      byteLength: 100,
    },
    sourceAdmissionDigest: `sha256:${'5'.repeat(64)}`,
    checkpoint: {
      ref: {
        artifactId: `pa_${digest.slice(7)}`,
        kind: 'subagent_checkpoint',
        integrityIdentifier: digest,
        byteLength: Buffer.byteLength(checkpointJson, 'utf8'),
      },
      canonicalJson: checkpointJson,
      terminalRevision: 1,
    },
    nowMs: startedAt,
    allowedTools: ['read_file', 'shell_execute'],
    targetPolicy: {
      workspaceDigest,
      interactionModeRevision: state.interactionModeRevision,
      capabilityDigest: state.capabilities.catalogRevision,
      phaseCeiling: 'building',
    },
  });
  expect(Date.parse(independent.deadlineAt) - startedAt).toBe(30 * 60_000);
  expect(independent.budget).toMatchObject({
    maxModelRequests: 12,
    maxToolInvocations: 0,
    unboundedToolInvocations: true,
    maxConcurrentToolInvocations: Number.MAX_SAFE_INTEGER,
    maxConcurrentShellInvocations: Number.MAX_SAFE_INTEGER,
  });
  expect(JSON.parse(independent.mutation.grant.canonicalJson)).toMatchObject({
    schema: 'kite.child-followup-grant.v2',
    denyTools: false,
    allowedTools: ['read_file', 'shell_execute'],
  });
  const independentState = independent.events.reduce<AgentState>(
    (current, event) => reduceAgentState(current, event),
    state,
  );
  assertAgentStateInvariants(independentState);
  expect(
    Object.keys(
      delegatedToolSurface({ task: {}, read_file: {}, shell_execute: {} }, independentState, {
        grantDigest: independent.mutation.grantDigest,
        role: 'code',
        allowedTools: ['read_file', 'shell_execute'],
      }),
    ),
  ).toEqual(['read_file', 'shell_execute']);
});
