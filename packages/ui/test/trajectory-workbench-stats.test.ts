import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { composeTrajectoryScopes } from '../src/desktop/trajectory/related';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
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
    executionId: 'model',
    executionOriginStoreId: 'store',
    kind: 'model',
    phase: 'completed',
    recordedStatus: 'completed',
    occurredAt: sequence * 100,
    sourceEventType: 'execution.changed',
    sourceRecordRevision: String(sequence),
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
const message = (id: string, role: 'user' | 'assistant', revision: number) => ({
  kind: 'message',
  executionId: role === 'user' ? undefined : 'm4',
  attributes: {
    messageId: id,
    role,
    messageSeq: String(revision),
    revision: String(revision),
    status: 'complete',
  },
});
const project = (events: TrajectoryEvent[], atCursor = '20') =>
  projectTrajectory(events, { atCursor, completePrefix: true });
const mainKey = JSON.stringify(['store', 's', 'run']);
const childKey = JSON.stringify(['store', 'child', 'child-run']);
const mainSummary = {
  model: 1,
  tool: 1,
  child: 1,
  approval: 1,
  compression: 1,
  actions: 5,
  userMessages: 1,
  assistantMessages: 1,
};
const childSummary = {
  model: 1,
  tool: 1,
  child: 0,
  approval: 0,
  compression: 0,
  actions: 2,
  userMessages: 1,
  assistantMessages: 1,
};

function fixture() {
  const shell = {
    kind: 'shell',
    targetExecutionId: 'job',
    targetExecutionOriginStoreId: 'store',
    targetSessionId: 's',
  };
  const task = {
    kind: 'task',
    operation: 'spawn',
    targetExecutionId: 'carrier',
    targetExecutionOriginStoreId: 'store',
    targetSessionId: 'child',
    targetRunId: 'child-run',
  };
  const events = [fact(1, message('user', 'user', 1))];
  for (let attempt = 1; attempt <= 4; attempt++)
    events.push(
      fact(attempt + 1, {
        executionId: `m${attempt}`,
        phase: attempt === 4 ? 'completed' : 'failed',
        attributes:
          attempt === 1
            ? {}
            : {
                previousExecutionId: `m${attempt - 1}`,
                previousExecutionOriginStoreId: 'store',
                retryAttempt: attempt,
                retryReason: 'connection_failed',
              },
      }),
    );
  events.push(
    fact(6, {
      kind: 'tool',
      executionId: 'launch',
      parentExecutionId: 'm4',
      parentExecutionOriginStoreId: 'store',
      attributes: { display: { ...shell, operation: 'launch' } },
    }),
    fact(7, {
      kind: 'job',
      executionId: 'job',
      parentExecutionId: 'launch',
      parentExecutionOriginStoreId: 'store',
      attributes: { display: { ...shell, operation: 'execute' } },
    }),
    ...(['read', 'wait', 'stop'] as const).map((operation, index) =>
      fact(index + 8, {
        kind: 'tool',
        executionId: operation,
        parentExecutionId: 'm4',
        parentExecutionOriginStoreId: 'store',
        attributes: { display: { ...shell, operation } },
      }),
    ),
    fact(11, {
      kind: 'interaction',
      executionId: 'launch',
      attributes: {
        interactionId: 'approval',
        interactionKind: 'approval',
        revision: '11',
        decision: 'accepted',
      },
    }),
    fact(12, {
      executionId: 'compression',
      attributes: {
        compressionId: 'c',
        compressionTrigger: 'automatic',
        compression: { adopted: false },
      },
    }),
    fact(13, {
      kind: 'context',
      executionId: 'compression',
      sourceEventType: 'context.compressed',
      phase: 'observed',
      attributes: {
        compressionId: 'c',
        compressionTrigger: 'automatic',
        compression: { adopted: true },
      },
    }),
    fact(14, {
      kind: 'tool',
      executionId: 'spawn',
      parentExecutionId: 'm4',
      parentExecutionOriginStoreId: 'store',
      attributes: { display: task },
    }),
    fact(15, {
      kind: 'job',
      executionId: 'carrier',
      parentExecutionId: 'spawn',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: { childSessionId: 'child', display: task },
    }),
    fact(20, message('reply', 'assistant', 20)),
  );
  const parent = project(events);
  const child = project([
    fact(16, { ...message('child-user', 'user', 16), sessionId: 'child', runId: 'child-run' }),
    fact(17, { sessionId: 'child', runId: 'child-run', executionId: 'child-model' }),
    fact(18, {
      sessionId: 'child',
      runId: 'child-run',
      kind: 'tool',
      executionId: 'child-tool',
      parentExecutionId: 'child-model',
      parentExecutionOriginStoreId: 'store',
    }),
    fact(19, {
      ...message('child-reply', 'assistant', 19),
      executionId: 'child-model',
      sessionId: 'child',
      runId: 'child-run',
    }),
  ]);
  const scopes = composeTrajectoryScopes(parent, [
    { parentNodeId: 'execution:carrier', projection: child },
  ]);
  const before = buildTrajectoryWorkbenchIndex(parent, buildTrajectoryTree(parent, []), {
    loopParts: true,
  });
  const after = buildTrajectoryWorkbenchIndex(scopes.projection, scopes.tree, { loopParts: true });
  return { events, parent, child, scopes, before, after };
}
const run = (result: ReturnType<typeof filterTrajectoryWorkbench>, key = mainKey) =>
  result.rows.find((row) => row.kind === 'run' && !row.event && row.runKey === key)!;

test('one direct Run summary counts logical work, keeps messages separate and is unchanged by loading child internals', () => {
  const { events, scopes, before, after } = fixture();
  const originalParents = [...scopes.tree.byId].map(([id, node]) => [id, node.parentId]);
  const unloaded = filterTrajectoryWorkbench(before),
    loaded = filterTrajectoryWorkbench(after);
  expect(run(unloaded).summary).toEqual(mainSummary);
  expect(run(loaded).summary).toEqual(mainSummary);
  expect(run(loaded, childKey).summary).toEqual(childSummary);
  expect(unloaded.byId.get('execution:spawn')?.summary).toBeUndefined();
  expect(loaded.byId.get('execution:spawn')?.summary).toEqual(childSummary);
  expect(loaded.byId.get('execution:m4')?.operation?.attempts).toHaveLength(4);
  expect(loaded.byId.get('execution:launch')?.operation?.observations).toHaveLength(3);
  expect(loaded.byId.get('execution:compression')?.operation?.members).toHaveLength(2);
  expect(loaded.byId.get('execution:read')).toBe(loaded.byId.get('execution:launch'));
  expect(loaded.byId.get('execution:launch')?.events.map((event) => event.sequence)).toEqual([
    '6',
    '7',
    '8',
    '9',
    '10',
  ]);
  expect(loaded.eventsById.size).toBe(events.length + 4);
  expect([...scopes.tree.byId].map(([id, node]) => [id, node.parentId])).toEqual(originalParents);
});

test('all eight presentation combinations preserve the same direct Run and exact child summary', () => {
  const { after } = fixture();
  for (const rounds of [false, true])
    for (const calls of [false, true])
      for (const subcalls of [false, true]) {
        const result = filterTrajectoryWorkbench(after, defaultWorkbenchFilters(), [], {
          rounds,
          calls,
          subcalls,
        });
        expect(run(result).summary).toEqual(mainSummary);
        expect(run(result, childKey).summary).toEqual(childSummary);
        expect(result.byId.get('execution:spawn')?.summary).toEqual(childSummary);
        expect(run(result).collapse?.counts).toEqual({
          model: 1,
          tool: 1,
          child: 1,
          approval: 1,
          compression: 1,
          message: 2,
        });
        expect(result.byId.get('execution:spawn')?.collapse?.counts).toEqual({
          model: 1,
          tool: 1,
          child: 0,
          approval: 0,
          compression: 0,
          message: 2,
        });
      }
});

test('filters change matched direct work without folding, ancestor promotion or child results adding main work', () => {
  const { after } = fixture();
  const tools = filterTrajectoryWorkbench(after, { ...defaultWorkbenchFilters(), types: ['tool'] });
  expect(run(tools).summary).toEqual({
    ...mainSummary,
    model: 0,
    approval: 0,
    compression: 0,
    actions: 2,
    userMessages: 0,
    assistantMessages: 0,
  });
  expect(run(tools, childKey).summary).toEqual({
    ...childSummary,
    model: 0,
    actions: 1,
    userMessages: 0,
    assistantMessages: 0,
  });
  const messages = filterTrajectoryWorkbench(after, {
    ...defaultWorkbenchFilters(),
    types: ['message'],
    childAgents: false,
  });
  expect(run(messages).summary).toEqual({
    model: 0,
    tool: 0,
    child: 0,
    approval: 0,
    compression: 0,
    actions: 0,
    userMessages: 1,
    assistantMessages: 1,
  });
  const search = filterTrajectoryWorkbench(after, {
    ...defaultWorkbenchFilters(),
    metadataQuery: 'child-tool',
  });
  expect(run(search).summary?.actions).toBe(0);
  expect(run(search, childKey).summary?.tool).toBe(1);
  const scoped = filterTrajectoryWorkbench(after, {
    ...defaultWorkbenchFilters(),
    runKeys: [mainKey],
  });
  expect(run(scoped).summary).toEqual(mainSummary);
  expect(run(scoped, childKey).summary?.actions).toBe(0);
});

test('summary observes the fixed prefix and never fabricates a Run or child summary for absent identity', () => {
  const { events } = fixture();
  const early = project(events, '4');
  const result = filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(early, buildTrajectoryTree(early, []), { loopParts: true }),
  );
  expect(run(result).summary).toEqual({
    model: 1,
    tool: 0,
    child: 0,
    approval: 0,
    compression: 0,
    actions: 1,
    userMessages: 1,
    assistantMessages: 0,
  });
  const legacy = project([
    fact(1, { kind: 'tool', runId: undefined, runOriginStoreId: undefined }),
  ]);
  const noRun = filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(legacy, buildTrajectoryTree(legacy, []), { loopParts: true }),
  );
  expect(noRun.rows.some((row) => row.kind === 'run' || row.summary !== undefined)).toBe(false);
});

test('a carrier with conflicting Session, Run or original namespace claims does not inherit child statistics', () => {
  const { after } = fixture();
  for (const patch of [
    { targetSessionId: 'other' },
    { targetRunId: 'other' },
    { targetExecutionOriginStoreId: 'other' },
  ]) {
    const changed = {
      ...after,
      rows: after.rows.map((row) =>
        row.operation?.type === 'child'
          ? {
              ...row,
              operation: {
                ...row.operation,
                members: row.operation.members.map((member) =>
                  member.kind === 'job'
                    ? {
                        ...member,
                        step: { ...member.step!, display: { ...member.step!.display!, ...patch } },
                      }
                    : member,
                ),
              },
            }
          : row,
      ),
    };
    const result = filterTrajectoryWorkbench(changed);
    expect(run(result).summary).toEqual(mainSummary);
    expect(run(result, childKey).summary).toEqual(childSummary);
    expect(result.byId.get('execution:spawn')?.summary).toBeUndefined();
  }
});
