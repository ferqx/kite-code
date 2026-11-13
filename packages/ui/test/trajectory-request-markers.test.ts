import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { buildTrajectoryRequestMarkers } from '../src/desktop/trajectory/request-markers';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
  type WorkbenchRow,
} from '../src/desktop/trajectory/workbench';

function fact(sequence: number, values: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
    sequence: String(sequence),
    origin: { storeId: 'store', cursor: String(sequence) },
    sessionId: 'session',
    workspaceId: 'workspace',
    runId: 'run',
    runOriginStoreId: 'store',
    executionOriginStoreId: 'store',
    executionId: 'first',
    kind: 'model',
    phase: 'planned',
    recordedStatus: 'planned',
    occurredAt: sequence * 100,
    sourceEventType: 'execution.changed',
    sourceRecordRevision: String(sequence),
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
function request(sequence: number, executionId: string, scope: Record<string, unknown> = {}) {
  return [
    fact(sequence, {
      executionId,
      ...scope,
      evidenceRefs: [
        {
          kind: 'model_input',
          evidenceId: `input-${sequence}`,
          contentVersion: `v-${sequence}`,
          availability: 'available',
          mediaType: 'application/json',
        },
      ],
    }),
    fact(sequence + 1, {
      executionId,
      ...scope,
      phase: 'completed',
      recordedStatus: 'succeeded',
      evidenceRefs: [
        {
          kind: 'model_output',
          evidenceId: `output-${sequence}`,
          contentVersion: `v-${sequence + 1}`,
          availability: 'available',
          mediaType: 'application/json',
        },
      ],
    }),
  ];
}
function index(events: TrajectoryEvent[]) {
  const projection = projectTrajectory(events, {
    atCursor: events.at(-1)!.sequence,
    completePrefix: true,
  });
  return buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []), {
    loopParts: true,
  });
}
const markerEntries = (markers: ReturnType<typeof buildTrajectoryRequestMarkers>) =>
  [...markers].filter(([, value]) => value.marker);

test('one exact retry chain produces one request marker and consecutive logical requests share a record-order rail', () => {
  const events = [fact(1), fact(2, { phase: 'failed', recordedStatus: 'failed' })];
  for (let attempt = 2; attempt <= 4; attempt++) {
    const executionId = `retry-${attempt}`;
    events.push(
      fact(attempt * 2 - 1, {
        executionId,
        attributes: {
          previousExecutionId: attempt === 2 ? 'first' : `retry-${attempt - 1}`,
          previousExecutionOriginStoreId: 'store',
          retryAttempt: attempt,
          retryReason: 'connection_failed',
        },
      }),
    );
    events.push(
      fact(attempt * 2, {
        executionId,
        phase: attempt === 4 ? 'completed' : 'failed',
        recordedStatus: attempt === 4 ? 'succeeded' : 'failed',
        evidenceRefs: [
          {
            kind: 'model_output',
            evidenceId: `retry-output-${attempt}`,
            contentVersion: `version-${attempt}`,
            availability: attempt === 4 ? 'available' : 'partial',
            mediaType: 'application/json',
          },
        ],
      }),
    );
  }
  events.push(
    fact(9, { kind: 'tool', executionId: 'tool', attributes: { callId: 'call' } }),
    ...request(10, 'second'),
  );
  const view = filterTrajectoryWorkbench(index(events));
  const before = JSON.stringify(view.rows);
  const markers = buildTrajectoryRequestMarkers(view.rows, view.visibleRows);
  const points = markerEntries(markers);
  expect(points.map(([, value]) => value.ownerId)).toEqual(['execution:first', 'execution:second']);
  expect(points.map(([, value]) => value.requestIndex)).toEqual([1, 2]);
  expect(points[1]![1].continuation).toBe(true);
  expect(markers.get('execution:tool')).toMatchObject({
    ownerId: 'execution:first',
    marker: false,
    continuation: true,
    continuesAfter: true,
  });
  expect(view.byId.get('execution:first')?.operation?.attempts).toHaveLength(4);
  expect(JSON.stringify(view.rows)).toBe(before);
});

test('the request boundary precedes visible thinking, with the first remaining phase only as a fallback', () => {
  const source = index(request(1, 'first'));
  const all = filterTrajectoryWorkbench(source);
  expect(markerEntries(buildTrajectoryRequestMarkers(all.rows, all.visibleRows))[0]?.[0]).toBe(
    'execution:first:part:thinking',
  );
  const compact = filterTrajectoryWorkbench(source, defaultWorkbenchFilters(), [], {
    rounds: true,
    calls: false,
    subcalls: true,
  });
  const compactMarkers = markerEntries(
    buildTrajectoryRequestMarkers(compact.rows, compact.visibleRows),
  );
  expect(compactMarkers.map(([id]) => id)).toEqual(['execution:first:part:thinking']);
  const thinkingOnly = all.visibleRows.filter((row) => row.virtualPart?.kind === 'thinking');
  expect(
    markerEntries(buildTrajectoryRequestMarkers(all.rows, thinkingOnly)).map(([id]) => id),
  ).toEqual(['execution:first:part:thinking']);
  expect(thinkingOnly).toHaveLength(1);
  const withoutThinking = all.visibleRows.filter((row) => row.virtualPart?.kind !== 'thinking');
  expect(
    markerEntries(buildTrajectoryRequestMarkers(all.rows, withoutThinking)).map(([id]) => id),
  ).toEqual(['execution:first:part:system']);
  expect(
    buildTrajectoryRequestMarkers(all.rows, all.visibleRows).has('execution:first:part:system'),
  ).toBe(false);
});

test('child Run scope interrupts parent rails and a resumed parent point marks the interruption', () => {
  const view = filterTrajectoryWorkbench(
    index([
      ...request(1, 'parent-first'),
      ...request(3, 'child-request', { sessionId: 'child-session', runId: 'child-run' }),
      ...request(5, 'parent-second'),
    ]),
  );
  const markers = buildTrajectoryRequestMarkers(view.rows, view.visibleRows);
  const points = markerEntries(markers);
  expect(points.map(([, value]) => value.ownerId)).toEqual([
    'execution:parent-first',
    'execution:child-request',
    'execution:parent-second',
  ]);
  expect(points[1]![1].continuation).toBe(false);
  expect(points[1]![1].requestIndex).toBe(1);
  expect(points[2]![1]).toMatchObject({
    continuation: false,
    omittedBefore: true,
    requestIndex: 2,
  });
  const childFirstIndex = view.visibleRows.findIndex(
    (row) => row.runKey === view.byId.get('execution:child-request')?.runKey,
  );
  expect(markers.get(view.visibleRows[childFirstIndex - 1]!.id)?.continuesAfter ?? false).toBe(
    false,
  );
});

test('filtering a middle request or any intervening log phase breaks the line without inventing tool attribution', () => {
  const view = filterTrajectoryWorkbench(
    index([...request(1, 'first'), ...request(3, 'middle'), ...request(5, 'last')]),
  );
  const filtered = view.visibleRows.filter(
    (row) => row.virtualPart?.ownerId !== 'execution:middle',
  );
  const markers = buildTrajectoryRequestMarkers(view.rows, filtered);
  const last = markerEntries(markers).find(([, value]) => value.ownerId === 'execution:last')!;
  expect(last[1]).toMatchObject({ continuation: false, omittedBefore: true });
  const firstView = filterTrajectoryWorkbench(index(request(1, 'first')));
  const noThinking = firstView.visibleRows.filter((row) => row.virtualPart?.kind !== 'thinking');
  const gap = buildTrajectoryRequestMarkers(firstView.rows, noThinking);
  const reply = firstView.visibleRows.find((row) => row.virtualPart?.kind === 'reply')!;
  expect(gap.has(reply.id)).toBe(false);
});

test('missing Run proof still permits an accurate Model point but never joins a rail', () => {
  const view = filterTrajectoryWorkbench(
    index(request(1, 'first', { runId: undefined, runOriginStoreId: undefined })),
  );
  const markers = buildTrajectoryRequestMarkers(view.rows, view.visibleRows);
  expect(markerEntries(markers).map(([, value]) => value.ownerId)).toEqual(['execution:first']);
  expect([...markers.values()].every((entry) => !entry.continuation && !entry.continuesAfter)).toBe(
    true,
  );
  const unproved = view.rows.map((row) => ({ ...row, runKey: 'unproved-run' }));
  expect(
    [
      ...buildTrajectoryRequestMarkers(
        unproved,
        unproved.filter((row) => !row.presentationHidden),
      ).values(),
    ].every((entry) => !entry.continuation),
  ).toBe(true);
});

test('approval, unproved compression, administrative observations and unverified Models do not create primary request points', () => {
  const view = filterTrajectoryWorkbench(index(request(1, 'first')));
  const owner = view.byId.get('execution:first')!;
  const part = view.visibleRows.find((row) => row.virtualPart)!;
  const rows: WorkbenchRow[] = [];
  for (const [name, patch] of [
    ['approval', { category: 'approval' }],
    ['compression', { category: 'compression' }],
    ['observation', { event: owner.events[0] }],
    ['unknown', { step: { ...owner.step!, identityConfidence: 'incomplete_history' } }],
  ] as const) {
    const id = `owner-${name}`;
    rows.push({ ...owner, ...patch, id } as WorkbenchRow, {
      ...part,
      id: `${id}-part`,
      virtualPart: { ...part.virtualPart!, ownerId: id },
    });
  }
  expect(buildTrajectoryRequestMarkers(rows, rows).size).toBe(0);
});

test('default hidden administrative and structural rows do not masquerade as filtered business gaps', () => {
  const view = filterTrajectoryWorkbench(index([...request(1, 'first'), ...request(3, 'second')]));
  const insertion = view.rows.findIndex((row) => row.id === 'execution:second');
  const base = view.rows[0]!;
  const source = [
    ...view.rows.slice(0, insertion),
    { ...base, id: 'hidden-admin', category: 'administrative' as const, presentationHidden: false },
    { ...base, id: 'hidden-structure', category: 'structure' as const, presentationHidden: false },
    ...view.rows.slice(insertion),
  ];
  const markers = buildTrajectoryRequestMarkers(source, view.visibleRows);
  const second = markerEntries(markers).find(([, value]) => value.ownerId === 'execution:second')!;
  expect(second[1].continuation).toBe(true);
  expect(second[1].omittedBefore).toBeUndefined();
});

test('a logical Shell row keeps the starter Run proof when its primary command Job is Run-less', () => {
  const view = filterTrajectoryWorkbench(
    index([
      ...request(1, 'first'),
      fact(3, {
        kind: 'tool',
        executionId: 'launch',
        attributes: {
          callId: 'launch-call',
          display: {
            kind: 'shell',
            operation: 'launch',
            targetExecutionId: 'command',
            targetExecutionOriginStoreId: 'store',
          },
        },
      }),
      fact(4, {
        kind: 'job',
        executionId: 'command',
        runId: undefined,
        runOriginStoreId: undefined,
        parentExecutionId: 'launch',
        parentExecutionOriginStoreId: 'store',
        attributes: { display: { kind: 'shell', operation: 'execute' } },
      }),
      fact(5, {
        kind: 'tool',
        executionId: 'read',
        attributes: {
          callId: 'read-call',
          display: {
            kind: 'shell',
            operation: 'read',
            targetExecutionId: 'command',
            targetExecutionOriginStoreId: 'store',
          },
        },
      }),
      ...request(6, 'second'),
    ]),
  );
  const shell = view.rows.find((row) => row.operation?.type === 'shell')!;
  expect(shell.step?.runId).toBeUndefined();
  expect(shell.operation?.members).toHaveLength(3);
  const markers = buildTrajectoryRequestMarkers(view.rows, view.visibleRows);
  expect(markers.get(shell.id)).toMatchObject({
    ownerId: 'execution:first',
    marker: false,
    continuation: true,
    continuesAfter: true,
  });
  expect(markerEntries(markers)).toHaveLength(2);
});

test('a genuine compression Model request has one boundary before its existing operation, never another for adopted context', () => {
  const compression = {
    compressionId: 'compaction',
    compressionTrigger: 'automatic',
    compression: { adopted: false },
  };
  const events = [
    ...request(1, 'first'),
    fact(3, { executionId: 'compress', attributes: compression }),
    fact(4, {
      executionId: 'compress',
      phase: 'completed',
      recordedStatus: 'succeeded',
      attributes: compression,
    }),
    fact(5, {
      kind: 'context',
      executionId: 'compress',
      sourceEventType: 'context.compressed',
      phase: 'observed',
      attributes: { ...compression, compression: { adopted: true } },
    }),
    ...request(6, 'second'),
  ];
  const view = filterTrajectoryWorkbench(index(events));
  const before = JSON.stringify(view.rows);
  const markers = buildTrajectoryRequestMarkers(view.rows, view.visibleRows);
  expect(markerEntries(markers).map(([id, entry]) => [id, entry.ownerId])).toEqual([
    ['execution:first:part:thinking', 'execution:first'],
    ['execution:compress', 'execution:compress'],
    ['execution:second:part:thinking', 'execution:second'],
  ]);
  expect(markers.get('execution:compress')).toMatchObject({
    marker: true,
    continuation: true,
    continuesAfter: true,
  });
  expect(
    view.byId.get('execution:compress')?.operation?.members.map((member) => member.kind),
  ).toEqual(['model', 'context']);
  expect(JSON.stringify(view.rows)).toBe(before);
});

test('context adoption without an accurately recorded Model request never gains a request boundary', () => {
  const view = filterTrajectoryWorkbench(
    index([
      fact(1, {
        kind: 'context',
        executionId: 'unloaded-compress',
        sourceEventType: 'context.compressed',
        phase: 'observed',
        attributes: {
          compressionId: 'compaction',
          compressionTrigger: 'automatic',
          compression: { adopted: true },
        },
      }),
    ]),
  );
  expect(buildTrajectoryRequestMarkers(view.rows, view.visibleRows).size).toBe(0);
  const original = filterTrajectoryWorkbench(index(request(1, 'first')));
  const owner = original.byId.get('execution:first')!;
  const invalid = {
    ...owner,
    category: 'compression' as const,
    operation: { ...owner.operation!, type: 'compression' as const, members: [] },
  };
  expect(buildTrajectoryRequestMarkers([invalid], [invalid]).size).toBe(0);
});

test('compression transport retries and adoption share a single stable request boundary', () => {
  const compression = {
    compressionId: 'compaction',
    compressionTrigger: 'automatic',
    compression: { adopted: false },
  };
  const view = filterTrajectoryWorkbench(
    index([
      fact(1, { executionId: 'compress', attributes: compression }),
      fact(2, {
        executionId: 'compress',
        phase: 'failed',
        recordedStatus: 'failed',
        attributes: compression,
      }),
      fact(3, {
        executionId: 'compress-retry',
        attributes: {
          ...compression,
          previousExecutionId: 'compress',
          previousExecutionOriginStoreId: 'store',
          retryAttempt: 2,
          retryReason: 'connection_failed',
        },
      }),
      fact(4, {
        executionId: 'compress-retry',
        phase: 'completed',
        recordedStatus: 'succeeded',
        attributes: compression,
      }),
      fact(5, {
        kind: 'context',
        executionId: 'compress-retry',
        phase: 'observed',
        sourceEventType: 'context.compressed',
        attributes: { ...compression, compression: { adopted: true } },
      }),
    ]),
  );
  const markers = buildTrajectoryRequestMarkers(view.rows, view.visibleRows);
  expect(markerEntries(markers).map(([id]) => id)).toEqual(['execution:compress']);
  expect(view.byId.get('execution:compress')?.operation?.attempts).toHaveLength(2);
  expect(view.byId.get('execution:compress')?.events).toHaveLength(5);
});
