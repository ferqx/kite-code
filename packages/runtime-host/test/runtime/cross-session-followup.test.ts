import { describe, expect, test } from 'bun:test';
import { type AgentState, createInitialAgentState } from '@kite-ai/agent-kernel';
import { getAgentPhase } from '@kite-ai/runtime-contract';
import {
  planCrossSessionFirstModelReplacement,
  planCrossSessionFollowupSlotAcquisition,
  planCrossSessionIndependentTurnActivation,
  planCrossSessionTriggerTurnBackup,
} from '../../src/kernel-adapter/cross-session-followup';
import { getActivePlanning } from '../../src/kernel-adapter/initial';
import {
  committedResourceUsage,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
  reduceResourceBudgetState,
} from '../../src/kernel-adapter/resource-budget';

const startedAt = '2026-09-25T00:00:00.000Z';
const deadlineAt = '2026-09-25T00:03:00.000Z';
const nowMs = Date.parse('2026-09-25T00:00:10.000Z');

function initial(threadId: string) {
  return createInitialAgentState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId,
    userId: 'user',
    workspace: '/workspace',
    turnId: 'turn',
    canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}`,
  });
}

function source() {
  const state = initial('source');
  return {
    ...state,
    resourceBudget: reduceResourceBudgetState(state.resourceBudget, {
      type: 'resource_budget.configured',
      runId: 'funding-run',
      startedAt,
      deadlineAt,
      budget: LIMITED_RESOURCE_BUDGET_,
    }),
  };
}

function policy(state = source()) {
  return {
    phaseCeiling: getAgentPhase(getActivePlanning(state)),
    authorizationDigest: 'authorization',
    admissionDigest: 'admission',
    effectiveEffectsDigest: 'effects',
    capabilityDigest: state.capabilities.catalogRevision,
    workspaceDigest: state.session.canonicalWorkspaceDigest ?? '',
    policyRevision: 'policy-v1',
    interactionModeRevision: state.interactionModeRevision,
    boundedContext: true as const,
    contextWindowTokens: 100,
    maxOutputTokens: 50,
    firstAttemptTimeoutMs: 30_000,
    interactionMode: state.mode,
    workspaceAccess: state.workspaceAccess,
  };
}

function backupInput() {
  const state = source();
  return {
    sourceState: state,
    trustedCurrentRunId: 'funding-run',
    sourceSessionId: 'source',
    targetSessionId: 'target',
    submissionId: 'submission',
    requestDigest: 'digest',
    receipt: { status: 'missing' as const },
    policy: policy(state),
    nowMs,
  };
}

function acquireBackup(
  budget: ReturnType<typeof source>['resourceBudget'],
  reservationEvent: Extract<
    import('@kite-ai/agent-kernel').KernelEvent,
    { type: 'resource_budget.reserved' }
  >,
) {
  const queued = reduceResourceBudgetState(budget, reservationEvent);
  return reduceResourceBudgetState(queued, {
    type: 'resource_budget.child_slot_acquired',
    reservationId: reservationEvent.reservation.reservationId,
  });
}

function accepted() {
  const input = backupInput();
  const backup = planCrossSessionTriggerTurnBackup(input);
  if (backup.status !== 'planned') throw new Error('Fixture backup was not planned.');
  return {
    backup,
    fundingState: {
      ...input.sourceState,
      resourceBudget: acquireBackup(input.sourceState.resourceBudget, backup.reservationEvent),
    },
  };
}

function replacementInput() {
  const { backup, fundingState } = accepted();
  const target = initial('target');
  const targetRunId = 'followup-run';
  const targetState = {
    ...target,
    activeFollowupTurn: {
      sourceSessionId: 'source',
      submissionId: 'submission',
      targetRunId,
      taskId: 'followup-task',
      checkpointRef: {
        artifactId: `pa_${'c'.repeat(64)}`,
        kind: 'subagent_checkpoint' as const,
        integrityIdentifier: `sha256:${'c'.repeat(64)}`,
        byteLength: 1,
      },
      grantRef: {
        artifactId: `pa_${'d'.repeat(64)}`,
        kind: 'agent_followup_grant' as const,
        integrityIdentifier: `sha256:${'d'.repeat(64)}`,
        byteLength: 1,
      },
      grantDigest: `sha256:${'d'.repeat(64)}`,
    },
    resourceBudget: reduceResourceBudgetState(target.resourceBudget, {
      type: 'resource_budget.configured',
      runId: targetRunId,
      startedAt,
      deadlineAt,
      budget: {
        ...LIMITED_RESOURCE_BUDGET_,
        maxRunInputTokens: 100,
        maxRunOutputTokens: 50,
        maxToolInvocations: 0,
        maxArtifactBytes: 0,
        maxConcurrentSubagents: 0,
        maxConcurrentWriters: 0,
        maxConcurrentToolInvocations: 0,
        maxConcurrentShellInvocations: 0,
      },
    }),
  };
  return {
    fundingState,
    targetState,
    targetPolicyProof: {
      observedTargetRevision: targetState.revision,
      grantDigest: targetState.activeFollowupTurn.grantDigest,
      capabilityDigest: targetState.capabilities.catalogRevision,
      interactionModeRevision: targetState.interactionModeRevision,
      phaseCeiling: getAgentPhase(getActivePlanning(targetState)),
      mode: targetState.mode,
      workspaceAccess: targetState.workspaceAccess,
      denyTools: true as const,
      allowedTools: [] as const,
    },
    admission: backup.admission,
    receipt: { status: 'missing' as const },
    requestDigest: 'route-digest',
    frozenSurface: {
      invocationId: 'first-model',
      artifactId: `pa_${'a'.repeat(64)}`,
      integrityIdentifier: `sha256:${'a'.repeat(64)}`,
      inputTokens: 50,
      maxOutputTokens: 50,
      verified: true as const,
    },
    currentPolicy: backup.admission.policy,
    nowMs,
  };
}

describe('pure cross-Session TriggerTurn budget admission', () => {
  test('v2 holds a full child turn and activates it after the source deadline', () => {
    const sourceState = source();
    const originalGrantDigest = `sha256:${'e'.repeat(64)}`;
    const currentPolicy = {
      ...policy(sourceState),
      executionMode: 'independent_turn_v2' as const,
      targetRole: 'explore' as const,
      targetGrantDigest: originalGrantDigest,
    };
    const planned = planCrossSessionTriggerTurnBackup({
      ...backupInput(),
      sourceState,
      policy: currentPolicy,
    });
    if (planned.status !== 'planned') throw new Error('V2 backup was not planned.');
    const upper = planned.admission.executableUpperBound;
    expect(upper).toMatchObject({
      independentFollowupTurn: true,
      unboundedToolInvocations: true,
      durationOnlyChildRun: true,
      counters: { turns: 0, modelRequests: 0, toolInvocations: 0 },
      gauges: {
        elapsedRunMs: 1_800_000,
        activeSubagents: 1,
        activeToolInvocations: 0,
        activeShellInvocations: 0,
      },
    });
    const funded = {
      ...sourceState,
      resourceBudget: acquireBackup(sourceState.resourceBudget, planned.reservationEvent),
    };
    const target = initial('target');
    const targetStartedAt = deadlineAt;
    const targetDeadlineAt = '2026-09-25T00:33:00.000Z';
    const grantDigest = `sha256:${'d'.repeat(64)}`;
    const targetState = {
      ...target,
      childSessionOrigin: {
        parentSessionId: 'source',
        role: 'explore' as const,
        grantDigest: originalGrantDigest,
      },
      activeFollowupTurn: {
        sourceSessionId: 'source',
        submissionId: 'submission',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        grantDigest,
        grantRef: {
          kind: 'agent_followup_grant' as const,
          artifactId: `pa_${'d'.repeat(64)}`,
          integrityIdentifier: grantDigest,
          byteLength: 1,
        },
      },
      resourceBudget: reduceResourceBudgetState(target.resourceBudget, {
        type: 'resource_budget.configured',
        runId: 'followup-run',
        startedAt: targetStartedAt,
        deadlineAt: targetDeadlineAt,
        budget: {
          ...LIMITED_RESOURCE_BUDGET_,
          maxRunDurationMs: 1_800_000,
          maxTurns: 0,
          maxModelRequests: upper.counters.modelRequests,
          maxToolInvocations: 0,
          unboundedToolInvocations: true,
          durationOnlyChildRun: true,
          maxRunInputTokens: upper.counters.inputTokens,
          maxRunOutputTokens: upper.counters.outputTokens,
          maxArtifactBytes: upper.counters.artifactBytes,
          maxConcurrentSubagents: 0,
          maxConcurrentWriters: 0,
          maxConcurrentToolInvocations: 1,
          maxConcurrentShellInvocations: 1,
        },
      }),
    } as unknown as AgentState;
    if (targetState.resourceBudget.status !== 'active')
      throw new Error('Target budget was not configured.');
    const activeTargetBudget = targetState.resourceBudget;
    const proof = {
      observedTargetRevision: targetState.revision,
      grantDigest,
      capabilityDigest: targetState.capabilities.catalogRevision,
      interactionModeRevision: targetState.interactionModeRevision,
      phaseCeiling: getAgentPhase(getActivePlanning(targetState)),
      mode: targetState.mode,
      workspaceAccess: targetState.workspaceAccess,
      originRole: 'explore' as const,
      denyTools: false as const,
      allowedTools: ['read_file'],
    };
    const input = {
      fundingState: funded,
      targetState,
      admission: planned.admission,
      currentPolicy,
      targetPolicyProof: proof,
      nowMs: Date.parse(targetStartedAt) + 1_000,
    };
    const activation = planCrossSessionIndependentTurnActivation(input);
    expect(activation).toEqual({
      status: 'planned',
      event: {
        type: 'resource_budget.dispatch_started',
        reservationId: planned.admission.backupReservationId,
      },
    });
    if (activation.status !== 'planned') throw new Error('V2 activation was not planned.');
    const activated = {
      ...funded,
      resourceBudget: reduceResourceBudgetState(funded.resourceBudget, activation.event),
    };
    expect(
      planCrossSessionIndependentTurnActivation({ ...input, fundingState: activated }),
    ).toEqual({ status: 'already_activated' });
    expect(() =>
      planCrossSessionIndependentTurnActivation({
        ...input,
        targetPolicyProof: { ...proof, allowedTools: ['task'] },
      }),
    ).toThrow('original child role');
    expect(() =>
      planCrossSessionIndependentTurnActivation({
        ...input,
        currentPolicy: { ...currentPolicy, targetGrantDigest: `sha256:${'f'.repeat(64)}` },
      }),
    ).toThrow('immutable policy');
    expect(() =>
      planCrossSessionIndependentTurnActivation({
        ...input,
        admission: { ...planned.admission, backupReservationId: `backup_${'f'.repeat(64)}` },
      }),
    ).toThrow('source or immutable policy');
    expect(() =>
      planCrossSessionIndependentTurnActivation({
        ...input,
        targetState: {
          ...targetState,
          resourceBudget: {
            ...activeTargetBudget,
            deadlineAt: '2026-09-25T00:33:00.001Z',
          },
        },
      }),
    ).toThrow('source envelope');

    // Persisted v2 grants created before duration-only child Runs retain their
    // finite counters and must still activate under their original authority.
    const { durationOnlyChildRun: _upperMarker, ...legacyUpperFields } = upper;
    const legacyUpper = {
      ...legacyUpperFields,
      counters: {
        ...upper.counters,
        turns: 1,
        modelRequests: 3,
        inputTokens: 500,
        outputTokens: 60,
        artifactBytes: 4096,
      },
    };
    const { durationOnlyChildRun: _budgetMarker, ...legacyBudgetFields } =
      activeTargetBudget.budget;
    const legacyFunded = {
      ...funded,
      resourceBudget: {
        ...funded.resourceBudget,
        reservations: {
          ...funded.resourceBudget.reservations,
          [planned.admission.backupReservationId]: {
            ...funded.resourceBudget.reservations[planned.admission.backupReservationId]!,
            executableUpperBound: legacyUpper,
          },
        },
      },
    } as AgentState;
    const legacyTarget = {
      ...targetState,
      resourceBudget: {
        ...activeTargetBudget,
        budget: {
          ...legacyBudgetFields,
          maxTurns: 1,
          maxModelRequests: 3,
          maxRunInputTokens: 500,
          maxRunOutputTokens: 60,
          maxArtifactBytes: 4096,
        },
      },
    } as AgentState;
    expect(
      planCrossSessionIndependentTurnActivation({
        ...input,
        fundingState: legacyFunded,
        targetState: legacyTarget,
        admission: { ...planned.admission, executableUpperBound: legacyUpper },
      }).status,
    ).toBe('planned');
  });
  test('v2 followups share subagent capacity without holding Tool or Shell slots', () => {
    const base = source();
    let fundingState = {
      ...base,
      resourceBudget: {
        ...base.resourceBudget,
        budget: {
          ...LIMITED_RESOURCE_BUDGET_,
          maxConcurrentToolInvocations: 1,
          maxConcurrentShellInvocations: 0,
        },
      },
    } as AgentState;
    for (let index = 1; index <= 2; index += 1) {
      const planned = planCrossSessionTriggerTurnBackup({
        ...backupInput(),
        sourceState: fundingState,
        targetSessionId: `target-${index}`,
        submissionId: `submission-${index}`,
        policy: {
          ...policy(fundingState),
          executionMode: 'independent_turn_v2',
          targetRole: 'explore',
          targetGrantDigest: `sha256:${'e'.repeat(64)}`,
        },
      });
      if (planned.status !== 'planned') throw new Error('V2 backup was not planned.');
      expect(planned.admission.executableUpperBound.gauges.activeToolInvocations).toBe(0);
      expect(planned.admission.executableUpperBound.gauges.activeShellInvocations).toBe(0);
      fundingState = {
        ...fundingState,
        resourceBudget: acquireBackup(fundingState.resourceBudget, planned.reservationEvent),
      };
    }
    if (fundingState.resourceBudget.status !== 'active')
      throw new Error('Funding budget was not configured.');
    expect(committedResourceUsage(fundingState.resourceBudget).gauges.activeSubagents).toBe(2);
  });

  test('v2 code followup uses only a subagent slot under the original role', () => {
    const sourceState = source();
    const planned = planCrossSessionTriggerTurnBackup({
      ...backupInput(),
      sourceState,
      policy: {
        ...policy(sourceState),
        executionMode: 'independent_turn_v2',
        targetRole: 'code',
        targetGrantDigest: `sha256:${'c'.repeat(64)}`,
      },
    });
    if (planned.status !== 'planned') throw new Error('V2 backup was not planned.');
    expect(planned.admission.executableUpperBound.gauges.activeWriters).toBe(0);
    expect(planned.admission.executableUpperBound.counters.toolInvocations).toBe(0);
    expect(planned.admission.executableUpperBound.unboundedToolInvocations).toBe(true);
  });
  test('new v2 followup can acquire its own slot after an unrelated reservation became unknown', () => {
    const base = source();
    const unrelated = createZeroResourceUsage('versioned_upper_bound', 'unrelated-unknown-v1');
    let budget = reduceResourceBudgetState(base.resourceBudget, {
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'unrelated',
        runId: 'funding-run',
        invocationId: 'unrelated',
        resourceKind: 'subagent',
        executableUpperBound: unrelated,
        state: 'reserved',
      },
    });
    budget = reduceResourceBudgetState(budget, {
      type: 'resource_budget.unknown',
      reservationId: 'unrelated',
    });
    const sourceState = { ...base, resourceBudget: budget };
    const planned = planCrossSessionTriggerTurnBackup({
      ...backupInput(),
      sourceState,
      policy: {
        ...policy(sourceState),
        executionMode: 'independent_turn_v2',
        targetRole: 'explore',
        targetGrantDigest: `sha256:${'e'.repeat(64)}`,
      },
    });
    if (planned.status !== 'planned') throw new Error('V2 backup was not planned.');
    budget = reduceResourceBudgetState(budget, planned.reservationEvent);
    const slot = planCrossSessionFollowupSlotAcquisition({
      sourceState: { ...sourceState, resourceBudget: budget },
      sourceSessionId: 'source',
      fundingRunId: 'funding-run',
      submissionId: 'submission',
      backupReservationId: planned.admission.backupReservationId,
    });
    expect(slot.status).toBe('ready');
    if (slot.status !== 'ready') throw new Error('V2 slot was unavailable.');
    budget = reduceResourceBudgetState(budget, slot.event);
    expect(budget.reservations[planned.admission.backupReservationId]?.state).toBe('reserved');
    expect(budget.reservations.unrelated?.state).toBe('unknown');
  });
  test('v2 waits for known capacity but reports when unknown executions occupy every slot', () => {
    const base = source();
    const upper = createZeroResourceUsage('versioned_upper_bound', 'occupied-slot-v1');
    upper.gauges.activeSubagents = 1;
    let budget = base.resourceBudget;
    for (const id of ['unknown-1', 'unknown-2', 'live']) {
      budget = reduceResourceBudgetState(budget, {
        type: 'resource_budget.reserved',
        reservation: {
          version: 1,
          reservationId: id,
          runId: 'funding-run',
          invocationId: id,
          resourceKind: 'subagent',
          executableUpperBound: upper,
          state: 'reserved',
        },
      });
      if (id !== 'live')
        budget = reduceResourceBudgetState(budget, {
          type: 'resource_budget.unknown',
          reservationId: id,
        });
    }
    const sourceState = { ...base, resourceBudget: budget };
    const planned = planCrossSessionTriggerTurnBackup({
      ...backupInput(),
      sourceState,
      policy: {
        ...policy(sourceState),
        executionMode: 'independent_turn_v2',
        targetRole: 'explore',
        targetGrantDigest: `sha256:${'e'.repeat(64)}`,
      },
    });
    if (planned.status !== 'planned') throw new Error('V2 backup was not planned.');
    budget = reduceResourceBudgetState(budget, planned.reservationEvent);
    const slotInput = {
      sourceSessionId: 'source',
      fundingRunId: 'funding-run',
      submissionId: 'submission',
      backupReservationId: planned.admission.backupReservationId,
    };
    expect(
      planCrossSessionFollowupSlotAcquisition({
        ...slotInput,
        sourceState: { ...base, resourceBudget: budget },
      }),
    ).toEqual({ status: 'waiting' });
    budget = reduceResourceBudgetState(budget, {
      type: 'resource_budget.unknown',
      reservationId: 'live',
    });
    expect(() =>
      planCrossSessionFollowupSlotAcquisition({
        ...slotInput,
        sourceState: { ...base, resourceBudget: budget },
      }),
    ).toThrow('capacity is occupied by unknown executions');
    expect(budget.reservations[planned.admission.backupReservationId]?.state).toBe('queued');
    if (budget.status !== 'active') throw new Error('Funding ledger became unavailable.');
    expect(
      planCrossSessionFollowupSlotAcquisition({
        ...slotInput,
        sourceState: {
          ...base,
          resourceBudget: {
            ...budget,
            budget: { ...budget.budget, maxConcurrentSubagents: 4 },
          },
        },
      }),
    ).toMatchObject({ status: 'ready' });
  });
  test('plans one deterministic source-funded backup after receipt preflight', () => {
    const input = backupInput();
    const first = planCrossSessionTriggerTurnBackup(input);
    const second = planCrossSessionTriggerTurnBackup(input);
    expect(first).toEqual(second);
    if (first.status !== 'planned') throw new Error('Backup was not planned.');
    expect(first.reservationEvent.reservation).toMatchObject({
      runId: 'funding-run',
      resourceKind: 'subagent',
      state: 'queued',
      executableUpperBound: {
        counters: { turns: 1, modelRequests: 1, inputTokens: 100, outputTokens: 50 },
        gauges: { activeSubagents: 1 },
      },
    });
    expect(first.admission.deadlineAt).toBe(Date.parse(deadlineAt));
  });

  test('queues finite counters, waits only for occupied child slots, then acquires exactly one', () => {
    const input = backupInput();
    const planned = planCrossSessionTriggerTurnBackup(input);
    if (planned.status !== 'planned') throw new Error('Backup was not planned.');
    const upper = createZeroResourceUsage('versioned_upper_bound', 'occupied-slot-v1');
    upper.gauges.activeSubagents = 1;
    let budget = input.sourceState.resourceBudget;
    for (const id of ['occupied-1', 'occupied-2', 'occupied-3']) {
      budget = reduceResourceBudgetState(budget, {
        type: 'resource_budget.reserved',
        reservation: {
          version: 1,
          reservationId: id,
          runId: 'funding-run',
          invocationId: id,
          resourceKind: 'subagent',
          executableUpperBound: upper,
          state: 'reserved',
        },
      });
    }
    const occupiedSource = { ...input.sourceState, resourceBudget: budget };
    const accepted = planCrossSessionTriggerTurnBackup({
      ...input,
      sourceState: occupiedSource,
      policy: policy(occupiedSource),
    });
    if (accepted.status !== 'planned')
      throw new Error('Full slot should still accept bounded work.');
    budget = reduceResourceBudgetState(budget, accepted.reservationEvent);
    expect(budget.reservations[accepted.admission.backupReservationId]?.state).toBe('queued');
    if (budget.status !== 'active') throw new Error('Funding ledger became unavailable.');
    expect(committedResourceUsage(budget).gauges.activeSubagents).toBe(3);
    expect(committedResourceUsage(budget).counters.turns).toBe(1);
    const slotInput = {
      sourceState: { ...occupiedSource, resourceBudget: budget },
      sourceSessionId: 'source',
      fundingRunId: 'funding-run',
      submissionId: 'submission',
      backupReservationId: accepted.admission.backupReservationId,
    };
    expect(planCrossSessionFollowupSlotAcquisition(slotInput)).toEqual({ status: 'waiting' });
    expect(() =>
      reduceResourceBudgetState(budget, {
        type: 'resource_budget.child_slot_acquired',
        reservationId: accepted.admission.backupReservationId,
      }),
    ).toThrow('unavailable');
    budget = reduceResourceBudgetState(budget, {
      type: 'resource_budget.released',
      reservationId: 'occupied-1',
    });
    const ready = planCrossSessionFollowupSlotAcquisition({
      ...slotInput,
      sourceState: { ...occupiedSource, resourceBudget: budget },
    });
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') throw new Error('Slot acquisition was not ready.');
    budget = reduceResourceBudgetState(budget, ready.event);
    expect(budget.reservations[accepted.admission.backupReservationId]?.state).toBe('reserved');
    if (budget.status !== 'active') throw new Error('Funding ledger became unavailable.');
    expect(committedResourceUsage(budget).gauges.activeSubagents).toBe(3);
    expect(
      planCrossSessionFollowupSlotAcquisition({
        ...slotInput,
        sourceState: { ...occupiedSource, resourceBudget: budget },
      }),
    ).toEqual({ status: 'already_acquired' });
  });

  test('queued backup still rejects exhausted counters before acceptance', () => {
    const input = backupInput();
    const consumed = createZeroResourceUsage('versioned_upper_bound', 'used-turns-v1');
    consumed.counters.turns = LIMITED_RESOURCE_BUDGET_.maxTurns;
    const budget = reduceResourceBudgetState(input.sourceState.resourceBudget, {
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'used-turns',
        runId: 'funding-run',
        invocationId: 'used-turns',
        resourceKind: 'subagent',
        executableUpperBound: consumed,
        state: 'reserved',
      },
    });
    const sourceState = { ...input.sourceState, resourceBudget: budget };
    expect(() =>
      planCrossSessionTriggerTurnBackup({
        ...input,
        sourceState,
        policy: policy(sourceState),
      }),
    ).toThrow();
  });

  test('returns exact receipt before stale budget or deadline checks', () => {
    const input = backupInput();
    const receipt = { commandId: 'message', committedRevision: 7 };
    expect(
      planCrossSessionTriggerTurnBackup({
        ...input,
        sourceState: initial('foreign'),
        nowMs: Number.NaN,
        receipt: { status: 'exact', requestDigest: input.requestDigest, receipt },
      }),
    ).toEqual({ status: 'replay', receipt });
    expect(() =>
      planCrossSessionTriggerTurnBackup({
        ...input,
        receipt: { status: 'exact', requestDigest: 'different', receipt },
      }),
    ).toThrow('different request digest');
    expect(() =>
      planCrossSessionTriggerTurnBackup({
        ...input,
        receipt: { status: 'conflict' },
      }),
    ).toThrow();
  });

  test('rejects missing source authority, unknown funding and stale policy', () => {
    const input = backupInput();
    expect(() =>
      planCrossSessionTriggerTurnBackup({
        ...input,
        trustedCurrentRunId: 'other-run',
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionTriggerTurnBackup({
        ...input,
        nowMs: Date.parse(deadlineAt),
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionTriggerTurnBackup({
        ...input,
        policy: { ...input.policy, policyRevision: '' },
      }),
    ).toThrow();
    const unknown = accepted().fundingState;
    const poisoned = {
      ...unknown,
      resourceBudget: reduceResourceBudgetState(unknown.resourceBudget, {
        type: 'resource_budget.unknown',
        reservationId: accepted().backup.admission.backupReservationId,
      }),
    };
    expect(() => planCrossSessionTriggerTurnBackup({ ...input, sourceState: poisoned })).toThrow();
  });

  test('validates exact first Surface and atomically replaces a retained backup', () => {
    const input = replacementInput();
    const current = reduceResourceBudgetState(
      { status: 'unconfigured', reservations: {} },
      {
        type: 'resource_budget.configured',
        runId: 'new-foreground-run',
        startedAt: '2026-09-25T00:00:05.000Z',
        deadlineAt: '2026-09-25T00:04:00.000Z',
        budget: LIMITED_RESOURCE_BUDGET_,
      },
    );
    if (input.fundingState.resourceBudget.status !== 'active')
      throw new Error('Fixture funding budget is inactive.');
    const fundingState = {
      ...input.fundingState,
      resourceBudget: current,
      retainedResourceBudgets: { 'funding-run': input.fundingState.resourceBudget },
    };
    const result = planCrossSessionFirstModelReplacement({ ...input, fundingState });
    if (result.status !== 'planned') throw new Error('Replacement was not planned.');
    const event = result.plan.preparationEvents[0];
    expect(event?.type).toBe('resource_budget.bounded_replaced');
    if (event?.type !== 'resource_budget.bounded_replaced') throw new Error('Wrong event.');
    const after = reduceResourceBudgetState(
      fundingState.retainedResourceBudgets['funding-run']!,
      event,
    );
    expect(after.reservations[input.admission.backupReservationId]?.state).toBe('released');
    expect(
      after.reservations[result.plan.turnReservationId]?.executableUpperBound.counters.turns,
    ).toBe(1);
    expect(
      after.reservations[
        result.plan.budget.kind === 'reservation' ? result.plan.budget.reservationId : ''
      ]?.executableUpperBound.counters.inputTokens,
    ).toBe(100);
    expect(fundingState.resourceBudget).toBe(current);
    const poisonedRetained = reduceResourceBudgetState(
      fundingState.retainedResourceBudgets['funding-run']!,
      { type: 'resource_budget.unknown', reservationId: input.admission.backupReservationId },
    );
    if (poisonedRetained.status !== 'active') throw new Error('Retained ledger is inactive.');
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        fundingState: {
          ...fundingState,
          retainedResourceBudgets: { 'funding-run': poisonedRetained },
        },
      }),
    ).toThrow();
  });

  test('rejects over-bound, expired, unknown, phase and policy changes', () => {
    const input = replacementInput();
    for (const frozenSurface of [
      { ...input.frozenSurface, inputTokens: 51 },
      { ...input.frozenSurface, maxOutputTokens: 51 },
      { ...input.frozenSurface, verified: false as const },
    ])
      expect(() =>
        planCrossSessionFirstModelReplacement({
          ...input,
          frozenSurface: frozenSurface as typeof input.frozenSurface,
        }),
      ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        nowMs: Date.parse(deadlineAt),
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        currentPolicy: { ...input.currentPolicy, policyRevision: 'changed' },
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        currentPolicy: { ...input.currentPolicy, authorizationDigest: 'changed' },
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        targetState: {
          ...input.targetState,
          interactionModeRevision: input.admission.policy.interactionModeRevision + 1,
        },
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        admission: {
          ...input.admission,
          policy: { ...input.admission.policy, phaseCeiling: 'planning' },
        },
        currentPolicy: { ...input.currentPolicy, phaseCeiling: 'planning' },
      }),
    ).toThrow();
    const funding = input.fundingState;
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        fundingState: {
          ...funding,
          resourceBudget: reduceResourceBudgetState(funding.resourceBudget, {
            type: 'resource_budget.unknown',
            reservationId: input.admission.backupReservationId,
          }),
        },
      }),
    ).toThrow();
  });

  test('retains the target revision guard for source auto revision 1 and child auto revision 0', () => {
    const original = source();
    const sourceAuto = { ...original, mode: 'auto' as const, interactionModeRevision: 1 };
    const admitted = planCrossSessionTriggerTurnBackup({
      ...backupInput(),
      sourceState: sourceAuto,
      policy: policy(sourceAuto),
    });
    if (admitted.status !== 'planned') throw new Error('Source admission was not planned.');
    const fundingState = {
      ...sourceAuto,
      resourceBudget: acquireBackup(sourceAuto.resourceBudget, admitted.reservationEvent),
    };
    const targetAuto = { ...initial('target'), mode: 'auto' as const };
    expect(targetAuto.interactionModeRevision).toBe(0);
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...replacementInput(),
        fundingState,
        targetState: targetAuto,
        admission: admitted.admission,
        currentPolicy: admitted.admission.policy,
      }),
    ).toThrow('policy exceeds immutable TriggerTurn authority');
  });

  test('admits independent target auto revision 0 only with a current zero-Tool grant proof', () => {
    const original = source();
    const sourceAuto = { ...original, mode: 'auto' as const, interactionModeRevision: 1 };
    const acceptedPolicy = {
      ...policy(sourceAuto),
      interactionMode: 'auto' as const,
      workspaceAccess: sourceAuto.workspaceAccess,
    };
    const admitted = planCrossSessionTriggerTurnBackup({
      ...backupInput(),
      sourceState: sourceAuto,
      policy: acceptedPolicy,
    });
    if (admitted.status !== 'planned') throw new Error('Source admission was not planned.');
    const target = replacementInput().targetState;
    const targetAuto = { ...target, mode: 'auto' as const };
    const fundingState = {
      ...sourceAuto,
      resourceBudget: acquireBackup(sourceAuto.resourceBudget, admitted.reservationEvent),
    };
    const proof = {
      observedTargetRevision: targetAuto.revision,
      grantDigest: targetAuto.activeFollowupTurn!.grantDigest,
      capabilityDigest: targetAuto.capabilities.catalogRevision,
      interactionModeRevision: targetAuto.interactionModeRevision,
      phaseCeiling: getAgentPhase(getActivePlanning(targetAuto)),
      mode: targetAuto.mode,
      workspaceAccess: targetAuto.workspaceAccess,
      denyTools: true as const,
      allowedTools: [] as const,
    };
    const input = {
      ...replacementInput(),
      fundingState,
      targetState: targetAuto,
      admission: admitted.admission,
      currentPolicy: admitted.admission.policy,
      targetPolicyProof: proof,
    };
    expect(planCrossSessionFirstModelReplacement(input).status).toBe('planned');
    expect(() =>
      planCrossSessionFirstModelReplacement({ ...input, targetPolicyProof: undefined }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        targetPolicyProof: { ...proof, observedTargetRevision: proof.observedTargetRevision + 1 },
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        targetState: { ...targetAuto, mode: 'accept_edits' as const },
        targetPolicyProof: { ...proof, mode: 'accept_edits' as const },
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        targetPolicyProof: { ...proof, capabilityDigest: 'changed-catalog' },
      }),
    ).toThrow();
    expect(() =>
      planCrossSessionFirstModelReplacement({
        ...input,
        targetPolicyProof: { ...proof, denyTools: false as never },
      }),
    ).toThrow();
  });

  test('compares every immutable ResourceUsage counter and gauge with the held backup', () => {
    const input = replacementInput();
    const upper = input.admission.executableUpperBound;
    for (const field of [
      'turns',
      'modelRequests',
      'toolInvocations',
      'inputTokens',
      'outputTokens',
      'artifactBytes',
    ] as const) {
      expect(() =>
        planCrossSessionFirstModelReplacement({
          ...input,
          admission: {
            ...input.admission,
            executableUpperBound: {
              ...upper,
              counters: { ...upper.counters, [field]: upper.counters[field] + 1 },
            },
          },
        }),
      ).toThrow();
    }
    for (const field of [
      'elapsedRunMs',
      'activeSubagents',
      'activeWriters',
      'activeToolInvocations',
      'activeShellInvocations',
    ] as const) {
      expect(() =>
        planCrossSessionFirstModelReplacement({
          ...input,
          admission: {
            ...input.admission,
            executableUpperBound: {
              ...upper,
              gauges: { ...upper.gauges, [field]: upper.gauges[field] + 1 },
            },
          },
        }),
      ).toThrow();
    }
  });

  test('replacement receipt replay returns before funding or Surface validation', () => {
    const input = replacementInput();
    const receipt = { routeId: 'routed' };
    expect(
      planCrossSessionFirstModelReplacement({
        ...input,
        fundingState: initial('foreign'),
        frozenSurface: { ...input.frozenSurface, verified: false as never },
        receipt: { status: 'exact', requestDigest: input.requestDigest, receipt },
      }),
    ).toEqual({ status: 'replay', receipt });
  });
});
