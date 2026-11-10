import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { composeTrajectoryScopes } from '../src/desktop/trajectory/related';
import { trajectoryRequestTargets } from '../src/desktop/trajectory/request-details';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
} from '../src/desktop/trajectory/workbench';
import {
  normalizeTrajectoryDetailTab,
  trajectoryDetailTabs,
  trajectoryMaterialTargets,
} from '../src/desktop/trajectory/workbench-details';

const ref = (kind: TrajectoryEvidenceRef['kind'], id: string): TrajectoryEvidenceRef => ({
  kind,
  evidenceId: id,
  contentVersion: `${id}-version`,
  availability: 'available',
  mediaType: 'application/json',
});
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
function view(events: TrajectoryEvent[], atCursor = events.at(-1)!.sequence) {
  const projection = projectTrajectory(events, { atCursor, completePrefix: true });
  const index = buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []), {
    loopParts: true,
  });
  return filterTrajectoryWorkbench(index);
}

test('the exact Run is the only Agent loop; merged retries and later decisions are numbered inside it', () => {
  const events = [
    fact(1),
    fact(2, { phase: 'failed' }),
    fact(3, {
      executionId: 'retry',
      attributes: {
        previousExecutionId: 'model',
        previousExecutionOriginStoreId: 'store',
        retryAttempt: 2,
        retryReason: 'connection_failed',
      },
    }),
    fact(4, { executionId: 'retry', phase: 'completed' }),
    fact(5, { executionId: 'next' }),
    fact(6, { executionId: 'other-run', runId: 'other' }),
  ];
  const result = view(events);
  expect(
    result.rows
      .filter((row) => row.loop !== undefined && !row.virtualPart)
      .map((row) => [row.id, row.loop]),
  ).toEqual([
    ['group:run:["store","s","run"]', 1],
    ['group:run:["store","s","other"]', 2],
  ]);
  expect(
    result.rows
      .filter((row) => row.requestIndex !== undefined)
      .map((row) => [row.id, row.requestIndex]),
  ).toEqual([
    ['execution:model', 1],
    ['execution:next', 2],
    ['execution:other-run', 1],
  ]);
  expect(
    result.rows
      .filter((row) => row.virtualPart)
      .every((row) => row.loop === undefined && row.requestIndex === undefined),
  ).toBe(true);
  expect(result.runOptions.map((option) => option.label)).toEqual(['Agent loop 1', 'Agent loop 2']);
  expect(result.rows.find((row) => row.kind === 'run')?.loopPhase).toBeUndefined();
  expect(result.byId.get('execution:retry')).toBe(result.byId.get('execution:model'));
});

test('Agent loop state comes only from its actual Run and numbering is independent for another Session', () => {
  const events = [
    fact(1, { kind: 'run', executionId: undefined, phase: 'running' }),
    fact(2, { phase: 'completed' }),
    fact(3, {
      kind: 'run',
      executionId: undefined,
      runId: 'child-run',
      sessionId: 'child',
      phase: 'completed',
    }),
    fact(4, {
      executionId: 'child-model',
      runId: 'child-run',
      sessionId: 'child',
      phase: 'completed',
    }),
    fact(5, { kind: 'run', executionId: undefined, runId: 'second-run', phase: 'completed' }),
    fact(6, { executionId: 'second-model', runId: 'second-run', phase: 'completed' }),
  ];
  const result = view(events);
  const runs = result.rows.filter((row) => row.kind === 'run' && !row.event);
  expect(
    runs.map((row) => [row.step?.sessionId, row.step?.runId, row.loop, row.loopPhase]),
  ).toEqual([
    ['s', 'run', 1, 'running'],
    ['child', 'child-run', 1, 'completed'],
    ['s', 'second-run', 2, 'completed'],
  ]);
  expect(result.runOptions.map((option) => [option.sessionId, option.runId, option.label])).toEqual(
    [
      ['s', 'run', 'Agent loop 1'],
      ['child', 'child-run', 'Agent loop 1'],
      ['s', 'second-run', 'Agent loop 2'],
    ],
  );
  expect(result.byId.get('execution:model')?.requestPhase).toBe('completed');
  expect(
    result.rows.filter((row) => row.kind === 'model').every((row) => row.loop === undefined),
  ).toBe(true);
});

test('a later recorded Run lifecycle uses the same first-observed ordinal as the Run selector', () => {
  const result = view([
    fact(1, { phase: 'completed' }),
    fact(2, { kind: 'run', executionId: undefined, runId: 'other', phase: 'running' }),
    fact(3, { kind: 'run', executionId: undefined, phase: 'completed' }),
  ]);
  expect(result.runOptions.map((option) => [option.runId, option.label])).toEqual([
    ['run', 'Agent loop 1'],
    ['other', 'Agent loop 2'],
  ]);
  expect(
    result.rows
      .filter((row) => row.kind === 'run' && !row.event)
      .map((row) => [row.step?.runId, row.loop]),
  ).toEqual([
    ['other', 2],
    ['run', 1],
  ]);
});

test('old facts with exact model references expose request and output parts without inventing message facts or counting parts as calls', () => {
  const events = [
    fact(1, { evidenceRefs: [ref('model_input', 'input')] }),
    fact(2, { phase: 'completed', evidenceRefs: [ref('model_output', 'output')] }),
    fact(3, {
      kind: 'tool',
      executionId: 'tool',
      parentExecutionId: 'model',
      parentExecutionOriginStoreId: 'store',
    }),
    fact(4, {
      kind: 'tool',
      executionId: 'tool',
      parentExecutionId: 'model',
      parentExecutionOriginStoreId: 'store',
      phase: 'completed',
    }),
  ];
  const result = view(events),
    owner = result.byId.get('execution:model')!;
  const parts = result.rows.filter((row) => row.virtualPart);
  expect(parts.map((row) => row.virtualPart!.kind)).toEqual([
    'system',
    'input',
    'thinking',
    'reply',
  ]);
  expect(
    parts.every(
      (row) =>
        row.nodeId === owner.nodeId &&
        row.parentId === owner.parentId &&
        row.originalParentId === owner.id &&
        row.events === owner.events,
    ),
  ).toBe(true);
  expect(result.rows.some((row) => row.kind === 'message')).toBe(false);
  expect(result.counts).toMatchObject({ total: 2, matched: 2 });
  expect(
    result.timelineDomains.flatMap((domain) => domain.rows).every((row) => !row.virtualPart),
  ).toBe(true);
  for (const row of parts)
    expect(
      trajectoryMaterialTargets(row, trajectoryDetailTabs(row)[0]!).map(
        (target) => target.reference.evidenceId,
      ),
    ).toEqual([
      row.virtualPart!.kind === 'system' || row.virtualPart!.kind === 'input' ? 'input' : 'output',
    ]);
  expect(
    result.visibleRows.findIndex((row) => row.id === 'execution:model:part:reply'),
  ).toBeLessThan(result.visibleRows.findIndex((row) => row.id === 'execution:tool'));
  expect(owner.presentationHidden).toBe(true);
  expect(owner.presentationRepresentativeId).toBe('execution:model:part:thinking');
  expect(result.visibleRows.some((row) => row.id === owner.id)).toBe(false);
});

test('part observations bind the selected original attempt and prefix; later completion never upgrades old materials', () => {
  const events = [
    fact(1, { evidenceRefs: [ref('model_input', 'old-input')] }),
    fact(2, { phase: 'failed', evidenceRefs: [ref('model_output', 'old-prefix')] }),
    fact(3, {
      executionId: 'retry',
      attributes: {
        previousExecutionId: 'model',
        previousExecutionOriginStoreId: 'store',
        retryAttempt: 2,
      },
      evidenceRefs: [ref('model_input', 'new-input')],
    }),
    fact(4, {
      executionId: 'retry',
      phase: 'completed',
      evidenceRefs: [ref('model_output', 'new-output')],
    }),
  ];
  const result = view(events),
    thinking = result.byId.get('execution:model:part:thinking')!,
    input = result.byId.get('execution:model:part:system')!;
  expect(thinking.virtualPart?.targets[0]?.reference.evidenceId).toBe('new-output');
  expect(
    trajectoryMaterialTargets(thinking, 'thinking', events[1]!.eventId)[0]?.reference.evidenceId,
  ).toBe('old-prefix');
  expect(
    trajectoryMaterialTargets(input, 'system_prompt', events[1]!.eventId)[0]?.reference.evidenceId,
  ).toBe('old-input');
  expect(trajectoryMaterialTargets(thinking, 'raw', events[0]!.eventId)).toEqual([]);
  expect(trajectoryMaterialTargets(thinking, 'thinking', 'missing-event')).toEqual([]);
  expect(trajectoryDetailTabs(input)).toEqual(['system_prompt', 'tools']);
  expect(trajectoryDetailTabs(thinking)).toEqual(['thinking']);
  expect(normalizeTrajectoryDetailTab(thinking, 'request_info')).toBe('thinking');
  expect(trajectoryMaterialTargets(thinking, 'request_info')).toEqual([]);
  expect(normalizeTrajectoryDetailTab(input, 'overview')).toBe('system_prompt');
  expect(normalizeTrajectoryDetailTab(thinking, 'preview')).toBe('thinking');
  expect(
    trajectoryMaterialTargets(input, 'tools', events[1]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['old-input']);
  expect(
    trajectoryRequestTargets(
      result.byId.get('execution:model')!,
      'overview',
      events[1]!.eventId,
    ).map((target) => target.reference.evidenceId),
  ).toEqual(['old-input', 'old-prefix']);
  expect(
    trajectoryRequestTargets(result.byId.get('execution:model')!, 'overview').map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['new-input', 'new-output']);
  expect(
    trajectoryRequestTargets(
      result.byId.get('execution:model')!,
      'overview',
      events[0]!.eventId,
    ).map((target) => target.reference.evidenceId),
  ).toEqual(['old-input']);
  const earlier = view(events, '2');
  expect(
    earlier.byId.get('execution:model:part:thinking')?.virtualPart?.targets[0]?.reference
      .evidenceId,
  ).toBe('old-prefix');
  expect(earlier.byId.has('execution:retry')).toBe(false);
});

test('verified user messages and the primary model reply remain original rows rather than duplicated request-role guesses', () => {
  const result = view([
    fact(1, {
      kind: 'message',
      executionId: undefined,
      attributes: {
        messageId: 'user',
        role: 'user',
        messageSeq: '1',
        revision: '1',
        status: 'complete',
      },
    }),
    fact(2, { evidenceRefs: [ref('model_input', 'input')] }),
    fact(3, { phase: 'completed', evidenceRefs: [ref('model_output', 'output')] }),
    fact(4, {
      kind: 'message',
      attributes: {
        messageId: 'reply',
        role: 'assistant',
        messageSeq: '2',
        revision: '4',
        status: 'complete',
      },
    }),
  ]);
  expect(
    result.visibleRows.filter((row) => row.virtualPart).map((row) => row.virtualPart!.kind),
  ).toEqual(['system', 'thinking']);
  expect(result.byId.get('message:user')?.step?.messageId).toBe('user');
  expect(result.byId.get('message:reply')?.step?.messageId).toBe('reply');
  expect(result.counts.total).toBe(3);
});

test('decision status follows actual Tool receipts, while a returned background launch does not wait for its Job', () => {
  const model = [fact(1), fact(2, { phase: 'completed' })];
  for (const phase of ['running', 'waiting_interaction', 'failed', 'outcome_unknown'] as const) {
    const result = view([
      ...model,
      fact(3, {
        kind: 'tool',
        executionId: 'foreground',
        parentExecutionId: 'model',
        parentExecutionOriginStoreId: 'store',
        phase,
      }),
    ]);
    expect(result.byId.get('execution:model')?.requestPhase).toBe(phase);
    expect(result.byId.get('execution:model')?.phase).toBe('completed');
  }
  const launch = {
    kind: 'tool',
    executionId: 'launch',
    parentExecutionId: 'model',
    parentExecutionOriginStoreId: 'store',
    attributes: {
      display: {
        kind: 'shell',
        operation: 'launch',
        targetExecutionId: 'job',
        targetExecutionOriginStoreId: 'store',
      },
    },
  };
  const result = view([
    ...model,
    fact(3, launch),
    fact(4, { ...launch, phase: 'completed' }),
    fact(5, {
      kind: 'job',
      executionId: 'job',
      parentExecutionId: 'launch',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: { display: { kind: 'shell', operation: 'execute' } },
    }),
  ]);
  expect(result.byId.get('execution:launch')?.phase).toBe('running');
  expect(result.byId.get('execution:model')?.requestPhase).toBe('completed');
});

test('compact calls retain a thought phase and actual tools; filtering does not inflate logical matches', () => {
  const events = [
    fact(1, { evidenceRefs: [ref('model_input', 'input')] }),
    fact(2, { phase: 'completed' }),
  ];
  const projection = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  const index = buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []), {
    loopParts: true,
  });
  const folded = filterTrajectoryWorkbench(index, defaultWorkbenchFilters(), [], {
    rounds: true,
    calls: false,
    subcalls: false,
  });
  expect(
    folded.visibleRows.filter((row) => row.virtualPart).map((row) => row.virtualPart!.kind),
  ).toEqual(['thinking']);
  expect(folded.byId.get('execution:model:part:thinking')?.compact).toBe(true);
  expect(folded.byId.get('execution:model:part:system')?.collapsedById).toBe(
    'execution:model:part:thinking',
  );
  const searched = filterTrajectoryWorkbench(index, {
    ...defaultWorkbenchFilters(),
    metadataQuery: 'model',
  });
  expect(searched.counts.matched).toBe(1);
  expect(
    searched.visibleRows.filter((row) => row.virtualPart).map((row) => row.virtualPart!.kind),
  ).toEqual(['system', 'input', 'thinking']);
});

test('a later decision waits for its original observation Tool even when that Tool is displayed under an earlier Shell command', () => {
  const events = [
    fact(1),
    fact(2, { phase: 'completed' }),
    fact(3, {
      kind: 'tool',
      executionId: 'launch',
      parentExecutionId: 'model',
      parentExecutionOriginStoreId: 'store',
      phase: 'completed',
      attributes: {
        display: {
          kind: 'shell',
          operation: 'launch',
          targetExecutionId: 'job',
          targetExecutionOriginStoreId: 'store',
        },
      },
    }),
    fact(4, {
      kind: 'job',
      executionId: 'job',
      parentExecutionId: 'launch',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: { display: { kind: 'shell', operation: 'execute' } },
    }),
    fact(5, { executionId: 'next', phase: 'completed' }),
    fact(6, {
      kind: 'tool',
      executionId: 'read',
      parentExecutionId: 'next',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: {
        display: {
          kind: 'shell',
          operation: 'read',
          targetExecutionId: 'job',
          targetExecutionOriginStoreId: 'store',
        },
      },
    }),
  ];
  const result = view(events);
  expect(result.byId.get('execution:read')?.id).toBe('execution:launch');
  expect(result.byId.get('execution:model')?.requestPhase).toBe('completed');
  expect(result.byId.get('execution:next')?.requestPhase).toBe('running');
  expect(result.byId.get('execution:launch')?.phase).toBe('running');
});

test('ordinary phases are flat in both parent and admitted child loops, while only the child carrier preserves a nested branch', () => {
  const target = {
    kind: 'task',
    operation: 'spawn',
    targetExecutionId: 'carrier',
    targetExecutionOriginStoreId: 'store',
    targetSessionId: 'child',
    targetRunId: 'child-run',
  };
  const parent = projectTrajectory(
    [
      fact(1, { kind: 'run', executionId: undefined, phase: 'running' }),
      fact(2, {
        kind: 'message',
        executionId: undefined,
        attributes: {
          messageId: 'prompt',
          role: 'user',
          messageSeq: '1',
          revision: '2',
          status: 'complete',
        },
      }),
      fact(3, { evidenceRefs: [ref('model_input', 'parent-input')] }),
      fact(4, { phase: 'completed', evidenceRefs: [ref('model_output', 'parent-output')] }),
      fact(5, {
        kind: 'tool',
        executionId: 'shell',
        parentExecutionId: 'model',
        parentExecutionOriginStoreId: 'store',
        phase: 'completed',
      }),
      fact(6, {
        kind: 'interaction',
        executionId: 'shell',
        parentExecutionId: 'shell',
        parentExecutionOriginStoreId: 'store',
        attributes: { interactionId: 'approval', interactionKind: 'approval', revision: '6' },
      }),
      fact(7, {
        executionId: 'compression',
        parentExecutionId: 'shell',
        parentExecutionOriginStoreId: 'store',
        phase: 'completed',
        attributes: { compressionId: 'c', compressionTrigger: 'automatic' },
      }),
      fact(8, {
        kind: 'tool',
        executionId: 'spawn',
        parentExecutionId: 'model',
        parentExecutionOriginStoreId: 'store',
        phase: 'completed',
        attributes: { display: target },
      }),
      fact(9, {
        kind: 'job',
        executionId: 'carrier',
        parentExecutionId: 'spawn',
        parentExecutionOriginStoreId: 'store',
        phase: 'running',
        attributes: { childSessionId: 'child', display: target },
      }),
    ],
    { atCursor: '20', completePrefix: true },
  );
  const child = projectTrajectory(
    [
      fact(11, {
        kind: 'run',
        executionId: undefined,
        sessionId: 'child',
        runId: 'child-run',
        phase: 'running',
      }),
      fact(12, {
        sessionId: 'child',
        runId: 'child-run',
        evidenceRefs: [ref('model_input', 'child-input')],
      }),
      fact(13, {
        sessionId: 'child',
        runId: 'child-run',
        phase: 'completed',
        evidenceRefs: [ref('model_output', 'child-output')],
      }),
      fact(14, {
        sessionId: 'child',
        runId: 'child-run',
        kind: 'tool',
        executionId: 'child-shell',
        parentExecutionId: 'model',
        parentExecutionOriginStoreId: 'store',
        phase: 'completed',
      }),
      fact(15, {
        sessionId: 'child',
        runId: 'child-run',
        kind: 'interaction',
        executionId: 'child-shell',
        parentExecutionId: 'child-shell',
        parentExecutionOriginStoreId: 'store',
        attributes: {
          interactionId: 'child-approval',
          interactionKind: 'approval',
          revision: '15',
        },
      }),
    ],
    { atCursor: '20', completePrefix: true },
  );
  const scopes = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: child },
  ]);
  const originalParents = new Map([...scopes.tree.byId].map(([id, node]) => [id, node.parentId]));
  const index = buildTrajectoryWorkbenchIndex(scopes.projection, scopes.tree, { loopParts: true });
  const result = filterTrajectoryWorkbench(index);
  const carrier = result.byId.get('execution:spawn')!;
  const mainRun = result.rows.find(
    (row) => row.kind === 'run' && !row.event && row.step?.sessionId === 's',
  )!;
  const childRun = result.rows.find(
    (row) => row.kind === 'run' && !row.event && row.step?.sessionId === 'child',
  )!;
  expect(carrier.operation?.type).toBe('child');
  expect(carrier.parentId).toBe(mainRun.id);
  expect(childRun.parentId).toBe(carrier.id);
  for (const row of result.visibleRows) {
    if (row.category === 'structure') continue;
    expect(row.parentId).toBe(row.step?.sessionId === 'child' ? childRun.id : mainRun.id);
    expect(row.depth).toBe((row.step?.sessionId === 'child' ? childRun.depth : mainRun.depth) + 1);
  }
  expect(result.byId.get('interaction:approval')?.originalParentId).toBe('execution:shell');
  expect(result.byId.get('execution:shell')?.operation?.members[0]?.parentId).toBe(
    'execution:model',
  );
  expect([...scopes.tree.byId].map(([id, node]) => [id, node.parentId])).toEqual([
    ...originalParents,
  ]);
  expect(result.byId.get('execution:model')?.events.map((event) => event.eventId)).toEqual([
    fact(3).eventId,
    fact(4).eventId,
  ]);
  for (const rounds of [false, true])
    for (const calls of [false, true])
      for (const subcalls of [false, true]) {
        const folded = filterTrajectoryWorkbench(index, defaultWorkbenchFilters(), [], {
          rounds,
          calls,
          subcalls,
        });
        expect(folded.visibleRows.some((row) => row.presentationHidden)).toBe(false);
        expect(
          folded.visibleRows.some(
            (row) => row.virtualPart?.kind === 'system' && row.step?.sessionId === 's',
          ),
        ).toBe(rounds && calls);
        expect(folded.visibleRows.some((row) => row.id === 'execution:shell')).toBe(rounds);
        expect(
          folded.visibleRows.some(
            (row) => row.virtualPart?.kind === 'thinking' && row.step?.sessionId === 's',
          ),
        ).toBe(rounds);
        expect(
          folded.visibleRows.some(
            (row) => row.virtualPart?.kind === 'thinking' && row.step?.sessionId === 'child',
          ),
        ).toBe(rounds && subcalls);
      }
});

test('legacy operations without a proved Run flatten under their real Session without altering the original chain', () => {
  const events = Array.from({ length: 24 }, (_, index) =>
    fact(index + 1, {
      kind: 'tool',
      runId: undefined,
      runOriginStoreId: undefined,
      executionId: `legacy-${index}`,
      ...(index
        ? { parentExecutionId: `legacy-${index - 1}`, parentExecutionOriginStoreId: 'store' }
        : {}),
      phase: 'completed',
    }),
  );
  const projection = projectTrajectory(events, { atCursor: '24', completePrefix: true });
  const tree = buildTrajectoryTree(projection, []);
  const originalParents = new Map([...tree.byId].map(([id, node]) => [id, node.parentId]));
  const index = buildTrajectoryWorkbenchIndex(projection, tree, { loopParts: true });
  const result = filterTrajectoryWorkbench(index);
  const operations = result.visibleRows.filter((row) => row.category === 'tool');
  expect(operations).toHaveLength(24);
  expect(operations.every((row) => row.parentId === tree.root.id && row.depth === 1)).toBe(true);
  expect(result.rows.some((row) => row.kind === 'run' || row.loop !== undefined)).toBe(false);
  expect(result.runOptions).toEqual([]);
  expect(result.byId.get('execution:legacy-23')?.originalParentId).toBe('execution:legacy-22');
  expect(result.byId.get('execution:legacy-23')?.operation?.members[0]?.parentId).toBe(
    'execution:legacy-22',
  );
  expect([...tree.byId].map(([id, node]) => [id, node.parentId])).toEqual([...originalParents]);
});
