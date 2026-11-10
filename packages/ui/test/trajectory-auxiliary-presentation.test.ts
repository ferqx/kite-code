import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import {
  buildTrajectoryTree,
  filterTrajectoryTree,
  trajectoryNodeEventIds,
} from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
} from '../src/desktop/trajectory/workbench';
import { trajectoryMaterialTargets } from '../src/desktop/trajectory/workbench-details';

function fact(sequence: number, extra: Record<string, unknown> = {}): TrajectoryEvent {
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
    kind: 'tool',
    executionId: 'worktree',
    phase: 'completed',
    recordedStatus: 'succeeded',
    sourceEventType: 'execution.completed',
    sourceRecordRevision: String(sequence),
    occurredAt: sequence * 100,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...extra,
  });
}
const parent = () =>
  fact(1, {
    attributes: {
      definitionId: 'git.worktree',
      definitionVersion: '1',
      display: { kind: 'worktree', operation: 'create', title: 'Git 工作树' },
    },
  });
const job = (extra: Record<string, unknown> = {}) =>
  fact(2, {
    kind: 'job',
    executionId: 'query',
    parentExecutionId: 'worktree',
    parentExecutionOriginStoreId: 'store',
    attributes: { definitionId: 'shell.command', definitionVersion: '1' },
    ...extra,
  });
function inspect(events: TrajectoryEvent[]) {
  const projection = projectTrajectory(events, {
    atCursor: events.at(-1)!.sequence,
    completePrefix: true,
  });
  const tree = buildTrajectoryTree(projection, []);
  const index = buildTrajectoryWorkbenchIndex(projection, tree, { loopParts: true });
  return {
    tree,
    view: filterTrajectoryWorkbench(index),
    full: filterTrajectoryWorkbench(index, {
      ...defaultWorkbenchFilters(),
      includeAdministrative: true,
    }),
  };
}

test('only completed successful first-party support Jobs covered by the exact successful Tool leave the default business view', () => {
  for (const [id, kind, child] of [
    ['git.worktree', 'worktree', 'shell.command'],
    ['browser.open', 'browser', 'browser.session'],
    ['browser.execute', 'browser', 'browser.code_session'],
  ] as const) {
    const events = [
      fact(1, {
        attributes: {
          definitionId: id,
          definitionVersion: '1',
          display: {
            kind,
            operation: kind === 'worktree' ? 'create' : id === 'browser.open' ? 'open' : 'execute',
          },
        },
      }),
      job({ attributes: { definitionId: child, definitionVersion: '1' } }),
    ];
    const before = JSON.stringify(events);
    const { tree, view, full } = inspect(events);
    expect(view.visibleRows.some((row) => row.id === 'execution:query')).toBe(false);
    expect(view.byId.has('execution:query')).toBe(true);
    expect(full.visibleRows.some((row) => row.id === 'execution:query')).toBe(true);
    expect(view.byId.get('execution:query')?.operation?.members[0]?.events[0]?.eventId).toBe(
      events[1]!.eventId,
    );
    expect(view.rows.find((row) => row.kind === 'run')?.summary?.tool).toBe(1);
    expect(trajectoryNodeEventIds(tree.root)).toEqual(events.map((event) => event.eventId));
    expect(JSON.stringify(events)).toBe(before);
  }
});

test('running, failed, cancelled, unknown and unproved support Jobs remain readable business records', () => {
  const variants = [
    ...['running', 'failed', 'cancelled', 'outcome_unknown'].map((phase) =>
      job({ phase, recordedStatus: phase }),
    ),
    job({ identityConfidence: 'legacy_local' }),
    job({ parentExecutionOriginStoreId: 'foreign' }),
    job({ parentExecutionId: 'absent' }),
    job({ runId: 'another-run' }),
    job({
      attributes: {
        definitionId: 'shell.command',
        definitionVersion: '1',
        childSessionId: 'child',
      },
    }),
    job({ attributes: { definitionId: 'shell.command', definitionVersion: '2' } }),
  ];
  for (const child of variants)
    expect(
      inspect([parent(), child]).view.visibleRows.some((row) => row.id === 'execution:query'),
    ).toBe(true);
  for (const changed of [
    fact(1, { phase: 'failed', recordedStatus: 'failed', attributes: parent().attributes }),
    fact(1, { attributes: { definitionId: 'git.worktree', definitionVersion: '1' } }),
    fact(1, {
      attributes: {
        definitionId: 'other.worktree',
        definitionVersion: '1',
        display: { kind: 'worktree', operation: 'create' },
      },
    }),
  ])
    expect(
      inspect([changed, job()]).view.visibleRows.some((row) => row.id === 'execution:query'),
    ).toBe(true);
});

test('an exact runless authorization.check remains one approval row, without fictitious conversation stages or losing a real human card', () => {
  const events = [
    parent(),
    fact(2, {
      kind: 'command',
      executionId: undefined,
      runId: undefined,
      attributes: { commandId: 'check-command', commandType: 'authorization.check' },
    }),
    fact(3, {
      kind: 'model',
      executionId: 'check',
      runId: undefined,
      phase: 'failed',
      recordedStatus: 'failed',
      parentExecutionId: 'worktree',
      parentExecutionOriginStoreId: 'store',
      attributes: {
        commandId: 'check-command',
        definitionId: 'opaque-model',
        definitionVersion: '1',
      },
    }),
    fact(4, {
      kind: 'interaction',
      executionId: 'worktree',
      attributes: {
        interactionId: 'human',
        interactionKind: 'approval',
        revision: '1',
        decision: 'requested',
      },
    }),
  ];
  const { tree, view } = inspect(events);
  expect(tree.byId.get('execution:check')?.approvalCheck).toBe(true);
  expect(filterTrajectoryTree(tree.root, 'key_steps').visibleNodeIds.has('execution:check')).toBe(
    true,
  );
  expect(
    view.visibleRows.some((row) => row.id === 'execution:check' && row.category === 'approval'),
  ).toBe(true);
  expect(view.rows.some((row) => row.virtualPart?.ownerId === 'execution:check')).toBe(false);
  expect(view.visibleRows.some((row) => row.id === 'interaction:human')).toBe(true);
  expect(trajectoryNodeEventIds(tree.root)).toEqual(events.map((event) => event.eventId));
  for (const extra of [
    { runId: 'run' },
    { parentExecutionOriginStoreId: 'foreign' },
    { identityConfidence: 'legacy_local' },
    { attributes: { commandId: 'not-the-check', definitionId: 'opaque-model' } },
  ]) {
    expect(
      inspect([events[0]!, events[1]!, fact(3, { ...events[2], ...extra })]).tree.byId.get(
        'execution:check',
      )?.approvalCheck,
    ).toBeUndefined();
  }
});

test('owner-sealed review classifies a proven runless checker without a separate Command event and preserves exact materials', () => {
  const input = {
    kind: 'model_input' as const,
    evidenceId: 'check-input',
    contentVersion: 'input-v1',
    availability: 'available' as const,
    mediaType: 'application/json',
  };
  const output = {
    ...input,
    kind: 'model_output' as const,
    evidenceId: 'check-output',
    contentVersion: 'output-v1',
  };
  const check = fact(2, {
    kind: 'model',
    executionId: 'check',
    runId: undefined,
    runOriginStoreId: undefined,
    parentExecutionId: 'worktree',
    parentExecutionOriginStoreId: 'store',
    attributes: {
      commandId: 'check-command-without-fact',
      definitionId: 'opaque-checker',
      display: { kind: 'model', operation: 'review' },
    },
    evidenceRefs: [input, output],
  });
  for (const kind of ['tool', 'job'] as const) {
    const originalParent = fact(1, {
      kind,
      attributes: {
        definitionId: 'shell.command',
        display: { kind: 'shell', operation: 'execute' },
      },
    });
    const events = [originalParent, check];
    const saved = JSON.stringify(events);
    const { tree, view } = inspect(events);
    expect(events.some((event) => event.kind === 'command')).toBe(false);
    expect(tree.byId.get('execution:check')?.approvalCheck).toBe(true);
    const row = view.byId.get('execution:check')!;
    expect(row.category).toBe('approval');
    expect(row.label).toBe('自动审批检查');
    expect(view.visibleRows.filter((item) => item.id === row.id)).toHaveLength(1);
    expect(view.rows.some((item) => item.virtualPart?.ownerId === row.id)).toBe(false);
    expect(
      trajectoryMaterialTargets(row, 'preview').map((target) => [
        target.event.eventId,
        target.reference,
      ]),
    ).toEqual([
      [check.eventId, input],
      [check.eventId, output],
    ]);
    expect(trajectoryNodeEventIds(tree.root)).toEqual(events.map((event) => event.eventId));
    expect(JSON.stringify(events)).toBe(saved);
  }
  const safeParent = parent();
  const invalid = [
    [check],
    [{ ...safeParent, identityConfidence: 'legacy_local' as const }, check],
    [
      {
        ...safeParent,
        origin: { storeId: 'foreign', cursor: '1' },
        executionOriginStoreId: 'foreign',
      },
      check,
    ],
    [safeParent, { ...check, identityConfidence: 'legacy_local' as const }],
    [safeParent, { ...check, parentExecutionId: 'not-the-parent' }],
    [safeParent, { ...check, parentExecutionOriginStoreId: 'foreign' }],
    [safeParent, { ...check, executionOriginStoreId: 'foreign' }],
    [safeParent, { ...check, sessionId: 'other-session' }],
    [safeParent, { ...check, runId: 'run', runOriginStoreId: 'store' }],
    [
      safeParent,
      fact(2, {
        ...check,
        attributes: {
          definitionId: 'authorization.check',
          display: {
            kind: 'model',
            operation: 'request',
            requestContext: { systemMessages: 1, historyMessages: 1, tools: 0 },
          },
        },
      }),
    ],
  ];
  for (const events of invalid)
    expect(inspect(events).tree.byId.get('execution:check')?.approvalCheck).toBeUndefined();
});

test('absent phase materials produce only the thought representative, preserving failed and unknown executions', () => {
  for (const phase of ['completed', 'failed', 'outcome_unknown'] as const) {
    const { view } = inspect([
      fact(1, { kind: 'model', executionId: 'model', phase, recordedStatus: phase }),
    ]);
    expect(
      view.visibleRows.filter((row) => row.virtualPart).map((row) => row.virtualPart!.kind),
    ).toEqual(['thinking']);
    expect(view.byId.get('execution:model')?.phase).toBe(phase);
    expect(view.byId.get('execution:model')?.operation?.members).toHaveLength(1);
  }
});

test('a newer retry without an input never removes the older exact input stage or independent same-text user messages', () => {
  const input = {
    kind: 'model_input' as const,
    evidenceId: 'old-input',
    contentVersion: 'v1',
    availability: 'available' as const,
    mediaType: 'application/json',
  };
  const events = [
    fact(1, { kind: 'model', executionId: 'old', phase: 'failed', evidenceRefs: [input] }),
    fact(2, {
      kind: 'model',
      executionId: 'retry',
      attributes: {
        previousExecutionId: 'old',
        previousExecutionOriginStoreId: 'store',
        retryAttempt: 2,
        retryReason: 'connection_failed',
      },
    }),
  ];
  const { view } = inspect(events);
  const system = view.byId.get('execution:old:part:system')!;
  expect(system.virtualPart?.targets).toEqual([]);
  expect(
    trajectoryMaterialTargets(system, 'system_prompt', events[0]!.eventId)[0]?.reference,
  ).toEqual(input);
  const users = ['first', 'second'].map((messageId, index) =>
    fact(index + 3, {
      kind: 'message',
      executionId: undefined,
      attributes: {
        messageId,
        role: 'user',
        messageSeq: String(index + 1),
        revision: String(index + 3),
        status: 'complete',
        display: { kind: 'message', summary: '你好' },
      },
    }),
  );
  const withUsers = inspect([...events, ...users]).view;
  expect(withUsers.visibleRows.filter((row) => row.kind === 'message')).toHaveLength(2);
});

test('retry lineage cannot turn a different semantic category into an ordinary Agent request', () => {
  const { view } = inspect([
    fact(1, { kind: 'model', executionId: 'ordinary', phase: 'failed' }),
    fact(2, {
      kind: 'model',
      executionId: 'compression',
      attributes: {
        previousExecutionId: 'ordinary',
        previousExecutionOriginStoreId: 'store',
        retryAttempt: 2,
        retryReason: 'connection_failed',
        compressionId: 'compression',
        compressionTrigger: 'automatic',
      },
    }),
  ]);
  expect(view.byId.get('execution:ordinary')?.operation?.attempts).toHaveLength(1);
  expect(view.byId.get('execution:compression')?.operation?.attempts).toHaveLength(1);
  expect(view.byId.get('execution:ordinary')).not.toBe(view.byId.get('execution:compression'));
});
