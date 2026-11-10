import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  TrajectoryProjector,
  trajectoryEventSchema,
} from '../src';

function fact(sequence: number, value: Record<string, unknown>): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
    sequence: String(sequence),
    origin: { storeId: 'store', cursor: String(sequence) },
    sessionId: 'session',
    workspaceId: 'workspace',
    sourceEventType: 'execution.state_changed',
    sourceRecordRevision: String(sequence),
    kind: 'model',
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: null,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...value,
  });
}
function states(events: TrajectoryEvent[], at: string) {
  return projectTrajectory(events, { atCursor: at, completePrefix: true }).steps.map((step) => [
    step.stepId,
    step.phase,
  ]);
}

test('normal model oracle at each cursor preserves dispatched versus accepted versus complete', () => {
  const events = [
    fact(1, { executionId: 'm', phase: 'planned', recordedStatus: 'planned' }),
    fact(2, { executionId: 'm', phase: 'dispatching', recordedStatus: 'dispatching' }),
    fact(4, { executionId: 'm', phase: 'completed', recordedStatus: 'succeeded' }),
  ];
  const expected = [
    ['0', []],
    ['1', [['execution:m', 'planned']]],
    ['2', [['execution:m', 'dispatching']]],
    ['3', [['execution:m', 'dispatching']]],
    ['4', [['execution:m', 'completed']]],
  ] as const;
  for (const [cursor, oracle] of expected)
    expect(states(events, cursor)).toEqual(oracle.map((row) => [...row]));
  expect(projectTrajectory(events, { atCursor: '2', completePrefix: true }).openStepIds).toEqual([
    'execution:m',
  ]);
});

test('failed attempt and explicit retry oracle never merges similar definition or operation', () => {
  const events = [
    fact(1, { executionId: 'first', operationId: 'op', attempt: 1 }),
    fact(2, {
      executionId: 'first',
      operationId: 'op',
      attempt: 1,
      phase: 'failed',
      recordedStatus: 'failed',
    }),
    fact(3, {
      executionId: 'second',
      operationId: 'op',
      attempt: 2,
      attributes: { previousExecutionId: 'first' },
    }),
    fact(5, {
      executionId: 'second',
      operationId: 'op',
      attempt: 2,
      phase: 'completed',
      recordedStatus: 'succeeded',
    }),
  ];
  for (const [cursor, oracle] of [
    ['1', [['execution:first', 'running']]],
    ['2', [['execution:first', 'failed']]],
    [
      '3',
      [
        ['execution:first', 'failed'],
        ['execution:second', 'running'],
      ],
    ],
    [
      '5',
      [
        ['execution:first', 'failed'],
        ['execution:second', 'completed'],
      ],
    ],
  ] as const)
    expect(states(events, cursor)).toEqual(oracle.map((row) => [...row]));
  const done = projectTrajectory(events, { atCursor: '5', completePrefix: true });
  expect(done.steps.map((step) => [step.attempt, step.anomalous])).toEqual([
    [1, true],
    [2, false],
  ]);
  expect(done.steps[0]!.sourceEventIds).toEqual([events[0]!.eventId, events[1]!.eventId]);
});

test('approval oracle keeps the original execution waiting after answer until a dispatch fact exists', () => {
  const events = [
    fact(1, {
      kind: 'tool',
      executionId: 'tool',
      phase: 'waiting_interaction',
      recordedStatus: 'waiting_interaction',
    }),
    fact(2, {
      kind: 'interaction',
      executionId: 'tool',
      phase: 'waiting_interaction',
      recordedStatus: 'requested',
      attributes: { interactionId: 'approval', revision: '1', decision: 'requested' },
    }),
    fact(3, {
      kind: 'interaction',
      executionId: 'tool',
      phase: 'observed',
      recordedStatus: 'answered',
      attributes: { interactionId: 'approval', revision: '2', decision: 'answered' },
    }),
    fact(4, {
      kind: 'tool',
      executionId: 'tool',
      phase: 'dispatching',
      recordedStatus: 'dispatching',
    }),
  ];
  for (const [cursor, oracle] of [
    ['1', [['execution:tool', 'waiting_interaction']]],
    [
      '2',
      [
        ['execution:tool', 'waiting_interaction'],
        ['interaction:approval', 'waiting_interaction'],
      ],
    ],
    [
      '3',
      [
        ['execution:tool', 'waiting_interaction'],
        ['interaction:approval', 'observed'],
      ],
    ],
    [
      '4',
      [
        ['execution:tool', 'dispatching'],
        ['interaction:approval', 'observed'],
      ],
    ],
  ] as const)
    expect(states(events, cursor)).toEqual(oracle.map((row) => [...row]));
});

test('parallel child oracle retains each carrier, parent and child Session without guessed ordering', () => {
  const events = [
    fact(1, {
      kind: 'job',
      executionId: 'a',
      parentExecutionId: 'parent',
      attributes: { childSessionId: 'child-a' },
    }),
    fact(2, {
      kind: 'job',
      executionId: 'b',
      parentExecutionId: 'parent',
      attributes: { childSessionId: 'child-b' },
    }),
    fact(3, {
      kind: 'child',
      executionId: 'a',
      phase: 'observed',
      attributes: { childSessionId: 'child-a', carrierExecutionId: 'a', delivery: 'accepted' },
    }),
    fact(4, {
      kind: 'job',
      executionId: 'b',
      phase: 'completed',
      recordedStatus: 'succeeded',
      attributes: { childSessionId: 'child-b' },
    }),
  ];
  expect(states(events, '2')).toEqual([
    ['execution:a', 'running'],
    ['execution:b', 'running'],
  ]);
  expect(states(events, '4')).toEqual([
    ['execution:a', 'running'],
    ['execution:b', 'completed'],
    ['child:a:child-a', 'observed'],
  ]);
  expect(
    projectTrajectory(events, { atCursor: '4', completePrefix: true })
      .steps.slice(0, 2)
      .map((step) => [step.parentExecutionId, step.childSessionId]),
  ).toEqual([
    ['parent', 'child-a'],
    ['parent', 'child-b'],
  ]);
});

test('interruption and recovery oracle keeps old unknown even after a new verification or resume fact', () => {
  const events = [
    fact(1, { executionId: 'old', phase: 'outcome_unknown', recordedStatus: 'outcome_unknown' }),
    fact(2, {
      kind: 'recovery',
      executionId: 'old',
      phase: 'observed',
      recordedStatus: null,
      attributes: { outcome: 'verified' },
    }),
    fact(3, {
      executionId: 'new',
      attributes: { previousExecutionId: 'old' },
    }),
  ];
  expect(states(events, '1')).toEqual([['execution:old', 'outcome_unknown']]);
  expect(states(events, '2')).toEqual([
    ['execution:old', 'outcome_unknown'],
    [`event:${events[1]!.eventId}`, 'observed'],
  ]);
  expect(states(events, '3')).toEqual([
    ['execution:old', 'outcome_unknown'],
    [`event:${events[1]!.eventId}`, 'observed'],
    ['execution:new', 'running'],
  ]);
  expect(projectTrajectory(events, { atCursor: '3', completePrefix: true }).openStepIds).toEqual([
    'execution:old',
    'execution:new',
  ]);
});

test('missing record and material oracle separates unknown facts, legacy identity and absent evidence', () => {
  const ref = {
    evidenceId: 'lost',
    contentVersion: 'old',
    kind: 'model_output',
    mediaType: 'text/plain',
    availability: 'missing',
  };
  const events = [
    fact(1, { executionId: 'm', phase: 'failed', recordedStatus: 'failed', evidenceRefs: [ref] }),
    fact(2, {
      kind: 'unknown',
      phase: 'observed',
      recordedStatus: null,
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
  ];
  const before = projectTrajectory(events, { atCursor: '1', completePrefix: true });
  expect(before.integrity.facts).toBe('complete');
  expect(before.steps[0]!.sourceEvidenceIds).toEqual(['lost']);
  const after = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  expect(after.integrity).toEqual({
    facts: 'partial',
    identityConfidence: 'legacy_local',
    reasons: ['unknown_event', 'identity_unverified'],
  });
  expect(after.steps.map((step) => step.anomalous)).toEqual([true, true]);
  expect(
    projectTrajectory(events.slice(1), {
      atCursor: '2',
      integrity: { facts: 'complete', identityConfidence: 'legacy_local', reasons: [] },
    }).integrity.reasons,
  ).toContain('incomplete_prefix');
});

test('real Interaction and inconclusive Verification shapes never take over their linked Execution lifecycle', () => {
  const events = [
    fact(1, { kind: 'tool', executionId: 'tool', phase: 'planned', recordedStatus: 'planned' }),
    fact(2, {
      kind: 'interaction',
      executionId: 'tool',
      phase: 'waiting_interaction',
      recordedStatus: 'requested',
      attributes: { interactionId: 'approval', revision: '1', decision: 'requested' },
    }),
    fact(3, {
      kind: 'interaction',
      executionId: 'tool',
      phase: 'observed',
      recordedStatus: 'answered',
      attributes: { interactionId: 'approval', revision: '2', decision: 'answered' },
    }),
    fact(4, {
      kind: 'tool',
      executionId: 'tool',
      phase: 'dispatching',
      recordedStatus: 'dispatching',
    }),
    fact(5, { kind: 'tool', executionId: 'checker', phase: 'running', recordedStatus: 'running' }),
    fact(6, {
      kind: 'verification',
      executionId: 'checker',
      phase: 'observed',
      recordedStatus: 'inconclusive',
      attributes: {
        verificationId: 'check',
        outcome: 'unknown',
        method: 'business_reconciliation',
      },
    }),
  ];
  expect(states(events, '3')).toEqual([
    ['execution:tool', 'planned'],
    ['interaction:approval', 'observed'],
  ]);
  expect(states(events, '6')).toEqual([
    ['execution:tool', 'dispatching'],
    ['interaction:approval', 'observed'],
    ['execution:checker', 'running'],
    ['verification:check', 'observed'],
  ]);
  expect(
    projectTrajectory(events, { atCursor: '6', completePrefix: true }).steps[3]!.anomalous,
  ).toBe(true);
});

test('projection retains original namespaces and presentation metadata without retaining raw bodies', () => {
  const events = [
    fact(1, {
      executionId: 'same',
      executionOriginStoreId: 'original-a',
      parentExecutionId: 'parent',
      parentExecutionOriginStoreId: 'parent-origin',
      runId: 'run',
      runOriginStoreId: 'run-origin',
      operationId: 'op',
      operationOriginStoreId: 'op-origin',
      attributes: { definitionId: 'provider/model', previousExecutionId: 'previous' },
    }),
    fact(2, { executionId: 'same', executionOriginStoreId: 'original-b' }),
    fact(3, { executionId: 'same', executionOriginStoreId: 'original-a', sessionId: 'other' }),
    fact(4, { executionId: 'same', executionOriginStoreId: 'original-a', phase: 'completed' }),
  ];
  const result = projectTrajectory(events, { atCursor: '4', completePrefix: true });
  expect(result.steps).toHaveLength(3);
  expect(new Set(result.steps.map((step) => step.stepId)).size).toBe(3);
  expect(result.steps[0]).toMatchObject({
    originStoreId: 'store',
    executionOriginStoreId: 'original-a',
    parentExecutionOriginStoreId: 'parent-origin',
    runOriginStoreId: 'run-origin',
    operationOriginStoreId: 'op-origin',
    definitionId: 'provider/model',
    previousExecutionId: 'previous',
    phase: 'completed',
    firstSequence: '1',
    lastSequence: '4',
    sourceEventIds: [events[0]!.eventId, events[3]!.eventId],
  });
  expect(result.steps[0]).not.toHaveProperty('evidenceRefs');
  expect(result.steps[0]).not.toHaveProperty('attributes');
});

test('composite child identities and opaque IDs cannot alias a scoped presentation key', () => {
  const events = [
    fact(1, {
      kind: 'child',
      attributes: { carrierExecutionId: 'a:b', childSessionId: 'c' },
    }),
    fact(2, {
      kind: 'child',
      attributes: { carrierExecutionId: 'a', childSessionId: 'b:c' },
    }),
    fact(3, { executionId: 'same', executionOriginStoreId: 'a' }),
    fact(4, { executionId: 'same', executionOriginStoreId: 'b' }),
    fact(5, { executionId: 'same:["b","session",0]', executionOriginStoreId: 'a' }),
  ];
  const result = projectTrajectory(events, { atCursor: '5', completePrefix: true });
  expect(result.steps).toHaveLength(5);
  expect(new Set(result.steps.map((step) => step.stepId)).size).toBe(5);
  expect(result.steps.flatMap((step) => step.sourceEventIds)).toEqual(
    events.map((event) => event.eventId),
  );
});

test('source metadata keeps legacy records unknown and preserves the exact event type without material or inferred links', () => {
  const events = [
    fact(1, {
      kind: 'unknown',
      sourceEventType: 'execution.state_changed',
      phase: 'observed',
      recordedStatus: 'running',
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
    fact(2, {
      kind: 'unknown',
      sourceEventType: 'extension.recorded',
      phase: 'observed',
      identityConfidence: 'verified_origin',
      attributes: { reason: 'unrecognized_source_type' },
    }),
  ];
  const projection = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  expect(
    projection.steps.map((step) => [step.kind, step.sourceEventType, step.identityConfidence]),
  ).toEqual([
    ['unknown', 'execution.state_changed', 'legacy_local'],
    ['unknown', 'extension.recorded', 'verified_origin'],
  ]);
  expect(projection.integrity.identityConfidence).toBe('legacy_local');
  expect(projection.sourceEventIds).toEqual(events.map((event) => event.eventId));
  for (const step of projection.steps) {
    expect(step.sourceEvidenceIds).toEqual([]);
    expect(step).not.toHaveProperty('executionId');
    expect(step).not.toHaveProperty('runId');
    expect(step).not.toHaveProperty('parentExecutionId');
    expect(step).not.toHaveProperty('attributes');
  }
});

test('optional sealed interaction and compression classifiers survive projection without guessing missing history', () => {
  const events = [
    fact(1, {
      executionId: 'automatic-model',
      attributes: { compressionId: 'compression', compressionTrigger: 'automatic' },
    }),
    fact(2, { executionId: 'automatic-model', phase: 'completed' }),
    fact(3, {
      kind: 'context',
      sourceEventType: 'context.compressed',
      phase: 'observed',
      attributes: {
        action: 'compressed',
        compressionId: 'compression',
        compressionTrigger: 'automatic',
      },
    }),
    fact(4, {
      kind: 'interaction',
      attributes: { interactionId: 'approval', revision: '1', interactionKind: 'approval' },
    }),
    fact(5, {
      kind: 'interaction',
      attributes: { interactionId: 'old-approval', revision: '1' },
    }),
  ];
  const projection = projectTrajectory(events, { atCursor: '5', completePrefix: true });
  expect(projection.steps[0]).toMatchObject({
    compressionId: 'compression',
    compressionTrigger: 'automatic',
  });
  expect(projection.steps[0]!.sourceEventIds).toEqual([events[0]!.eventId, events[1]!.eventId]);
  expect(projection.steps[1]).toMatchObject({
    compressionId: 'compression',
    compressionTrigger: 'automatic',
  });
  expect(projection.steps[2]!.interactionKind).toBe('approval');
  expect(projection.steps[3]).not.toHaveProperty('interactionKind');
  expect(projection.steps[3]).not.toHaveProperty('compressionTrigger');
  expect(projectTrajectory(events, { atCursor: '1', completePrefix: true }).steps[0]!.phase).toBe(
    'running',
  );
});

test('Message updates aggregate by original message identity and keep original Model facts separate', () => {
  const events = [
    fact(1, { executionId: 'model' }),
    fact(2, {
      kind: 'message',
      executionId: 'model',
      messageOriginStoreId: 'original-message-store',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'partial_model',
        role: 'assistant',
        messageSeq: '9007199254740993',
        revision: '2',
        status: 'incomplete',
      },
    }),
    fact(3, {
      kind: 'message',
      origin: { storeId: 'restored', cursor: '3' },
      messageOriginStoreId: 'original-message-store',
      executionId: 'model',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'partial_model',
        role: 'assistant',
        messageSeq: '9007199254740993',
        revision: '3',
        status: 'complete',
      },
    }),
    fact(4, { executionId: 'model', phase: 'completed' }),
    fact(5, {
      kind: 'message',
      messageOriginStoreId: 'other-message-store',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'partial_model',
        role: 'assistant',
        messageSeq: '3',
        revision: '5',
        status: 'complete',
      },
    }),
    fact(6, {
      kind: 'message',
      sessionId: 'other-session',
      messageOriginStoreId: 'original-message-store',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'partial_model',
        role: 'assistant',
        messageSeq: '3',
        revision: '6',
        status: 'complete',
      },
    }),
  ];
  const projection = projectTrajectory(events, { atCursor: '6', completePrefix: true });
  expect(projection.steps).toHaveLength(4);
  expect(projection.steps[0]!.sourceEventIds).toEqual([events[0]!.eventId, events[3]!.eventId]);
  expect(projection.steps[1]).toMatchObject({
    stepId: 'message:partial_model',
    messageId: 'partial_model',
    messageOriginStoreId: 'original-message-store',
    messageRole: 'assistant',
    messageSeq: '9007199254740993',
    messageRevision: '3',
    messageStatus: 'complete',
    sourceEventIds: [events[1]!.eventId, events[2]!.eventId],
  });
  expect(new Set(projection.steps.map((step) => step.stepId)).size).toBe(4);
  const prefix = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  expect(prefix.steps[1]!.messageStatus).toBe('incomplete');
  expect(prefix.steps[1]!.messageRevision).toBe('2');
  expect(prefix.steps[1]!.sourceEventIds).toEqual([events[1]!.eventId]);
});

test('a later unbound Message revision does not inherit a former unique Model or Run association', () => {
  const events = [
    fact(1, {
      kind: 'message',
      runId: 'run',
      executionId: 'model',
      operationId: 'command',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'message',
        role: 'assistant',
        messageSeq: '1',
        revision: '1',
        status: 'incomplete',
      },
    }),
    fact(2, {
      kind: 'message',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'message',
        role: 'assistant',
        messageSeq: '1',
        revision: '2',
        status: 'complete',
      },
    }),
  ];
  const projection = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  expect(projection.steps).toHaveLength(1);
  expect(projection.steps[0]!.messageStatus).toBe('complete');
  expect(projection.steps[0]).not.toHaveProperty('executionId');
  expect(projection.steps[0]).not.toHaveProperty('runId');
  expect(projection.steps[0]).not.toHaveProperty('operationId');
  expect(projection.steps[0]!.sourceEventIds).toEqual(events.map((event) => event.eventId));
});

test('full-prefix safe event metadata preserves exact observation refs and token semantics at the original cursor', () => {
  const first = fact(1, {
    executionId: 'model',
    occurredAt: 1000,
    phase: 'planned',
    attributes: { definitionId: 'fixed', definitionVersion: '1' },
    evidenceRefs: [
      {
        evidenceId: 'original-input',
        contentVersion: 'v1',
        kind: 'model_input',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  });
  const completed = fact(2, {
    executionId: 'model',
    occurredAt: 4000,
    phase: 'completed',
    attributes: {
      definitionId: 'fixed',
      definitionVersion: '1',
      usage: { inputTokens: '9007199254740993', outputTokens: '50', cachedInputTokens: '8' },
      compressionId: 'compression',
      compressionTrigger: 'automatic',
      compression: { adopted: false, triggerTokens: 5000, triggerBasis: 'local_estimate' },
    },
    evidenceRefs: [
      {
        evidenceId: 'original-output',
        contentVersion: 'v2',
        kind: 'model_output',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  });
  const projection = projectTrajectory([first, completed], { atCursor: '1', completePrefix: true });
  expect(projection.eventIndex).toEqual([first]);
  expect(projection.completePrefix).toBe(true);
  expect(projection.steps[0]!.definitionVersion).toBe('1');
  expect(projection.steps[0]!.usage).toBeUndefined();
  const full = projectTrajectory([first, completed], { atCursor: '2', completePrefix: true });
  expect(full.steps[0]!.usage).toEqual({
    inputTokens: '9007199254740993',
    outputTokens: '50',
    cachedInputTokens: '8',
  });
  expect(full.steps[0]!.compression).toEqual({
    adopted: false,
    triggerTokens: 5000,
    triggerBasis: 'local_estimate',
  });
  expect(full.eventIndex).toEqual([first, completed]);
  expect(
    full.eventIndex!.flatMap((event) => event.evidenceRefs.map((ref) => ref.evidenceId)),
  ).toEqual(['original-input', 'original-output']);
});

test('projection consumers cannot mutate the retained safe index, nested usage or compression accounting', () => {
  const event = fact(1, {
    executionId: 'm',
    attributes: {
      usage: { inputTokens: '10' },
      compression: {
        adopted: true,
        accounting: { basis: 'local-context-estimate-v1', beforeTokens: 100, afterTokens: 25 },
      },
    },
  });
  const projector = new TrajectoryProjector({ atCursor: '1', completePrefix: true });
  projector.apply([event]);
  const view = projector.project();
  view.eventIndex![0]!.origin.storeId = 'mutated';
  view.steps[0]!.usage!.inputTokens = '0';
  view.steps[0]!.compression!.accounting!.afterTokens = 0;
  const original = projector.project();
  expect(original.eventIndex![0]!.origin.storeId).toBe('store');
  expect(original.steps[0]!.usage!.inputTokens).toBe('10');
  expect(original.steps[0]!.compression!.accounting!.afterTokens).toBe(25);
});
