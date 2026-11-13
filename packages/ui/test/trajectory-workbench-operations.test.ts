import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
  type WorkbenchExpansion,
} from '../src/desktop/trajectory/workbench';

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
    sourceEventType: 'execution.changed',
    sourceRecordRevision: String(sequence),
    occurredAt: sequence * 100,
    identityConfidence: 'verified_origin',
    kind: 'model',
    phase: 'planned',
    recordedStatus: 'planned',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
function index(events: TrajectoryEvent[], at = events.at(-1)?.sequence ?? '0') {
  const projection = projectTrajectory(events, { atCursor: at, completePrefix: true });
  return buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []));
}
const view = (events: TrajectoryEvent[], expansion?: WorkbenchExpansion) =>
  filterTrajectoryWorkbench(index(events), defaultWorkbenchFilters(), [], expansion);
const model = (id: string, previous?: string, attempt = 1) => ({
  executionId: id,
  attributes: {
    display: { kind: 'model', modelName: 'test-model', operation: 'request' },
    ...(previous
      ? {
          previousExecutionId: previous,
          previousExecutionOriginStoreId: 'store',
          retryAttempt: attempt,
          retryReason: 'connection_failed',
          maxAttempts: 6,
        }
      : {}),
  },
});

test('three transport reconnections form one stable logical model with exact attempts and aliases', () => {
  const events: TrajectoryEvent[] = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const values = model(`m${attempt}`, attempt > 1 ? `m${attempt - 1}` : undefined, attempt);
    events.push(
      fact(attempt * 2 - 1, values),
      fact(attempt * 2, { ...values, phase: attempt === 4 ? 'completed' : 'failed' }),
    );
  }
  events.push(
    fact(9, {
      kind: 'tool',
      executionId: 'tool',
      parentExecutionId: 'm4',
      parentExecutionOriginStoreId: 'store',
    }),
  );
  const result = view(events),
    row = result.byId.get('execution:m4')!;
  expect(result.rows.filter((value) => value.kind === 'model')).toHaveLength(1);
  expect(row.id).toBe('execution:m1');
  expect(row.step?.executionId).toBe('m4');
  expect(row.phase).toBe('completed');
  expect(row.operation?.primaryNodeId).toBe('execution:m4');
  expect(row.operation?.reconnectCount).toBe(3);
  expect(row.operation?.attemptsComplete).toBe(true);
  expect(row.operation?.attempts.map((member) => member.step?.executionId)).toEqual([
    'm1',
    'm2',
    'm3',
    'm4',
  ]);
  expect(row.events.map((event) => event.sequence)).toEqual([
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
  ]);
  expect(result.byId.get('execution:m2')).toBe(row);
  expect(result.byId.get('execution:tool')?.parentId).toBe(row.id);
  expect(result.eventOwners.get(events[6]!.eventId)).toBe('execution:m4');
  expect(result.eventsById.size).toBe(9);
  const early = filterTrajectoryWorkbench(index(events, '4'));
  expect(early.byId.get('execution:m1')?.operation?.attempts).toHaveLength(2);
  expect(early.byId.has('execution:m4')).toBe(false);
  expect(early.byId.get('execution:m1')?.id).toBe(row.id);
});

test('same model names, missing predecessors, forks and foreign identities never fabricate a retry chain', () => {
  const events = [
    fact(1, model('a')),
    fact(2, model('independent')),
    fact(3, model('missing', 'outside', 3)),
    fact(4, model('fork1', 'a', 2)),
    fact(5, model('fork2', 'a', 2)),
    fact(6, { ...model('foreign', 'independent', 2), sessionId: 'other' }),
  ];
  const result = view(events);
  expect(result.rows.filter((row) => row.kind === 'model')).toHaveLength(6);
  expect(result.byId.get('execution:missing')?.operation?.attemptsComplete).toBe(false);
  expect(result.byId.get('execution:missing')?.operation?.reconnectCount).toBe(2);
});

function shellEvents(): TrajectoryEvent[] {
  const target = {
    targetExecutionId: 'job',
    targetExecutionOriginStoreId: 'store',
    targetSessionId: 's',
  };
  return [
    fact(1, {
      kind: 'tool',
      executionId: 'start',
      attributes: { display: { kind: 'shell', operation: 'launch', ...target } },
    }),
    fact(2, {
      kind: 'job',
      executionId: 'job',
      parentExecutionId: 'start',
      parentExecutionOriginStoreId: 'store',
      attributes: { display: { kind: 'shell', operation: 'execute', ...target } },
    }),
    fact(3, {
      kind: 'job',
      executionId: 'job',
      parentExecutionId: 'start',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: {
        display: { kind: 'shell', operation: 'execute', ...target, observedStatus: 'running' },
      },
    }),
    fact(4, {
      kind: 'tool',
      executionId: 'read',
      phase: 'completed',
      attributes: {
        display: { kind: 'shell', operation: 'read', ...target, observedStatus: 'running' },
      },
    }),
    fact(5, {
      kind: 'tool',
      executionId: 'wait',
      phase: 'completed',
      attributes: {
        display: {
          kind: 'shell',
          operation: 'wait',
          ...target,
          timedOut: true,
          observedStatus: 'running',
        },
      },
    }),
    fact(6, {
      kind: 'tool',
      executionId: 'stop',
      phase: 'completed',
      attributes: {
        display: {
          kind: 'shell',
          operation: 'stop',
          ...target,
          accepted: true,
          cancelRequested: true,
        },
      },
    }),
    fact(7, {
      kind: 'tool',
      executionId: 'same-new-command',
      attributes: {
        display: { kind: 'shell', operation: 'execute', title: 'shell', summary: 'same command' },
      },
    }),
  ];
}
test('Shell launch, Job and exact read/wait/stop observations retain one command and its real Job state', () => {
  const events = shellEvents(),
    result = view(events),
    row = result.byId.get('execution:start')!;
  expect(result.rows.filter((value) => value.category === 'tool')).toHaveLength(2);
  expect(row.operation?.type).toBe('shell');
  expect(row.operation?.primaryNodeId).toBe('execution:job');
  expect(row.phase).toBe('running');
  expect(row.operation?.observations.map((member) => member.nodeId)).toEqual([
    'execution:read',
    'execution:wait',
    'execution:stop',
  ]);
  expect(row.operation?.members[0]?.nodeId).toBe('execution:start');
  expect(result.byId.get('execution:read')).toBe(row);
  expect(result.byId.get('execution:same-new-command')).not.toBe(row);
  expect(row.events).toHaveLength(6);
  expect(result.eventOwners.get(events[3]!.eventId)).toBe('execution:read');
  const later = view([
    ...events,
    fact(8, {
      kind: 'job',
      executionId: 'job',
      parentExecutionId: 'start',
      parentExecutionOriginStoreId: 'store',
      phase: 'cancelled',
      attributes: {
        display: {
          kind: 'shell',
          operation: 'execute',
          targetExecutionId: 'job',
          targetExecutionOriginStoreId: 'store',
        },
      },
    }),
  ]);
  expect(later.byId.get('execution:start')?.phase).toBe('cancelled');
  expect(
    filterTrajectoryWorkbench(
      index([...events, fact(8, { kind: 'job', executionId: 'job', phase: 'completed' })], '7'),
    ).byId.get('execution:start')?.phase,
  ).toBe('running');
});

test('missing Shell relation metadata and incorrect target stores are not guessed', () => {
  const result = view([
    fact(1, {
      kind: 'tool',
      executionId: 'command',
      attributes: { definitionId: 'builtin.shell/shell.launch' },
    }),
    fact(2, {
      kind: 'job',
      executionId: 'job',
      parentExecutionId: 'command',
      parentExecutionOriginStoreId: 'store',
    }),
    fact(3, {
      kind: 'tool',
      executionId: 'read',
      attributes: {
        display: {
          kind: 'shell',
          operation: 'read',
          targetExecutionId: 'job',
          targetExecutionOriginStoreId: 'other',
        },
      },
    }),
  ]);
  expect(result.rows.filter((row) => row.category === 'tool')).toHaveLength(3);
});

test('search uses bounded public display fields of every logical member without indexing private bodies or Evidence refs', () => {
  const events = shellEvents();
  const launch = events[0]!;
  if (launch.kind !== 'tool') throw Error('fixture_kind');
  launch.attributes.display = {
    ...launch.attributes.display!,
    title: '运行认证测试',
    summary: 'npm test src/auth',
  };
  const read = events[3]!;
  if (read.kind !== 'tool') throw Error('fixture_kind');
  read.attributes.display = { ...read.attributes.display!, summary: '已读取测试输出检查点' };
  events.push(
    fact(8, {
      executionId: 'named-model',
      attributes: {
        display: { kind: 'model', modelName: 'public-model-name', operation: 'request' },
      },
    }),
    fact(9, {
      kind: 'message',
      attributes: {
        messageId: 'input',
        role: 'user',
        messageSeq: '1',
        revision: '9',
        status: 'complete',
        display: { kind: 'message', summary: '公开的用户提示片段' },
      },
    }),
  );
  const projection = projectTrajectory(events, { atCursor: '9', completePrefix: true });
  // Guard against accidentally broadening search to serialize a source object or material reference.
  Object.assign(projection.eventIndex![0]!, {
    body: 'PRIVATE_COMPLETE_BODY',
    privatePrompt: 'PRIVATE_SYSTEM_PROMPT',
  });
  projection.eventIndex![0]!.evidenceRefs.push({
    kind: 'tool_input',
    evidenceId: 'UNREAD_EVIDENCE_BODY',
    contentVersion: 'body-version',
    availability: 'available',
    mediaType: 'application/json',
  });
  const prefix = buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []));
  const matched = (query: string) =>
    filterTrajectoryWorkbench(prefix, { ...defaultWorkbenchFilters(), metadataQuery: query })
      .matchingIds;
  for (const query of ['运行认证测试', 'src/auth', '已读取测试输出检查点', 'launch'])
    expect(matched(query)).toEqual(new Set(['execution:start']));
  expect(matched('public-model-name')).toEqual(new Set(['execution:named-model']));
  expect(matched('公开的用户提示片段')).toEqual(new Set(['message:input']));
  for (const query of ['PRIVATE_COMPLETE_BODY', 'PRIVATE_SYSTEM_PROMPT', 'UNREAD_EVIDENCE_BODY'])
    expect(matched(query).size).toBe(0);
});

function conversation(): TrajectoryEvent[] {
  return [
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
    fact(2, { executionId: 'main' }),
    fact(3, {
      kind: 'tool',
      executionId: 'file',
      parentExecutionId: 'main',
      parentExecutionOriginStoreId: 'store',
    }),
    fact(4, {
      kind: 'tool',
      executionId: 'spawn',
      parentExecutionId: 'main',
      parentExecutionOriginStoreId: 'store',
      attributes: {
        display: {
          kind: 'task',
          operation: 'spawn',
          targetExecutionId: 'carrier',
          targetExecutionOriginStoreId: 'store',
          targetSessionId: 'child',
        },
      },
    }),
    fact(5, {
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
        },
      },
    }),
    fact(6, {
      kind: 'child',
      executionId: 'carrier',
      attributes: {
        carrierExecutionId: 'carrier',
        childSessionId: 'child',
        childRunId: 'child-run',
      },
    }),
    fact(7, { sessionId: 'child', runId: 'child-run', executionId: 'nested' }),
    fact(8, {
      sessionId: 'child',
      runId: 'child-run',
      kind: 'tool',
      executionId: 'nested-tool',
      parentExecutionId: 'nested',
      parentExecutionOriginStoreId: 'store',
    }),
    fact(9, {
      kind: 'message',
      executionId: 'main',
      attributes: {
        messageId: 'reply',
        role: 'assistant',
        messageSeq: '2',
        revision: '9',
        status: 'complete',
      },
    }),
  ];
}
test('child Tool, carrier Job and child relation form one task, while independent work stays separate', () => {
  const events = conversation();
  events.push(
    fact(10, {
      kind: 'tool',
      executionId: 'follow-up',
      attributes: {
        display: {
          kind: 'task',
          operation: 'follow_up',
          targetExecutionId: 'carrier',
          targetExecutionOriginStoreId: 'store',
          targetSessionId: 'child',
        },
      },
    }),
  );
  const result = view(events),
    row = result.byId.get('execution:spawn')!;
  expect(row.operation?.type).toBe('child');
  expect(row.operation?.memberNodeIds).toHaveLength(3);
  expect(row.operation?.primaryNodeId).toBe('execution:carrier');
  expect(result.byId.get('execution:carrier')).toBe(row);
  expect(result.byId.get('execution:follow-up')).not.toBe(row);
  expect(result.byId.get('execution:nested')?.parentId).toContain('run:');
  expect(result.byId.get(result.byId.get('execution:nested')!.parentId!)?.parentId).toBe(row.id);
});

test('automatic compression generation and exact publication share one row without losing either observation', () => {
  const events = [
    fact(1, {
      executionId: 'compress',
      phase: 'completed',
      attributes: {
        compressionId: 'c',
        compressionTrigger: 'automatic',
        compression: { adopted: false },
      },
    }),
    fact(2, {
      kind: 'context',
      executionId: 'compress',
      sourceEventType: 'context.compressed',
      phase: 'observed',
      attributes: {
        compressionId: 'c',
        compressionTrigger: 'automatic',
        compression: { adopted: true },
      },
    }),
  ];
  const result = view(events),
    row = result.byId.get('execution:compress')!;
  expect(result.rows.filter((value) => value.category === 'compression')).toHaveLength(1);
  expect(row.operation?.type).toBe('compression');
  expect(row.operation?.members.map((member) => member.kind)).toEqual(['model', 'context']);
  expect(row.events).toEqual(events);
  expect(result.byId.get(`event:${events[1]!.eventId}`)).toBe(row);
  expect(
    filterTrajectoryWorkbench(index(events, '1')).byId.get('execution:compress')?.events,
  ).toHaveLength(1);
});

test('eight independent expansion combinations fold hierarchy into counts and retain exact messages and aliases', () => {
  const prefix = index(conversation());
  for (const rounds of [false, true])
    for (const calls of [false, true])
      for (const subcalls of [false, true]) {
        const expansion = { rounds, calls, subcalls };
        const result = filterTrajectoryWorkbench(prefix, defaultWorkbenchFilters(), [], expansion);
        const visible = result.visibleRows.filter((row) => !row.structural).map((row) => row.id);
        expect(result.rows.filter((row) => row.kind === 'message')).toHaveLength(2);
        expect(result.byId.get('execution:carrier')).toBe(result.byId.get('execution:spawn'));
        if (!rounds) {
          expect(visible).toEqual(['message:user']);
          expect(result.byId.get('execution:main')?.collapsedById).toContain('run:');
          const round = result.byId.get(result.byId.get('execution:main')!.collapsedById!)!;
          expect(round.collapse?.counts).toMatchObject({ model: 1, tool: 1, child: 1, message: 2 });
        } else if (!calls) {
          expect(visible).toEqual(['message:user', 'execution:main']);
          expect(result.byId.get('execution:main')?.collapse).toMatchObject({
            level: 'call',
            collapsed: true,
            hiddenCount: 5,
          });
        } else if (!subcalls) {
          expect(visible).toEqual([
            'message:user',
            'execution:main',
            'execution:file',
            'execution:spawn',
            'message:reply',
          ]);
          expect(result.byId.get('execution:spawn')?.collapse).toMatchObject({
            level: 'subcall',
            collapsed: true,
          });
        } else
          expect(visible).toEqual([
            'message:user',
            'execution:main',
            'execution:file',
            'execution:spawn',
            'execution:nested',
            'execution:nested-tool',
            'message:reply',
          ]);
        expect(expansion).toEqual({ rounds, calls, subcalls });
      }
  const round =
    prefix.rows.find((row) => row.kind === 'run' && row.step?.sessionId === 's') ??
    prefix.rows.find((row) => row.kind === 'run');
  const expanded = [
    round!.id,
    'execution:main',
    'execution:carrier',
    ...prefix.rows.filter((row) => row.kind === 'run').map((row) => row.id),
  ];
  const local = filterTrajectoryWorkbench(prefix, defaultWorkbenchFilters(), [], {
    rounds: false,
    calls: false,
    subcalls: false,
    expandedNodeIds: expanded,
  });
  expect(local.visibleRows.some((row) => row.id === 'execution:nested')).toBe(true);
  expect(local.byId.get('message:reply')?.events[0]?.attributes).toMatchObject({
    messageId: 'reply',
  });
  const searched = filterTrajectoryWorkbench(
    prefix,
    { ...defaultWorkbenchFilters(), metadataQuery: 'nested-tool' },
    [],
    { rounds: false, calls: false, subcalls: false },
  );
  expect(searched.visibleRows.some((row) => row.id === 'execution:nested-tool')).toBe(true);
});
