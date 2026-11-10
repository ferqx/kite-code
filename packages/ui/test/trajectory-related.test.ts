import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import {
  composeTrajectoryScopes,
  trajectoryChildScopeTarget,
} from '../src/desktop/trajectory/related';
import { buildTrajectoryTree, trajectoryNodeEventIds } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
} from '../src/desktop/trajectory/workbench';

function event(sequence: number, values: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
    sequence: String(sequence),
    origin: { storeId: 'store', cursor: String(sequence) },
    sessionId: 'parent',
    workspaceId: 'w',
    runId: 'parent-run',
    runOriginStoreId: 'store',
    executionOriginStoreId: 'store',
    kind: 'model',
    sourceEventType: 'execution.changed',
    sourceRecordRevision: String(sequence),
    phase: 'planned',
    recordedStatus: 'planned',
    occurredAt: sequence * 100,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
const project = (events: TrajectoryEvent[], atCursor = '20') =>
  projectTrajectory(events, { atCursor, completePrefix: true });
function fixture() {
  const parent = project([
    event(1, { executionId: 'model' }),
    event(2, {
      kind: 'tool',
      executionId: 'spawn',
      parentExecutionId: 'model',
      parentExecutionOriginStoreId: 'store',
      attributes: {
        display: {
          kind: 'task',
          operation: 'spawn',
          targetExecutionId: 'carrier',
          targetExecutionOriginStoreId: 'store',
          targetSessionId: 'child',
          targetRunId: 'child-run',
        },
      },
    }),
    event(3, {
      kind: 'job',
      executionId: 'carrier',
      parentExecutionId: 'spawn',
      parentExecutionOriginStoreId: 'store',
      attributes: {
        childSessionId: 'child',
        display: {
          kind: 'task',
          operation: 'spawn',
          targetExecutionId: 'carrier',
          targetExecutionOriginStoreId: 'store',
          targetSessionId: 'child',
          targetRunId: 'child-run',
        },
      },
    }),
    event(10, { executionId: 'model', phase: 'completed' }),
  ]);
  const child = project([
    event(4, {
      kind: 'message',
      sessionId: 'child',
      runId: 'child-run',
      attributes: {
        messageId: 'prompt',
        role: 'user',
        messageSeq: '1',
        revision: '4',
        status: 'complete',
      },
    }),
    event(5, { sessionId: 'child', runId: 'child-run', executionId: 'model' }),
    event(6, {
      sessionId: 'child',
      runId: 'child-run',
      kind: 'tool',
      executionId: 'read',
      parentExecutionId: 'model',
      parentExecutionOriginStoreId: 'store',
    }),
    event(7, {
      sessionId: 'child',
      runId: 'child-run',
      kind: 'message',
      executionId: 'model',
      attributes: {
        messageId: 'reply',
        role: 'assistant',
        messageSeq: '2',
        revision: '7',
        status: 'complete',
      },
    }),
  ]);
  return { parent, child };
}

test('read targets require a current exact carrier rather than a persisted selection or conflicting claim', () => {
  const { parent } = fixture(),
    tree = buildTrajectoryTree(parent, []);
  expect(trajectoryChildScopeTarget(parent, tree, 'execution:carrier')).toEqual({
    parentNodeId: 'execution:carrier',
    sessionId: 'child',
    runId: 'child-run',
    carrierExecutionId: 'carrier',
  });
  expect(trajectoryChildScopeTarget(parent, tree, 'missing-carrier')).toBeNull();
  expect(trajectoryChildScopeTarget(parent, tree, 'execution:spawn')).toBeNull();
  expect(trajectoryChildScopeTarget(null, tree, 'execution:carrier')).toBeNull();
  const changedSession = project(
    parent.eventIndex!.map((value) =>
      value.kind === 'job'
        ? {
            ...value,
            attributes: { ...value.attributes, childSessionId: 'another-child' },
          }
        : value,
    ),
  );
  expect(
    trajectoryChildScopeTarget(
      changedSession,
      buildTrajectoryTree(changedSession, []),
      'execution:carrier',
    ),
  ).toBeNull();
  const conflictedRun = project([
    ...parent.eventIndex!,
    event(11, {
      kind: 'child',
      executionId: 'carrier',
      attributes: {
        carrierExecutionId: 'carrier',
        childSessionId: 'child',
        childRunId: 'another-run',
      },
    }),
  ]);
  expect(
    trajectoryChildScopeTarget(
      conflictedRun,
      buildTrajectoryTree(conflictedRun, []),
      'execution:carrier',
    ),
  ).toBeNull();
  const missingOrigin = project(
    parent.eventIndex!.map((value) =>
      value.executionId === 'carrier' ? { ...value, executionOriginStoreId: undefined } : value,
    ),
  );
  expect(
    trajectoryChildScopeTarget(
      missingOrigin,
      buildTrajectoryTree(missingOrigin, []),
      'execution:carrier',
    ),
  ).toBeNull();
  const futureOnly = {
    ...parent,
    eventIndex: parent.eventIndex!.map((value) =>
      value.kind === 'job' ? { ...value, sequence: '21' } : value,
    ),
  };
  expect(trajectoryChildScopeTarget(futureOnly, tree, 'execution:carrier')).toBeNull();
});

test('authorized child fixed scopes compose under their exact carrier with namespaced display ids and chronological facts', () => {
  const { parent, child } = fixture(),
    before = JSON.stringify({ parent, child });
  const result = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: child },
  ]);
  expect(JSON.stringify({ parent, child })).toBe(before);
  expect(result.projection?.atCursor).toBe('20');
  expect(result.projection?.eventIndex?.map((value) => value.sequence)).toEqual([
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '10',
  ]);
  expect(trajectoryNodeEventIds(result.tree.root)).toEqual(result.projection!.sourceEventIds);
  const childModel = [...result.tree.byId.values()].find(
    (node) => node.step?.sessionId === 'child' && node.kind === 'model',
  )!;
  expect(childModel.id).not.toBe('execution:model');
  expect(childModel.step?.executionId).toBe('model');
  expect(childModel.step?.sessionId).toBe('child');
  const childRoot = result.tree.byId.get(result.tree.byId.get(childModel.parentId!)!.parentId!)!;
  expect(childRoot.label).toBe('子 Agent 执行');
  expect(childRoot.parentId).toBe('execution:carrier');
  const prefix = buildTrajectoryWorkbenchIndex(result.projection, result.tree);
  const open = filterTrajectoryWorkbench(prefix, defaultWorkbenchFilters(), [], {
    rounds: true,
    calls: true,
    subcalls: true,
  });
  expect(open.rows.filter((row) => row.kind === 'model')).toHaveLength(2);
  expect(open.visibleRows.some((row) => row.id === childModel.id)).toBe(true);
  expect(open.rows.filter((row) => row.operation?.type === 'child')).toHaveLength(1);
  const closed = filterTrajectoryWorkbench(prefix, defaultWorkbenchFilters(), [], {
    rounds: true,
    calls: true,
    subcalls: false,
  });
  expect(closed.byId.get(childModel.id)?.hiddenByCollapse).toBe(true);
  expect(closed.byId.get(childModel.id)?.collapsedById).toBe('execution:spawn');
  const childPrompt = closed.rows.find((row) => row.step?.messageId === 'prompt')!;
  expect(childPrompt.hiddenByCollapse).toBe(true);
});

test('future, foreign sessions, wrong runs and mismatched fixed cursors do not become child rows', () => {
  const { parent, child } = fixture();
  const cases = [
    { ...child, atCursor: '21' },
    project([event(5, { sessionId: 'other', runId: 'child-run', executionId: 'x' })]),
    project([event(5, { sessionId: 'child', runId: 'wrong-run', executionId: 'x' })]),
    {
      ...project([event(21, { sessionId: 'child', runId: 'child-run', executionId: 'x' })], '21'),
      atCursor: '20',
    },
  ];
  for (const projection of cases) {
    const result = composeTrajectoryScopes(parent, [
      { parentNodeId: 'execution:carrier', projection },
    ]);
    expect(result.projection).toBe(parent);
    expect(
      [...result.tree.byId.values()].some(
        (node) => node.step?.sessionId !== undefined && node.step.sessionId !== 'parent',
      ),
    ).toBe(false);
    expect(result.tree.byId.get('execution:carrier')?.relationNotice).toContain('尚未核实');
  }
});

test('duplicate scope reads are idempotent and reused event or sequence identities are rejected', () => {
  const { parent, child } = fixture(),
    entry = { parentNodeId: 'execution:carrier', projection: child };
  const duplicated = composeTrajectoryScopes(parent, [entry, entry]);
  expect(duplicated.projection?.eventIndex).toHaveLength(8);
  const reused = project([
    event(2, { sessionId: 'child', runId: 'child-run', executionId: 'different' }),
  ]);
  const rejected = composeTrajectoryScopes(parent, [{ ...entry, projection: reused }]);
  expect(rejected.projection).toBe(parent);
  expect(rejected.tree.byId.get('execution:carrier')?.relationNotice).toContain('身份冲突');
  const alteredId = {
    ...reused,
    eventIndex: reused.eventIndex!.map((value) => ({ ...value, eventId: `te_${'f'.repeat(64)}` })),
  };
  expect(composeTrajectoryScopes(parent, [{ ...entry, projection: alteredId }]).projection).toBe(
    parent,
  );
});

test('ambiguous carriers and same-prefix conflicting scope reads never select an arbitrary parent', () => {
  const { parent, child } = fixture();
  const secondCarrier = event(11, {
    kind: 'job',
    executionId: 'other-carrier',
    attributes: {
      childSessionId: 'child',
      display: { kind: 'task', operation: 'spawn', targetRunId: 'child-run' },
    },
  });
  const ambiguousParent = project([...parent.eventIndex!, secondCarrier]);
  const result = composeTrajectoryScopes(ambiguousParent, [
    { parentNodeId: 'execution:carrier', projection: child },
    { parentNodeId: 'execution:other-carrier', projection: child },
  ]);
  expect(result.projection).toBe(ambiguousParent);
  expect(result.tree.byId.get('execution:carrier')?.relationNotice).toContain('多个承载');
  expect(result.tree.byId.get('execution:other-carrier')?.relationNotice).toContain('多个承载');
  const conflict = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: child },
    { parentNodeId: 'execution:carrier', projection: project(child.eventIndex!.slice(0, 2)) },
  ]);
  expect(conflict.projection).toBe(parent);
  expect(conflict.tree.byId.get('execution:carrier')?.relationNotice).toContain('记录冲突');
});

test('restored submission stores never substitute for original carrier and child Run namespaces', () => {
  const { parent, child } = fixture();
  const foreignRun = project(
    child.eventIndex!.map((value) => ({ ...value, runOriginStoreId: 'foreign-original' })),
  );
  const refused = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: foreignRun },
  ]);
  expect(refused.projection).toBe(parent);
  const restoredParent = project(
    parent.eventIndex!.map((value) => ({
      ...value,
      origin: { ...value.origin, storeId: 'restored-submission' },
    })),
  );
  const restoredChild = project(
    child.eventIndex!.map((value) => ({
      ...value,
      origin: { ...value.origin, storeId: 'restored-submission' },
      ...(value.kind === 'model' || value.kind === 'tool'
        ? { executionOriginStoreId: 'restored-submission' }
        : {}),
    })),
  );
  const before = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: child },
  ]);
  const after = composeTrajectoryScopes(restoredParent, [
    { parentNodeId: 'execution:carrier', projection: restoredChild },
  ]);
  expect(after.projection?.steps).toHaveLength(before.projection!.steps.length);
  expect([...after.tree.byId.keys()]).toEqual([...before.tree.byId.keys()]);
  const missingOrigin = project(
    parent.eventIndex!.map((value) =>
      value.executionId === 'carrier' ? { ...value, executionOriginStoreId: undefined } : value,
    ),
  );
  expect(
    composeTrajectoryScopes(missingOrigin, [
      { parentNodeId: 'execution:carrier', projection: child },
    ]).projection,
  ).toBe(missingOrigin);
  const wrongSession = project(
    parent.eventIndex!.map((value) =>
      value.kind === 'job'
        ? {
            ...value,
            attributes: {
              ...value.attributes,
              display: { ...value.attributes.display!, targetSessionId: 'other-child' },
            },
          }
        : value,
    ),
  );
  expect(
    composeTrajectoryScopes(wrongSession, [
      { parentNodeId: 'execution:carrier', projection: child },
    ]).projection,
  ).toBe(wrongSession);
});

test('an admitted child scope resolves only its exact original external carrier notice without changing its stored parent', () => {
  const { parent } = fixture();
  const child = project([
    event(5, {
      sessionId: 'child',
      runId: 'child-run',
      kind: 'tool',
      executionId: 'read',
      parentExecutionId: 'carrier',
      parentExecutionOriginStoreId: 'store',
    }),
  ]);
  const original = structuredClone(child);
  const separate = buildTrajectoryTree(child, []);
  expect(separate.byId.get('execution:read')?.relationNotice).toContain('原关联执行不在当前范围内');
  const combined = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: child },
  ]);
  const imported = [...combined.tree.byId.values()].find(
    (node) => node.step?.sessionId === 'child' && node.step?.executionId === 'read',
  )!;
  expect(imported.relationNotice).toBeUndefined();
  expect(imported.step?.parentExecutionId).toBe('carrier');
  expect(imported.step?.parentExecutionOriginStoreId).toBe('store');
  expect(imported.parentId).not.toBe('execution:carrier');
  expect(combined.tree.byId.get(imported.parentId!)?.kind).toBe('run');
  expect(child).toEqual(original);
  expect(separate.byId.get('execution:read')?.relationNotice).toContain('原关联执行不在当前范围内');
});

test('other, foreign, legacy and ambiguous local parents retain the missing-parent warning after scope admission', () => {
  const { parent } = fixture();
  for (const change of [
    { parentExecutionId: 'other-carrier' },
    { parentExecutionOriginStoreId: 'other-store' },
    { identityConfidence: 'legacy_local' },
    { runId: undefined },
  ]) {
    const child = project([
      event(5, {
        sessionId: 'child',
        runId: 'child-run',
        kind: 'tool',
        executionId: 'read',
        parentExecutionId: 'carrier',
        parentExecutionOriginStoreId: 'store',
        ...change,
      }),
    ]);
    const combined = composeTrajectoryScopes(parent, [
      { parentNodeId: 'execution:carrier', projection: child },
    ]);
    const imported = [...combined.tree.byId.values()].find(
      (node) => node.step?.sessionId === 'child' && node.step?.executionId === 'read',
    )!;
    expect(imported.relationNotice).toContain('原关联执行不在当前范围内');
  }
  const local = project([
    event(4, { sessionId: 'child', runId: 'child-run', kind: 'model', executionId: 'carrier' }),
    event(5, {
      sessionId: 'child',
      runId: 'child-run',
      kind: 'tool',
      executionId: 'duplicate-carrier',
    }),
    event(6, {
      sessionId: 'child',
      runId: 'child-run',
      kind: 'tool',
      executionId: 'read',
      parentExecutionId: 'carrier',
      parentExecutionOriginStoreId: 'store',
    }),
  ]);
  // Defensive older/ambiguous indexes may retain two object nodes claiming one identity.
  const child = {
    ...local,
    steps: local.steps.map((step) =>
      step.executionId === 'duplicate-carrier' ? { ...step, executionId: 'carrier' } : step,
    ),
  };
  const combined = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: child },
  ]);
  const imported = [...combined.tree.byId.values()].find(
    (node) => node.step?.sessionId === 'child' && node.step?.executionId === 'read',
  )!;
  expect(imported.relationNotice).toContain('原关联执行不在当前范围内');
});
