import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  traceEventViewSchema,
  trajectoryDisplaySchema,
  trajectoryEventSchema,
} from '../src';

const event = (sequence: string, display?: unknown) =>
  trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${sequence.padStart(64, '0')}`,
    sequence,
    origin: { storeId: 'store', cursor: sequence },
    sessionId: 'session',
    workspaceId: 'workspace',
    sourceEventType: 'execution.finished',
    sourceRecordRevision: sequence,
    kind: 'tool',
    phase: 'completed',
    recordedStatus: 'succeeded',
    occurredAt: null,
    identityConfidence: 'verified_origin',
    executionId: 'observer',
    parentExecutionId: 'model',
    attributes: display ? { display } : {},
    evidenceRefs: [],
  });

test('bounded first-party display is optional and cannot carry private material fields', () => {
  expect(event('1').attributes).toEqual({});
  for (const display of [
    { kind: 'shell', input: { command: 'private' } },
    { kind: 'model', title: 'x'.repeat(161) },
    { kind: 'web', summary: 'x'.repeat(321) },
    { kind: 'model', requestContext: { systemMessages: -1, historyMessages: 0, tools: 0 } },
    { kind: 'shell', observedStatus: 'accepted' },
  ])
    expect(trajectoryDisplaySchema.safeParse(display).success).toBe(false);
});

test('display observations project as-of without changing Execution identity, parent or source owners', () => {
  const first = event('1', {
    kind: 'shell',
    operation: 'wait',
    targetExecutionId: 'job',
    targetExecutionOriginStoreId: 'store',
    observedStatus: 'running',
    timedOut: true,
  });
  const last = event('2', {
    kind: 'shell',
    operation: 'wait',
    targetExecutionId: 'job',
    targetExecutionOriginStoreId: 'store',
    observedStatus: 'succeeded',
    exitCode: 0,
  });
  const old = projectTrajectory([first, last], { atCursor: '1' }).steps[0]!;
  const current = projectTrajectory([first, last], { atCursor: '2' }).steps[0]!;
  expect(old).toMatchObject({
    executionId: 'observer',
    parentExecutionId: 'model',
    sourceEventIds: [first.eventId],
    display: { observedStatus: 'running', timedOut: true },
  });
  expect(current).toMatchObject({
    executionId: 'observer',
    parentExecutionId: 'model',
    sourceEventIds: [first.eventId, last.eventId],
    display: { observedStatus: 'succeeded', exitCode: 0 },
  });
  expect(current.display).not.toHaveProperty('timedOut');
  current.display!.title = 'caller mutation';
  expect(first.kind === 'tool' && first.attributes.display?.title).toBeUndefined();
});

test('output presence is optional, closed and bound to an original material without body or provider fields', () => {
  const presence = {
    hasText: false,
    toolCallCount: 2,
    complete: true,
    evidenceId: 'output-ref',
    contentVersion: 'original-output-version',
  };
  for (const kind of ['model', 'message'] as const) {
    const value = {
      ...event('1'),
      kind,
      attributes:
        kind === 'message'
          ? {
              messageId: 'reply',
              role: 'assistant',
              messageSeq: '1',
              revision: '1',
              status: 'complete',
              display: { kind, outputPresence: presence },
            }
          : { display: { kind, outputPresence: presence } },
      evidenceRefs: [
        {
          kind: kind === 'message' ? 'message' : 'model_output',
          evidenceId: presence.evidenceId,
          contentVersion: presence.contentVersion,
          availability: 'available',
          mediaType: 'application/json',
        },
      ],
    };
    const parsed = trajectoryEventSchema.parse(value);
    if (parsed.kind !== 'model' && parsed.kind !== 'message') throw Error('unexpected_event_kind');
    expect(parsed.attributes.display?.outputPresence).toEqual(presence);
    const { outputPresence: _presence, ...oldDisplay } = value.attributes.display;
    expect(
      trajectoryEventSchema.safeParse({
        ...value,
        attributes: { ...value.attributes, display: oldDisplay },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...presence, toolCallCount: -1 },
      { ...presence, toolCallCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...presence, hasText: 'unknown' },
      { ...presence, complete: null },
      { ...presence, evidenceId: '' },
      { ...presence, contentVersion: '' },
      { ...presence, content: 'BODY_MUST_NOT_ENTER_INDEX' },
      { ...presence, reasoning: 'PRIVATE_THOUGHT' },
      { ...presence, reference: { path: '/private/path' } },
    ])
      expect(
        trajectoryEventSchema.safeParse({
          ...value,
          attributes: {
            ...value.attributes,
            display: { ...value.attributes.display, outputPresence: invalid },
          },
        }).success,
      ).toBe(false);
  }
});

test('output presence stays at the original cursor and is not inherited from a missing or future revision', () => {
  const make = (sequence: string, complete: boolean) =>
    trajectoryEventSchema.parse({
      ...event(sequence),
      kind: 'model',
      phase: complete ? 'completed' : 'running',
      attributes: {
        display: {
          kind: 'model',
          outputPresence: {
            hasText: false,
            toolCallCount: complete ? 2 : 0,
            complete,
            evidenceId: `output-${sequence}`,
            contentVersion: `v-${sequence}`,
          },
        },
      },
    });
  const first = make('1', false),
    last = make('2', true);
  expect(
    projectTrajectory([first, last], { atCursor: '1' }).steps[0]!.display?.outputPresence,
  ).toMatchObject({ complete: false, toolCallCount: 0, evidenceId: 'output-1' });
  expect(
    projectTrajectory([first, last], { atCursor: '2' }).steps[0]!.display?.outputPresence,
  ).toMatchObject({ complete: true, toolCallCount: 2, evidenceId: 'output-2' });
  const legacy = trajectoryEventSchema.parse({
    ...last,
    eventId: `te_${'3'.padStart(64, '0')}`,
    sequence: '3',
    attributes: { display: { kind: 'model' } },
  });
  expect(
    projectTrajectory([first, last, legacy], { atCursor: '3' }).steps[0]!.display?.outputPresence,
  ).toBeUndefined();
});

test('third-party Trace schema does not acquire display fields from the first-party schema', () => {
  for (const kind of ['model', 'tool', 'job', 'message'] as const) {
    const value = {
      schema: 'kite.trace-event-view',
      schemaVersion: 1,
      eventId: `te_${'1'.padStart(64, '0')}`,
      sequence: '1',
      origin: { storeRef: 'store', cursor: '1' },
      scope: { storeRef: 'store', sessionRef: 'session', workspaceRef: 'workspace' },
      sourceEventType: `${kind}.completed`,
      sourceRecordRevision: '1',
      kind,
      phase: 'completed',
      recordedStatus: 'succeeded',
      occurredAt: null,
      identityConfidence: 'verified_origin',
      attributes:
        kind === 'message'
          ? {
              messageRef: 'message',
              role: 'user',
              messageSeq: '1',
              revision: '1',
              status: 'complete',
            }
          : {},
      evidenceRefs: [],
    };
    expect(traceEventViewSchema.safeParse(value).success).toBe(true);
    expect(
      traceEventViewSchema.safeParse({
        ...value,
        attributes: {
          ...value.attributes,
          display: { kind: 'message', summary: 'public snippet' },
        },
      }).success,
    ).toBe(false);
  }
});

test('message snippets remain bounded first-party revisions and a later missing snippet never borrows older text', () => {
  const first = trajectoryEventSchema.parse({
    ...event('1'),
    kind: 'message',
    attributes: {
      messageId: 'message',
      role: 'assistant',
      messageSeq: '1',
      revision: '1',
      status: 'incomplete',
      display: { kind: 'message', summary: 'original public prefix' },
    },
  });
  const second = trajectoryEventSchema.parse({
    ...event('2'),
    kind: 'message',
    attributes: {
      messageId: 'message',
      role: 'assistant',
      messageSeq: '1',
      revision: '2',
      status: 'complete',
    },
  });
  expect(projectTrajectory([first, second], { atCursor: '1' }).steps[0]?.display?.summary).toBe(
    'original public prefix',
  );
  expect(projectTrajectory([first, second], { atCursor: '2' }).steps[0]).not.toHaveProperty(
    'display',
  );
  for (const display of [
    { kind: 'message', summary: 'x'.repeat(161) },
    { kind: 'message', summary: 'visible', reasoning: 'PRIVATE' },
    { kind: 'model', summary: 'wrong kind' },
  ]) {
    expect(
      trajectoryEventSchema.safeParse({ ...first, attributes: { ...first.attributes, display } })
        .success,
    ).toBe(false);
  }
});
