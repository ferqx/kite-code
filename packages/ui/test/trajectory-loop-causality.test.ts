import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  filterTrajectoryWorkbench,
} from '../src/desktop/trajectory/workbench';
import { trajectoryMaterialTargets } from '../src/desktop/trajectory/workbench-details';

function fact(sequence: number, values: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
    sequence: String(sequence),
    origin: { storeId: 'store', cursor: String(sequence) },
    sessionId: 's',
    workspaceId: 'w',
    runId: 'run',
    runOriginStoreId: 'store',
    executionOriginStoreId: 'store',
    executionId: 'model',
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
const reference = (kind: 'model_input' | 'model_output', version: string) => ({
  kind,
  evidenceId: `${kind}-${version}`,
  contentVersion: version,
  mediaType: 'application/json',
  availability: 'available',
});
function records(message: Record<string, unknown> = {}) {
  return [
    fact(127, { kind: 'tool', executionId: 'previous-tool', phase: 'completed' }),
    fact(128, { evidenceRefs: [reference('model_input', 'planned')] }),
    fact(129, { phase: 'dispatching', evidenceRefs: [reference('model_input', 'dispatch')] }),
    fact(130, {
      kind: 'message',
      phase: 'running',
      attributes: {
        messageId: 'canonical',
        role: 'assistant',
        messageSeq: '26',
        revision: '130',
        status: 'incomplete',
      },
      ...message,
    }),
    fact(131, { kind: 'tool', executionId: 'interleaved-tool', phase: 'completed' }),
    fact(132, {
      kind: 'job',
      executionId: 'independent-child',
      attributes: { childSessionId: 'child' },
      phase: 'running',
    }),
    fact(133, {
      kind: 'message',
      phase: 'completed',
      attributes: {
        messageId: 'canonical',
        role: 'assistant',
        messageSeq: '26',
        revision: '133',
        status: 'complete',
      },
      ...message,
    }),
    fact(134, {
      phase: 'completed',
      evidenceRefs: [reference('model_input', 'complete'), reference('model_output', 'complete')],
    }),
  ];
}
function view(events: TrajectoryEvent[], atCursor = '134') {
  const projection = projectTrajectory(events, { atCursor, completePrefix: true });
  const tree = buildTrajectoryTree(projection, []);
  return {
    projection,
    tree,
    result: filterTrajectoryWorkbench(
      buildTrajectoryWorkbenchIndex(projection, tree, { loopParts: true }),
    ),
  };
}

test('real stream order 128 plan → 130 canonical message → 134 model completion keeps request phases before the exact reply', () => {
  const events = records(),
    original = structuredClone(events),
    { tree, result } = view(events);
  const ids = result.visibleRows.map((row) => row.id);
  expect(ids.indexOf('execution:model:part:system')).toBeLessThan(ids.indexOf('message:canonical'));
  expect(ids.indexOf('execution:model:part:thinking')).toBeLessThan(
    ids.indexOf('message:canonical'),
  );
  expect(ids.filter((id) => !id.includes(':part:'))).toEqual([
    'session',
    'group:run:["store","s","run"]',
    'execution:previous-tool',
    'message:canonical',
    'execution:interleaved-tool',
    'execution:independent-child',
  ]);
  const message = result.byId.get('message:canonical')!;
  expect(message.firstSequence).toBe('130');
  expect(message.lastSequence).toBe('133');
  expect(tree.byId.get(message.nodeId)?.parentId).toBe('execution:model');
  expect(message.originalParentId).toBe('execution:model');
  expect(result.byId.get('execution:model:part:reply')?.presentationHidden).toBe(true);
  expect(
    trajectoryMaterialTargets(result.byId.get('execution:model:part:system')!, 'system_prompt').map(
      (target) => [target.event.sequence, target.reference.contentVersion],
    ),
  ).toEqual([['134', 'complete']]);
  expect(
    trajectoryMaterialTargets(result.byId.get('execution:model:part:thinking')!, 'thinking').map(
      (target) => [target.event.sequence, target.reference.contentVersion],
    ),
  ).toEqual([['134', 'complete']]);
  expect(events).toEqual(original);
});

test('unknown, unassociated and cross-scope messages never acquire an inferred presentation dependency', () => {
  for (const message of [
    { executionId: undefined },
    { executionId: 'different-model' },
    { executionOriginStoreId: 'different-store' },
    { sessionId: 'different-session' },
    { runId: 'different-run' },
    { runOriginStoreId: 'different-run-store' },
    { identityConfidence: 'legacy_local' },
  ]) {
    const { result } = view(records(message));
    const ids = result.rows.map((row) => row.id);
    const canonical = result.rows.find(
      (row) => row.kind === 'message' && row.step?.messageId === 'canonical',
    )!;
    expect(ids.indexOf(canonical.id)).toBeLessThan(ids.indexOf('execution:model:part:thinking'));
    expect(canonical.firstSequence).toBe('130');
  }
});

test('fixed historical prefix and exact old input targets remain unchanged when later completion arrives', () => {
  const events = records();
  const prefix = view(events, '130').result;
  const current = view(events).result;
  expect(prefix.byId.get('message:canonical')?.step?.messageStatus).toBe('incomplete');
  expect(prefix.byId.get('execution:model:part:thinking')?.virtualPart?.targets).toEqual([]);
  expect(
    trajectoryMaterialTargets(
      current.byId.get('execution:model:part:system')!,
      'system_prompt',
      events[2]!.eventId,
    ).map((target) => [target.event.sequence, target.reference.contentVersion]),
  ).toEqual([['129', 'dispatch']]);
  expect(
    prefix.byId.get('execution:model:part:system')?.virtualPart?.targets[0]?.reference
      .contentVersion,
  ).toBe('dispatch');
});
