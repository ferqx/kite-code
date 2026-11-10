import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbench,
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
  type WorkbenchFilters,
} from '../src/desktop/trajectory/workbench';
import { trajectoryMaterialTargets } from '../src/desktop/trajectory/workbench-details';

function fact(sequence: number | string, values: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${BigInt(sequence).toString(16).padStart(64, '0')}`,
    sequence: String(sequence),
    origin: { storeId: 'store', cursor: String(sequence) },
    sessionId: 's',
    workspaceId: 'w',
    runId: 'run',
    kind: 'model',
    sourceEventType: 'execution.changed',
    sourceRecordRevision: String(sequence),
    phase: 'planned',
    recordedStatus: 'planned',
    occurredAt: Number(BigInt(sequence) % 100000n),
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
function workbench(
  events: TrajectoryEvent[],
  filters: Partial<WorkbenchFilters> = {},
  collapsed: string[] = [],
  completePrefix = true,
) {
  const projection = projectTrajectory(events, {
    atCursor: events.at(-1)?.sequence ?? '0',
    completePrefix,
  });
  return buildTrajectoryWorkbench(
    projection,
    buildTrajectoryTree(projection, []),
    { ...defaultWorkbenchFilters(), ...filters },
    collapsed,
  );
}

test('a proven automatic approval check stays one approval with exact request and result rather than Agent phases', () => {
  const binding = {
    runId: undefined,
    executionId: 'checker',
    executionOriginStoreId: 'store',
    parentExecutionId: 'requested-tool',
    parentExecutionOriginStoreId: 'store',
    attributes: {
      commandId: 'check-command',
      definitionId: 'opaque-checker-binding',
      definitionVersion: '1',
      display: {
        kind: 'model',
        operation: 'request',
        title: '模型请求',
        modelName: 'checker-model',
      },
    },
  };
  const reference = (kind: 'model_input' | 'model_output') => ({
    kind,
    evidenceId: kind,
    contentVersion: `${kind}-exact`,
    mediaType: 'application/json',
    availability: 'available' as const,
  });
  const events = [
    fact(1, { kind: 'tool', executionId: 'requested-tool', executionOriginStoreId: 'store' }),
    fact(2, {
      kind: 'command',
      runId: undefined,
      attributes: { commandId: 'check-command', commandType: 'authorization.check' },
    }),
    fact(3, { ...binding, evidenceRefs: [reference('model_input')] }),
    fact(4, { ...binding, phase: 'completed', evidenceRefs: [reference('model_output')] }),
  ];
  const original = structuredClone(events);
  const projection = projectTrajectory(events, { atCursor: '4', completePrefix: true });
  const tree = buildTrajectoryTree(projection, []);
  const index = buildTrajectoryWorkbenchIndex(projection, tree, { loopParts: true });
  const view = filterTrajectoryWorkbench(index);
  const row = view.byId.get('execution:checker')!;
  expect(row.category).toBe('approval');
  expect(row.label).toBe('自动审批检查');
  expect(row.presentationHidden).not.toBe(true);
  expect(view.visibleRows.filter((value) => value.nodeId === row.nodeId)).toHaveLength(1);
  expect(index.rows.filter((value) => value.virtualPart?.ownerId === row.id)).toEqual([]);
  expect(trajectoryMaterialTargets(row, 'preview').map((value) => value.reference)).toEqual([
    reference('model_input'),
    reference('model_output'),
  ]);
  const filtered = filterTrajectoryWorkbench(index, {
    ...defaultWorkbenchFilters(),
    types: ['approval'],
  });
  expect(filtered.matchingIds.has(row.id)).toBe(true);
  expect(tree.byId.get(row.nodeId)!.sourceEventIds).toEqual([
    events[2]!.eventId,
    events[3]!.eventId,
  ]);
  expect(events).toEqual(original);
});

test('parallel entities keep global first-observation order, real depth and exact safe observations without a raw page', () => {
  const start = 9007199254740993n;
  const events = [
    fact(String(start), { executionId: 'a' }),
    fact(String(start + 1n), { executionId: 'b' }),
    fact(String(start + 2n), { kind: 'tool', executionId: 'a-child', parentExecutionId: 'a' }),
    fact(String(start + 3n), { kind: 'tool', executionId: 'b-child', parentExecutionId: 'b' }),
    fact(String(start + 4n), { executionId: 'late-child', parentExecutionId: 'late-parent' }),
    fact(String(start + 5n), { executionId: 'late-parent' }),
    fact(String(start + 6n), { executionId: 'a', phase: 'completed' }),
  ];
  const result = workbench(events);
  expect(result.rows.filter((row) => row.matched).map((row) => row.id)).toEqual([
    'execution:a',
    'execution:b',
    'execution:a-child',
    'execution:b-child',
    'execution:late-child',
    'execution:late-parent',
  ]);
  expect(result.byId.get('execution:a-child')!.parentId).toBe('execution:a');
  expect(result.byId.get('execution:b-child')!.depth).toBe(
    result.byId.get('execution:b')!.depth + 1,
  );
  expect(result.byId.get('execution:late-child')!.parentId).toBe('execution:late-parent');
  expect(result.byId.get('execution:a')!.firstSequence).toBe(String(start));
  expect(result.byId.get('execution:a')!.events).toEqual([events[0]!, events[6]!]);
  expect(result.eventsById.size).toBe(events.length);
  expect(result.eventOwners.get(events[6]!.eventId)).toBe('execution:a');
});

test('duration records only same-clock observed intervals, including a finite ongoing lower bound', () => {
  const events = [
    fact(1, { executionId: 'finished', occurredAt: 1000 }),
    fact(2, { executionId: 'ongoing', occurredAt: 2000 }),
    fact(3, { executionId: 'single', occurredAt: 3000 }),
    fact(4, { executionId: 'reversed', occurredAt: 4000 }),
    fact(5, { executionId: 'cross', executionOriginStoreId: 'store', occurredAt: 5000 }),
    fact(6, { executionId: 'missing', occurredAt: null }),
    fact(7, { executionId: 'finished', phase: 'completed', occurredAt: 7000 }),
    fact(8, { executionId: 'ongoing', phase: 'running', occurredAt: 8000 }),
    fact(9, { executionId: 'reversed', phase: 'completed', occurredAt: 1000 }),
    fact(10, {
      executionId: 'cross',
      executionOriginStoreId: 'store',
      origin: { storeId: 'restored', cursor: '10' },
      phase: 'completed',
      occurredAt: 10000,
    }),
    fact(11, { executionId: 'missing', phase: 'completed', occurredAt: 11000 }),
    fact(12, {
      kind: 'message',
      attributes: {
        messageId: 'u',
        role: 'user',
        messageSeq: '1',
        revision: '12',
        status: 'complete',
      },
    }),
  ];
  const result = workbench(events);
  expect(result.byId.get('execution:finished')!.interval).toMatchObject({
    basis: 'planned_to_terminal',
    durationMs: 6000,
    ongoing: false,
  });
  expect(result.byId.get('execution:ongoing')!.interval).toMatchObject({
    basis: 'observed_progress',
    durationMs: 6000,
    ongoing: true,
  });
  for (const [id, reason] of [
    ['single', 'missing_boundary'],
    ['reversed', 'clock_reversed'],
    ['cross', 'cross_store'],
    ['missing', 'missing_time'],
  ] as const)
    expect(result.byId.get(`execution:${id}`)!.interval.unknownReason).toBe(reason);
  expect(workbench(events, { duration: 'observed_ge_5s' }).matchingIds).toEqual(
    new Set(['execution:finished', 'execution:ongoing']),
  );
  expect(workbench(events, { duration: 'unknown' }).matchingIds).toEqual(
    new Set(['execution:single', 'execution:reversed', 'execution:cross', 'execution:missing']),
  );
  expect(
    result.timelineDomains.some(
      (domain) => domain.unknown && domain.rows.some((row) => row.id === 'execution:cross'),
    ),
  ).toBe(true);
});

test('four filters and metadata search are AND, multiselect is OR, and explicit empty sets never relax', () => {
  const events = [
    fact(1, { executionId: 'a', runId: 'a', occurredAt: 0 }),
    fact(2, {
      kind: 'tool',
      executionId: 'needle',
      parentExecutionId: 'a',
      runId: 'a',
      occurredAt: 10,
      attributes: { definitionId: 'files.read', definitionVersion: '5' },
    }),
    fact(3, { kind: 'tool', executionId: 'other', runId: 'b', occurredAt: 20 }),
    fact(4, {
      kind: 'tool',
      executionId: 'needle',
      parentExecutionId: 'a',
      runId: 'a',
      phase: 'completed',
      occurredAt: 2010,
    }),
    fact(5, {
      kind: 'tool',
      executionId: 'other',
      runId: 'b',
      phase: 'completed',
      occurredAt: 2020,
    }),
  ];
  const run = workbench(events).runOptions.find((option) => option.runId === 'a')!.key;
  const filters: Partial<WorkbenchFilters> = {
    duration: 'observed_ge_1s',
    runKeys: [run],
    types: ['tool'],
    subcalls: 'child',
    metadataQuery: 'files.read',
  };
  const result = workbench(events, filters);
  expect(result.matchingIds).toEqual(new Set(['execution:needle']));
  expect(result.structuralIds.has('execution:a')).toBe(true);
  expect(result.byId.get('execution:a')!.structural).toBe(true);
  expect(result.counts.matched).toBe(1);
  expect(workbench(events, { ...filters, runKeys: [] }).counts.matched).toBe(0);
  expect(workbench(events, { types: [], includeAdministrative: true }).counts.matched).toBe(0);
  expect(workbench(events, { types: ['model', 'tool'] }).matchingIds.size).toBe(3);
});

test('all-events adds individual administrative observations without duplicating business lifecycles or promoting Run groups', () => {
  const events = [
    fact(1, { kind: 'run', sourceEventType: 'run.started', attributes: {} }),
    fact(2, {
      kind: 'command',
      sourceEventType: 'command.accepted',
      attributes: { commandId: 'admin', commandType: 'rename' },
    }),
    fact(3, { executionId: 'model' }),
    fact(4, {
      kind: 'command',
      sourceEventType: 'command.applied',
      attributes: { commandId: 'admin', commandType: 'rename' },
    }),
    fact(5, { executionId: 'model', phase: 'completed' }),
  ];
  const result = workbench(events, { includeAdministrative: true });
  expect(result.rows.filter((row) => row.matched).map((row) => row.firstSequence)).toEqual([
    '1',
    '2',
    '3',
    '4',
  ]);
  expect(result.rows.filter((row) => row.nodeId === 'execution:model')).toHaveLength(1);
  expect(result.byId.get('run:run')!.matched).toBe(false);
  expect(result.eventOwners.size).toBe(5);
  expect(workbench(events, { includeAdministrative: true, types: ['model'] }).matchingIds).toEqual(
    new Set(['execution:model']),
  );
});

test('active filtering expands actual ancestors without changing saved collapse or losing excluded selection data', () => {
  const events = [
    fact(1, { executionId: 'parent' }),
    fact(2, { kind: 'tool', executionId: 'needle', parentExecutionId: 'parent' }),
  ];
  const collapsed = ['execution:parent'];
  const folded = workbench(events, {}, collapsed);
  expect(folded.byId.get('execution:needle')!.hiddenByCollapse).toBe(true);
  expect(folded.visibleRows.some((row) => row.id === 'execution:needle')).toBe(false);
  const filtered = workbench(events, { metadataQuery: 'needle' }, collapsed);
  expect(filtered.visibleRows.some((row) => row.id === 'execution:needle')).toBe(true);
  expect(filtered.byId.get('execution:parent')!.matched).toBe(false);
  expect(filtered.byId.get('execution:parent')!.events).toEqual([events[0]!]);
  expect(collapsed).toEqual(['execution:parent']);
  expect(workbench(events, {}, collapsed).byId.get('execution:needle')!.hiddenByCollapse).toBe(
    true,
  );
});

test('only proved execution identities qualify as main or child calls; legacy, messages and absent-prefix roots do not', () => {
  const events = [
    fact(1, { executionId: 'root' }),
    fact(2, { executionId: 'child', parentExecutionId: 'outside' }),
    fact(3, { executionId: 'legacy', identityConfidence: 'legacy_local' }),
    fact(4, {
      kind: 'message',
      executionId: 'root',
      attributes: {
        messageId: 'reply',
        role: 'assistant',
        messageSeq: '1',
        revision: '4',
        status: 'complete',
      },
    }),
  ];
  expect(workbench(events, { subcalls: 'root' }).matchingIds).toEqual(new Set(['execution:root']));
  expect(workbench(events, { subcalls: 'child' }).matchingIds).toEqual(
    new Set(['execution:child']),
  );
  expect(workbench(events, { subcalls: 'root' }, [], false).counts.matched).toBe(0);
});

test('old index metadata remains usable without inventing times, raw events, evidence or usage', () => {
  const events = [fact(1, { executionId: 'old' })];
  const projection = projectTrajectory(events, { atCursor: '1', completePrefix: true });
  delete projection.eventIndex;
  delete projection.completePrefix;
  const result = buildTrajectoryWorkbench(projection, buildTrajectoryTree(projection, []));
  expect(result.matchingIds).toEqual(new Set(['execution:old']));
  const row = result.byId.get('execution:old')!;
  expect(row.events).toEqual([]);
  expect(row.positionAt).toBeUndefined();
  expect(row.interval.unknownReason).toBe('incomplete_history');
  expect(row.subcall).toBe('unknown');
});

test('a clock reset in another entity invalidates later alignment, while earlier bounded observations remain usable', () => {
  const result = workbench([
    fact(1, { executionId: 'before', occurredAt: 100 }),
    fact(2, { executionId: 'before', phase: 'completed', occurredAt: 200 }),
    fact(3, { executionId: 'spanning', occurredAt: 300 }),
    fact(4, { executionId: 'reset', occurredAt: 50 }),
    fact(5, { executionId: 'spanning', phase: 'completed', occurredAt: 400 }),
    fact(6, { executionId: 'after', occurredAt: 500 }),
  ]);
  expect(result.byId.get('execution:before')!.interval.durationMs).toBe(100);
  expect(result.byId.get('execution:spanning')!.interval.unknownReason).toBe('clock_reversed');
  expect(result.byId.get('execution:after')!.positionAt).toBeUndefined();
  expect(
    result.timelineDomains.find((domain) => domain.unknown)!.rows.map((row) => row.id),
  ).toEqual(['execution:spanning', 'execution:reset', 'execution:after']);
});

test('legacy labels stay explicit and auxiliary title subtrees participate only in the all-category administrative view', () => {
  const events = [
    fact(1, {
      executionId: 'title',
      attributes: { definitionId: 'builtin.session-title/generate' },
    }),
    fact(2, { kind: 'tool', executionId: 'title-child', parentExecutionId: 'title' }),
    fact(3, {
      kind: 'unknown',
      runId: undefined,
      sourceEventType: 'message.updated',
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
  ];
  expect(workbench(events).counts.matched).toBe(0);
  const full = workbench(events, { includeAdministrative: true });
  expect(full.counts.matched).toBe(3);
  expect(full.rows.find((row) => row.kind === 'unknown')!.label).toBe('旧记录 · message.updated');
  expect(workbench(events, { includeAdministrative: true, types: ['model'] }).counts.matched).toBe(
    0,
  );
});

test('ten thousand nested calls filter and flatten iteratively without recursive ancestor copying', () => {
  const events = Array.from({ length: 10000 }, (_, index) =>
    fact(index + 1, {
      executionId: `deep-${index}`,
      ...(index ? { parentExecutionId: `deep-${index - 1}` } : {}),
    }),
  );
  const result = workbench(events, { metadataQuery: 'deep-9999' }, ['execution:deep-0']);
  expect(result.counts.matched).toBe(1);
  expect(result.byId.get('execution:deep-9999')!.depth).toBe(10001);
  expect(result.visibleRows.length).toBe(10002);
  expect(result.eventOwners.size).toBe(10000);
});

test('repeated filters share the safe prefix index and never mutate earlier results or original collapsed metadata', () => {
  const events = [
    fact(1, { executionId: 'a' }),
    fact(2, { kind: 'tool', executionId: 'b', parentExecutionId: 'a' }),
  ];
  const projection = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  const index = buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []));
  const first = filterTrajectoryWorkbench(index);
  const second = filterTrajectoryWorkbench(index, {
    ...defaultWorkbenchFilters(),
    metadataQuery: 'execution:b',
  });
  expect(first.byId.get('execution:a')!.matched).toBe(true);
  expect(second.byId.get('execution:a')!.matched).toBe(false);
  expect(index.rows.find((row) => row.id === 'execution:a')!.matched).toBe(false);
  expect(first.eventsById).toBe(second.eventsById);
  expect(first.byId.get('execution:b')!.events).toBe(second.byId.get('execution:b')!.events);
});
