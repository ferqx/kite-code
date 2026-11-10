import { expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import {
  canonicalSerialize,
  compareDecimal64,
  createTrajectoryEventId,
  decimal64Schema,
  decodeTrajectoryEvent,
  deliveryResultSchema,
  parseDecimal64,
  projectTrajectory,
  type TraceEventBatch,
  type TrajectoryEvent,
  type TrajectoryPage,
  traceBatchSchema,
  traceEventViewSchema,
  trajectoryEventSchema,
  trajectoryIdentityPayload,
  trajectoryJsonSchemas,
  validateDeliveryResult,
  verifyTrajectoryPage,
} from '../src';

function event(sequence: string, change: Partial<TrajectoryEvent> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${sequence.padStart(64, '0')}`,
    sequence,
    origin: { storeId: 'original-store', cursor: sequence },
    sessionId: 'session',
    workspaceId: 'workspace',
    sourceEventType: 'execution.running',
    sourceRecordRevision: sequence,
    kind: 'model',
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: null,
    attributes: {},
    evidenceRefs: [],
    identityConfidence: 'verified_origin',
    executionId: 'model-1',
    ...change,
  });
}
const integrity = {
  facts: 'complete',
  identityConfidence: 'verified_origin',
  reasons: [],
} as const;

test('Decimal64 preserves the complete SQLite range and rejects noncanonical input', () => {
  for (const value of ['0', '1', '9007199254740993', '9223372036854775806', '9223372036854775807'])
    expect(decimal64Schema.parse(value)).toBe(value);
  for (const value of [
    '00',
    '01',
    '-1',
    '1.0',
    '+1',
    '1e2',
    '9223372036854775808',
    '9999999999999999999',
    '10000000000000000000',
    9007199254740992,
    '',
    ' 1',
  ])
    expect(decimal64Schema.safeParse(value).success).toBe(false);
  expect(parseDecimal64('9007199254740993')).toBe(9007199254740993n);
  expect(compareDecimal64('9', '10')).toBe(-1);
  expect(compareDecimal64('9007199254740993', '9007199254740992')).toBe(1);
});

test('identity derives from original source and fixed domain, independently of projector or read Store', async () => {
  const origin = { storeId: 'original-store', cursor: '9007199254740993' };
  expect(trajectoryIdentityPayload(origin)).toBe(
    '["kite.trajectory.event@1","original-store","9007199254740993"]',
  );
  expect(await createTrajectoryEventId(origin)).toBe(
    'te_29b039fadcd414ebacb74971b671c0ab8e864cca69c5ad25c5b8e87da9ddd210',
  );
  expect(await createTrajectoryEventId(origin)).toBe(await createTrajectoryEventId({ ...origin }));
  expect(await createTrajectoryEventId(origin, 'restored-copy')).not.toBe(
    await createTrajectoryEventId(origin),
  );
  expect(await createTrajectoryEventId(origin, 'restored-copy')).not.toBe(
    await createTrajectoryEventId(origin, 'another-copy'),
  );
});

test('canonical serialization orders object keys and rejects JSON data loss', () => {
  expect(canonicalSerialize({ z: [2, { b: 1, a: '你好' }], a: null })).toBe(
    '{"a":null,"z":[2,{"a":"你好","b":1}]}',
  );
  expect(canonicalSerialize({ b: 2, a: 1 })).toBe(canonicalSerialize({ a: 1, b: 2 }));
  for (const value of [undefined, { lost: undefined }, NaN, Infinity, 1n, new Date(), new Array(2)])
    expect(() => canonicalSerialize(value)).toThrow();
});

test('event attributes are a strict kind union, without a free payload channel', () => {
  const model = event('1');
  expect(
    trajectoryEventSchema.safeParse({ ...model, attributes: { input: 'private prompt' } }).success,
  ).toBe(false);
  expect(trajectoryEventSchema.safeParse({ ...model, raw_event: {} }).success).toBe(false);
  expect(trajectoryEventSchema.safeParse({ ...model, kind: 'interaction' }).success).toBe(false);
  const observed = event('2', {
    kind: 'artifact',
    phase: 'observed',
    recordedStatus: null,
    attributes: { artifactId: 'artifact-1' },
  });
  expect(observed.phase).toBe('observed');
});

test('optional compression and interaction classifications preserve V1 and stay closed scalar enums', () => {
  const model = event('1');
  const schemas = trajectoryJsonSchemas();
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schemas.TrajectoryEvent!);
  for (const trigger of ['automatic', 'manual'] as const) {
    const classified = {
      ...model,
      attributes: { compressionId: 'compression-1', compressionTrigger: trigger },
    };
    expect(trajectoryEventSchema.parse(classified).schemaVersion).toBe(1);
    expect(validate(classified)).toBe(true);
    const context = { ...classified, kind: 'context' };
    expect(trajectoryEventSchema.safeParse(context).success).toBe(true);
    expect(validate(context)).toBe(true);
  }
  for (const interactionKind of ['approval', 'question', 'plan_review'] as const) {
    const interaction = {
      ...model,
      kind: 'interaction',
      attributes: { interactionId: 'interaction-1', revision: '1', interactionKind },
    };
    expect(trajectoryEventSchema.safeParse(interaction).success).toBe(true);
    expect(validate(interaction)).toBe(true);
  }
  for (const attributes of [
    { compressionTrigger: 'unknown' },
    { compressionTrigger: { trigger: 'automatic', private: 'secret' } },
    { compressionId: ['compression-1'] },
    { interactionKind: 'approval' },
  ]) {
    const invalid = { ...model, attributes };
    expect(trajectoryEventSchema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
  }
  expect(trajectoryEventSchema.parse(model).attributes).toEqual({});
  expect(validate(model)).toBe(true);
  for (const kind of ['interaction', 'context'] as const) {
    const attributes =
      kind === 'interaction' ? { interactionId: 'old-interaction', revision: '1' } : {};
    expect(trajectoryEventSchema.safeParse({ ...model, kind, attributes }).success).toBe(true);
  }
});

test('message facts carry only scalar identity and exact-version Evidence references', () => {
  const message = event('9', {
    kind: 'message',
    messageOriginStoreId: 'message-original-store',
    attributes: {
      messageId: 'message-1',
      role: 'user',
      messageSeq: '5',
      revision: '9',
      status: 'complete',
    },
    evidenceRefs: [
      {
        evidenceId: 'message-evidence',
        contentVersion: 'original-version',
        kind: 'message',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  });
  const validate = new Ajv2020({ strict: false }).compile(trajectoryJsonSchemas().TrajectoryEvent!);
  expect(validate(message)).toBe(true);
  expect(message.schemaVersion).toBe(1);
  for (const change of [
    { content: 'private body' },
    { role: 'tool' },
    { revision: 9 },
    { status: 'succeeded' },
  ]) {
    const invalid = { ...message, attributes: { ...message.attributes, ...change } };
    expect(trajectoryEventSchema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
  }
});

test('unknown event stays explicit; unsupported major version yields only a safe envelope', () => {
  const unknown = event('2', {
    kind: 'unknown',
    phase: 'observed',
    attributes: { reason: 'unrecognized_source_type' },
  });
  expect(decodeTrajectoryEvent(unknown).status).toBe('supported');
  const result = decodeTrajectoryEvent({
    ...event('3'),
    schemaVersion: 8,
    attributes: { secret: 'private' },
    evidenceRefs: [{ private: true }],
    raw_event: 'private',
  });
  expect(result.status).toBe('unsupported_version');
  if (result.status !== 'unsupported_version') throw Error('fixture');
  expect(Object.keys(result.envelope).sort()).toEqual([
    'eventId',
    'origin',
    'schema',
    'schemaVersion',
    'sequence',
    'sessionId',
    'sourceEventType',
    'workspaceId',
  ]);
  expect(JSON.stringify(result)).not.toContain('private');
  expect(decodeTrajectoryEvent({ schema: 'kite.trajectory', schemaVersion: 8 }).status).toBe(
    'invalid',
  );
});

test('fixed-upper source scans advance through empty filtered pages and sparse global sequence', () => {
  const request = {
    storeId: 'restored-read-store',
    sessionId: 'session',
    afterCursor: '9007199254740992',
    upperCursor: '9007199254741002',
    eventKinds: ['model' as const],
  };
  const empty: TrajectoryPage = {
    ...request,
    scannedThrough: '9007199254740998',
    exhausted: false,
    events: [],
    integrity: { ...integrity, reasons: [] },
  };
  expect(verifyTrajectoryPage(empty, request).scannedThrough).toBe('9007199254740998');
  const end = {
    ...empty,
    afterCursor: empty.scannedThrough,
    scannedThrough: request.upperCursor,
    exhausted: true,
    events: [event('9007199254741001')],
  };
  expect(
    verifyTrajectoryPage(end, { ...request, afterCursor: empty.scannedThrough }).exhausted,
  ).toBe(true);
  for (const bad of [
    { ...empty, scannedThrough: request.afterCursor },
    { ...empty, exhausted: true },
    { ...empty, upperCursor: '9007199254741003' },
    { ...empty, sessionId: 'another-session' },
    { ...empty, events: [event('9007199254740991')] },
    { ...empty, events: [event('9007199254740999')] },
  ])
    expect(() => verifyTrajectoryPage(bad, request)).toThrow();
});

function batch(): TraceEventBatch {
  const first = traceEventViewSchema.parse({
    schema: 'kite.trace-event-view',
    schemaVersion: 1,
    eventId: event('1').eventId,
    sequence: '1',
    scope: { storeRef: 'sref', sessionRef: 'session-ref', workspaceRef: 'wref' },
    origin: { storeRef: 'original-ref', cursor: '1' },
    sourceEventType: 'execution.running',
    sourceRecordRevision: '1',
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: null,
    identityConfidence: 'verified_origin',
    evidenceRefs: [],
    kind: 'model',
    attributes: {},
  });
  return {
    source: 'live',
    batchId: 'batch',
    leaseToken: 'lease',
    processGeneration: '2',
    partition: {
      installationId: 'installation',
      storeRef: 'sref',
      sessionRef: 'session-ref',
      subscriptionEpoch: '4',
      lane: { kind: 'live' },
    },
    grantRevision: '3',
    filterRevision: '1',
    upperCursor: '10',
    fromCursor: '0',
    scannedThrough: '10',
    events: [first, { ...first, eventId: event('9').eventId, sequence: '9' }],
    integrity: { ...integrity, reasons: [] },
  };
}

test('partial ACK accepts only the sent subset and binds exact epoch, generation and lease', () => {
  const source = batch();
  const partial = {
    batchId: 'batch',
    leaseToken: 'lease',
    processGeneration: '2',
    subscriptionEpoch: '4',
    acknowledgedEventIds: [event('9').eventId],
    rejected: [],
  };
  expect(validateDeliveryResult(partial, source).acknowledgedEventIds).toEqual([
    event('9').eventId,
  ]);
  // ACK of the later member never implies ACK of the earlier member or the scanned interval.
  expect(validateDeliveryResult(partial, source).acknowledgedEventIds).not.toContain(
    event('1').eventId,
  );
  for (const change of [
    { leaseToken: 'retired' },
    { processGeneration: '1' },
    { subscriptionEpoch: '3' },
    { acknowledgedEventIds: [event('7').eventId] },
    { acknowledgedEventIds: [event('9').eventId, event('9').eventId] },
    { rejected: [{ eventId: event('9').eventId, reason: 'retry' }] },
  ])
    expect(() => validateDeliveryResult({ ...partial, ...change }, source)).toThrow();
  expect(deliveryResultSchema.safeParse({ ...partial, statePatch: {} }).success).toBe(false);
});

test('batch source and lane agree, while source attempts preserve the existing safe integer range', () => {
  const live = batch();
  expect(traceBatchSchema.safeParse(live).success).toBe(true);
  expect(traceBatchSchema.safeParse({ ...live, source: 'history' }).success).toBe(false);
  expect(
    trajectoryEventSchema.safeParse({ ...event('1'), attempt: Number.MAX_SAFE_INTEGER }).success,
  ).toBe(true);
});

test('authorized event views use opaque scope and nested relationship refs', () => {
  const view = batch().events[0]!;
  expect(trajectoryEventSchema.safeParse(view).success).toBe(false);
  expect(traceEventViewSchema.safeParse({ ...view, sessionId: 'original' }).success).toBe(false);
  expect(
    traceEventViewSchema.safeParse({ ...view, attributes: { previousExecutionId: 'original' } })
      .success,
  ).toBe(false);
  expect(
    traceEventViewSchema.safeParse({ ...view, attributes: { previousExecutionRef: 'opaque' } })
      .success,
  ).toBe(true);
});

test('runtime and generated JSON Schema share strict discriminants and full Decimal64 precision', () => {
  const schemas = trajectoryJsonSchemas();
  const ajv = new Ajv2020({ strict: false });
  const decimal = ajv.compile(schemas.Decimal64!);
  for (const value of ['0', '9007199254740993', '9223372036854775807', '9223372036854775808', '01'])
    expect(decimal(value)).toBe(decimal64Schema.safeParse(value).success);
  const validate = ajv.compile(schemas.TrajectoryEvent!);
  expect(validate(event('1'))).toBe(true);
  expect(validate({ ...event('1'), attributes: { raw: 'private' } })).toBe(false);
});

test('as-of projector preserves attempts, anomalies, waiting states and exact provenance', () => {
  const events = [
    event('1', {
      executionId: 'attempt-1',
      operationId: 'operation',
      attempt: 1,
      phase: 'dispatching',
      recordedStatus: 'dispatching',
    }),
    event('3', {
      executionId: 'attempt-1',
      operationId: 'operation',
      attempt: 1,
      phase: 'failed',
      recordedStatus: 'failed',
    }),
    event('7', {
      executionId: 'attempt-2',
      operationId: 'operation',
      attempt: 2,
      phase: 'waiting_interaction',
      recordedStatus: 'waiting_interaction',
      attributes: { previousExecutionId: 'attempt-1' },
    }),
    event('9', {
      executionId: 'attempt-2',
      operationId: 'operation',
      attempt: 2,
      phase: 'completed',
      recordedStatus: 'succeeded',
    }),
  ];
  const at7 = projectTrajectory(events, { atCursor: '7', completePrefix: true });
  expect(at7.steps.map((step) => [step.executionId, step.phase, step.anomalous])).toEqual([
    ['attempt-1', 'failed', true],
    ['attempt-2', 'waiting_interaction', false],
  ]);
  expect(at7.steps[0]!.sourceEventIds).toEqual([events[0]!.eventId, events[1]!.eventId]);
  expect(at7.sourceEventIds).not.toContain(events[3]!.eventId);
  expect(at7.openStepIds).toEqual(['execution:attempt-2']);
  expect(projectTrajectory(events, { atCursor: '9', completePrefix: true }).openStepIds).toEqual(
    [],
  );
  expect(projectTrajectory(events.slice(2), { atCursor: '9' }).integrity.facts).toBe('unknown');
  expect(
    projectTrajectory([event('1', { identityConfidence: 'legacy_local' })], { atCursor: '1' })
      .integrity.identityConfidence,
  ).toBe('legacy_local');
});

test('restored new event origins preserve independently sealed execution and predecessor namespaces', () => {
  const original = event('1', {
    executionOriginStoreId: 'original-store',
    runOriginStoreId: 'original-store',
    operationOriginStoreId: 'original-store',
    parentExecutionOriginStoreId: 'original-store',
  });
  const restored = event('2', {
    origin: { storeId: 'restored-store', cursor: '2' },
    executionOriginStoreId: 'original-store',
    runOriginStoreId: 'original-store',
    operationOriginStoreId: 'original-store',
    attributes: {
      previousExecutionId: 'previous',
      previousExecutionOriginStoreId: 'previous-store',
    },
  });
  expect(original.executionOriginStoreId).toBe(restored.executionOriginStoreId);
  expect(restored.origin.storeId).not.toBe(restored.executionOriginStoreId);
  const view = batch().events[0]!;
  expect(
    traceEventViewSchema.safeParse({
      ...view,
      attributes: { previousExecutionOriginStoreId: 'original-store' },
    }).success,
  ).toBe(false);
  expect(
    traceEventViewSchema.safeParse({
      ...view,
      scope: { ...view.scope, executionOriginStoreRef: 'opaque-original' },
      attributes: {
        previousExecutionRef: 'previous-ref',
        previousExecutionOriginStoreRef: 'opaque-previous',
      },
    }).success,
  ).toBe(true);
});
