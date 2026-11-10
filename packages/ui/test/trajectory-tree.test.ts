import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  TrajectoryProjector,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import {
  buildTrajectoryTree,
  filterTrajectoryTree,
  type TrajectoryTreeNode,
  trajectoryNodeEventIds,
} from '../src/desktop/trajectory/tree';

function fact(sequence: number | string, value: Record<string, unknown>): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${BigInt(sequence).toString(16).padStart(64, '0')}`,
    sequence: String(sequence),
    origin: { storeId: 'store', cursor: String(sequence) },
    sessionId: 'session',
    workspaceId: 'workspace',
    sourceEventType: 'execution.state_changed',
    sourceRecordRevision: String(sequence),
    kind: 'tool',
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: null,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...value,
  });
}
function tree(events: TrajectoryEvent[], visible: TrajectoryEvent[] = events) {
  return buildTrajectoryTree(
    projectTrajectory(events, { atCursor: events.at(-1)?.sequence ?? '0', completePrefix: true }),
    visible,
  );
}
function flatten(node: TrajectoryTreeNode): TrajectoryTreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}
function expectComplete(root: TrajectoryTreeNode, events: TrajectoryEvent[]) {
  const owned = flatten(root).flatMap((node) => node.sourceEventIds);
  expect(owned.length).toBe(events.length);
  expect(new Set(owned).size).toBe(events.length);
  expect(trajectoryNodeEventIds(root)).toEqual(events.map((event) => event.eventId));
}

test('complete tree is independent of the visible raw page and preserves exact large source order', () => {
  const events = [
    fact('9007199254740993', {
      executionId: 'parent',
      runId: 'run',
      phase: 'planned',
      attributes: { definitionId: 'builtin.files/read_file' },
    }),
    fact('9007199254740994', {
      executionId: 'child',
      parentExecutionId: 'parent',
      runId: 'run',
      attributes: { definitionId: 'builtin.shell/run_command' },
    }),
    fact('9007199254740995', {
      executionId: 'parent',
      runId: 'run',
      phase: 'completed',
      recordedStatus: 'succeeded',
      attributes: { definitionId: 'builtin.files/read_file' },
    }),
  ];
  const projector = new TrajectoryProjector({
    atCursor: events.at(-1)!.sequence,
    completePrefix: true,
  });
  for (const event of events) projector.apply([event]);
  const projection = projector.project();
  for (const visible of [[], [events[0]!], [events[2]!]]) {
    const { root, byId } = buildTrajectoryTree(projection, visible);
    expect(byId.get('execution:child')!.parentId).toBe('execution:parent');
    expect(byId.get('execution:parent')!.label).toBe('read_file');
    expect(byId.get('execution:parent')!.phase).toBe('completed');
    expect(byId.get('execution:parent')!.firstSequence).toBe('9007199254740993');
    expect(byId.get('execution:parent')!.lastSequence).toBe('9007199254740995');
    const run = byId.get(byId.get('execution:parent')!.parentId!)!;
    expect(run.kind).toBe('run');
    expect(run.phase).toBeUndefined();
    expectComplete(root, events);
  }
});

test('stored origin and Session distinguish colliding local execution IDs and parent links', () => {
  const events = [
    fact(1, { executionId: 'same', executionOriginStoreId: 'original-a' }),
    fact(2, { executionId: 'same', executionOriginStoreId: 'original-b' }),
    fact(3, { executionId: 'same', executionOriginStoreId: 'original-a', sessionId: 'other' }),
    fact(4, {
      executionId: 'child-a',
      parentExecutionId: 'same',
      parentExecutionOriginStoreId: 'original-b',
    }),
    fact(5, {
      executionId: 'child-b',
      sessionId: 'other',
      parentExecutionId: 'same',
      parentExecutionOriginStoreId: 'original-a',
    }),
  ];
  const { root, byId } = tree(events, []);
  const parents = [...byId.values()].filter((node) => node.step?.executionId === 'same');
  expect(parents).toHaveLength(3);
  expect(new Set(parents.map((node) => node.id)).size).toBe(3);
  const parentA = parents.find(
    (node) =>
      node.step!.executionOriginStoreId === 'original-a' && node.step!.sessionId === 'other',
  )!;
  const parentB = parents.find((node) => node.step!.executionOriginStoreId === 'original-b')!;
  expect(byId.get('execution:child-a')!.parentId).toBe(parentB.id);
  expect(byId.get('execution:child-b')!.parentId).toBe(parentA.id);
  expectComplete(root, events);
});

test('retry is a separate sibling and related decisions and verification keep their own lifecycle', () => {
  const events = [
    fact(1, { kind: 'model', executionId: 'model-1', runId: 'run', attempt: 1, phase: 'failed' }),
    fact(2, {
      kind: 'model',
      executionId: 'model-2',
      runId: 'run',
      attempt: 2,
      attributes: { previousExecutionId: 'model-1', previousExecutionOriginStoreId: 'store' },
    }),
    fact(3, { executionId: 'tool', runId: 'run', phase: 'waiting_interaction' }),
    fact(4, {
      kind: 'interaction',
      executionId: 'tool',
      runId: 'run',
      phase: 'observed',
      recordedStatus: 'accepted',
      attributes: { interactionId: 'approval', revision: '2', decision: 'accepted' },
    }),
    fact(5, {
      kind: 'verification',
      executionId: 'tool',
      runId: 'run',
      phase: 'observed',
      attributes: { verificationId: 'check', outcome: 'unknown', method: 'required_check' },
    }),
  ];
  const { root, byId } = tree(events, []);
  expect(byId.get('execution:model-1')!.parentId).toBe(byId.get('execution:model-2')!.parentId);
  expect(byId.get('execution:model-1')!.phase).toBe('failed');
  expect(byId.get('execution:model-2')!.step!.previousExecutionId).toBe('model-1');
  expect(byId.get('execution:model-2')!.label).toBe('模型调用 · 尝试 2');
  expect(byId.get('interaction:approval')!.parentId).toBe('execution:tool');
  expect(byId.get('verification:check')!.parentId).toBe('execution:tool');
  expect(byId.get('execution:tool')!.phase).toBe('waiting_interaction');
  expect(byId.get('execution:tool')!.sourceEventIds).toEqual([events[2]!.eventId]);
  expect(trajectoryNodeEventIds(byId.get('execution:tool')!)).toEqual(
    events.slice(2).map((event) => event.eventId),
  );
  expectComplete(root, events);
});

test('explicit carrier and child Run nest the child execution without merging delivery facts', () => {
  const events = [
    fact(1, { kind: 'run', runId: 'parent-run' }),
    fact(2, {
      kind: 'job',
      executionId: 'carrier',
      runId: 'parent-run',
      attributes: { childSessionId: 'child-session' },
    }),
    fact(3, {
      kind: 'child',
      executionId: 'carrier',
      runId: 'parent-run',
      phase: 'observed',
      attributes: {
        carrierExecutionId: 'carrier',
        childSessionId: 'child-session',
        childRunId: 'child-run',
        delivery: 'accepted',
      },
    }),
    fact(4, { kind: 'run', sessionId: 'child-session', runId: 'child-run' }),
    fact(5, {
      kind: 'model',
      executionId: 'child-model',
      sessionId: 'child-session',
      runId: 'child-run',
    }),
    fact(6, {
      kind: 'job',
      executionId: 'carrier',
      runId: 'parent-run',
      attributes: { childSessionId: 'child-session', delivery: 'consumed' },
    }),
  ];
  const { root, byId } = tree(events, []);
  expect(byId.get('execution:carrier')!.parentId).toBe('run:parent-run');
  expect(byId.get('child:carrier:child-session')!.parentId).toBe('execution:carrier');
  expect(byId.get('run:child-run')!.parentId).toBe('child:carrier:child-session');
  expect(byId.get('execution:child-model')!.parentId).toBe('run:child-run');
  expect(byId.get('execution:carrier')!.phase).toBe('running');
  expectComplete(root, events);
});

test('unknown, missing parent and cyclic records stay reachable and never invent a relation', () => {
  const events = [
    fact(1, { executionId: 'a', parentExecutionId: 'b' }),
    fact(2, { executionId: 'b', parentExecutionId: 'a' }),
    fact(3, { executionId: 'missing', parentExecutionId: 'absent', runId: 'run' }),
    fact(4, { executionId: 'self', parentExecutionId: 'self' }),
    fact(5, {
      kind: 'unknown',
      phase: 'observed',
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
  ];
  const { root, byId } = tree(events, []);
  for (const id of ['execution:a', 'execution:b', 'execution:self']) {
    expect(byId.get(id)!.parentId).toBe('session');
    expect(byId.get(id)!.relationNotice).toContain('循环');
  }
  expect(byId.get('execution:missing')!.relationNotice).toContain('不在当前范围');
  const unknown = byId.get(`event:${events[4]!.eventId}`)!;
  expect(unknown.kind).toBe('unknown');
  expect(unknown.parentId).toBe('session');
  expectComplete(root, events);
});

test('raw-only and incomplete indexes preserve each source fact without a terminal-state guess', () => {
  const events = [fact(1, { executionId: 'tool' }), fact(2, { executionId: 'tool' })];
  const raw = buildTrajectoryTree(null, events);
  expectComplete(raw.root, events);
  const projection = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  const incomplete = buildTrajectoryTree({ ...projection, steps: [] }, []);
  expectComplete(incomplete.root, events);
  expect(flatten(incomplete.root).filter((node) => node.kind === 'unknown')).toHaveLength(2);
});

test('legacy records keep concrete source labels without a raw page or invented typed identity', () => {
  const types = ['command.accepted', 'run.started', 'execution.running', 'execution.completed'];
  const events = types.map((sourceEventType, index) =>
    fact(index + 1, {
      kind: 'unknown',
      sourceEventType,
      phase: 'observed',
      recordedStatus: index === 2 ? 'running' : null,
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
  );
  const { root, byId } = tree(events, []);
  expect(root.children.map((node) => node.label)).toEqual(types.map((type) => `旧记录 · ${type}`));
  for (const event of events) {
    const node = byId.get(`event:${event.eventId}`)!;
    expect(node.kind).toBe('unknown');
    expect(node.parentId).toBe('session');
    expect(node.children).toHaveLength(0);
    expect(node.step!.identityConfidence).toBe('legacy_local');
    expect(node.step!.sourceEventType).toBe(event.sourceEventType);
    expect(node.step!.sourceEvidenceIds).toEqual([]);
    expect(node.step).not.toHaveProperty('runId');
    expect(node.step).not.toHaveProperty('executionId');
    expect(node.step).not.toHaveProperty('parentExecutionId');
  }
  expectComplete(root, events);
});

test('new unknown records differ from legacy labels and old indexes may use only their loaded raw metadata', () => {
  const events = [
    fact(1, {
      kind: 'unknown',
      sourceEventType: 'extension.recorded',
      phase: 'observed',
      identityConfidence: 'verified_origin',
      attributes: { reason: 'unrecognized_source_type' },
    }),
    fact(2, {
      kind: 'unknown',
      sourceEventType: 'execution.running',
      phase: 'observed',
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
  ];
  const projection = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  const indexed = buildTrajectoryTree(projection, []);
  expect(indexed.root.children.map((node) => node.label)).toEqual([
    '未识别事件 · extension.recorded',
    '旧记录 · execution.running',
  ]);
  const older = {
    ...projection,
    steps: projection.steps.map(
      ({ sourceEventType: _type, identityConfidence: _confidence, ...step }) => step,
    ),
  };
  const unloaded = buildTrajectoryTree(older, []);
  expect(unloaded.root.children.map((node) => node.label)).toEqual(['未识别事件', '未识别事件']);
  const loaded = buildTrajectoryTree(older, events);
  expect(loaded.root.children.map((node) => node.label)).toEqual([
    '未识别事件 · extension.recorded',
    '旧记录 · execution.running',
  ]);
  expect(older.steps[0]).not.toHaveProperty('sourceEventType');
  expect(older.steps[1]).not.toHaveProperty('identityConfidence');
  expectComplete(indexed.root, events);
  expectComplete(unloaded.root, events);
  expectComplete(loaded.root, events);
});

test('focused tree includes only explicit business classes and their complete own lifecycle records', () => {
  const events = [
    fact(1, { kind: 'run', runId: 'run', phase: 'running' }),
    fact(2, { kind: 'model', executionId: 'model', runId: 'run', phase: 'planned' }),
    fact(3, { executionId: 'tool', parentExecutionId: 'model', runId: 'run' }),
    fact(4, {
      kind: 'job',
      executionId: 'job',
      runId: 'run',
      attributes: { childSessionId: 'child' },
    }),
    fact(5, {
      kind: 'child',
      executionId: 'job',
      runId: 'run',
      attributes: { childSessionId: 'child', carrierExecutionId: 'job' },
    }),
    fact(6, {
      kind: 'interaction',
      executionId: 'tool',
      runId: 'run',
      attributes: { interactionId: 'approval', revision: '1', interactionKind: 'approval' },
    }),
    fact(7, {
      kind: 'interaction',
      executionId: 'tool',
      runId: 'run',
      attributes: { interactionId: 'plan', revision: '1', interactionKind: 'plan_review' },
    }),
    fact(8, {
      kind: 'interaction',
      executionId: 'tool',
      runId: 'run',
      attributes: { interactionId: 'question', revision: '1', interactionKind: 'question' },
    }),
    fact(9, {
      kind: 'interaction',
      executionId: 'tool',
      runId: 'run',
      attributes: { interactionId: 'old-interaction', revision: '1' },
    }),
    fact(10, {
      kind: 'context',
      executionId: 'model',
      runId: 'run',
      sourceEventType: 'context.compressed',
      phase: 'observed',
      attributes: {
        action: 'compressed',
        compressionId: 'automatic',
        compressionTrigger: 'automatic',
      },
    }),
    fact(11, {
      kind: 'context',
      runId: 'run',
      sourceEventType: 'context.compressed',
      phase: 'observed',
      attributes: { action: 'compressed', compressionId: 'manual', compressionTrigger: 'manual' },
    }),
    fact(12, {
      kind: 'context',
      runId: 'run',
      sourceEventType: 'context.compressed',
      phase: 'observed',
      attributes: { action: 'compressed', compressionId: 'old' },
    }),
    fact(13, {
      kind: 'context',
      runId: 'run',
      sourceEventType: 'context.selected',
      phase: 'observed',
      attributes: { action: 'selected' },
    }),
    fact(14, {
      kind: 'model',
      executionId: 'compression-model',
      runId: 'run',
      attributes: { compressionId: 'automatic', compressionTrigger: 'automatic' },
    }),
    fact(15, { kind: 'model', executionId: 'model', runId: 'run', phase: 'completed' }),
    fact(16, {
      kind: 'verification',
      executionId: 'tool',
      runId: 'run',
      attributes: { verificationId: 'verification', outcome: 'passed', method: 'required_check' },
    }),
    fact(17, {
      kind: 'artifact',
      executionId: 'tool',
      runId: 'run',
      attributes: { artifactId: 'artifact' },
    }),
    fact(18, {
      kind: 'unknown',
      sourceEventType: 'execution.running',
      phase: 'observed',
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
  ];
  const { root, byId } = tree(events, []);
  const focused = filterTrajectoryTree(root, 'key_steps');
  const accepted = new Set([2, 3, 4, 5, 6, 7, 10, 14, 15]);
  expect([...focused.eventIds]).toEqual(
    events.filter((event) => accepted.has(Number(event.sequence))).map((event) => event.eventId),
  );
  expect(focused.visibleNodeIds.has('session')).toBe(true);
  expect(focused.visibleNodeIds.has('run:run')).toBe(true);
  expect([...focused.structuralNodeIds].sort()).toEqual(['run:run', 'session']);
  expect(byId.get('execution:compression-model')!.label).toBe('自动压缩');
  expect(byId.get(`event:${events[9]!.eventId}`)!.label).toBe('压缩结果');
  expect(byId.get('interaction:approval')!.label).toBe('审批');
  expect(byId.get('interaction:plan')!.label).toBe('计划审批');
  expect(focused.visibleNodeIds.has('interaction:question')).toBe(false);
  expect(focused.visibleNodeIds.has('interaction:old-interaction')).toBe(false);
  expect(trajectoryNodeEventIds(byId.get('execution:tool')!)).toContain(events[15]!.eventId);
  expect(focused.eventIds.has(events[15]!.eventId)).toBe(false);
  const full = filterTrajectoryTree(root, 'all_events');
  expect(full.visibleNodeIds.size).toBe(byId.size);
  expect(full.structuralNodeIds.has('run:run')).toBe(false);
  expect([...full.eventIds]).toEqual(events.map((event) => event.eventId));
  expectComplete(root, events);
});

test('title maintenance definitions suppress only their exact explicit subtrees in focused mode', () => {
  const events = [
    fact(1, {
      executionId: 'title',
      attributes: { definitionId: 'builtin.session-title/generate' },
    }),
    fact(2, { kind: 'model', executionId: 'title-model', parentExecutionId: 'title' }),
    fact(3, {
      executionId: 'fallback',
      attributes: { definitionId: 'builtin.session-title/fallback' },
    }),
    fact(4, { executionId: 'fallback-child', parentExecutionId: 'fallback' }),
    fact(5, {
      executionId: 'similar',
      attributes: { definitionId: 'builtin.session-title/generate-extra' },
    }),
    fact(6, {
      executionId: 'other',
      attributes: { definitionId: 'other.session-title/generate' },
    }),
    fact(7, {
      kind: 'command',
      attributes: { commandId: 'title-command', commandType: 'session.title' },
    }),
    fact(8, { kind: 'model', executionId: 'ordinary', attributes: { commandId: 'title-command' } }),
  ];
  const { root, byId } = tree(events, []);
  const focused = filterTrajectoryTree(root, 'key_steps');
  for (const id of ['title', 'title-model', 'fallback', 'fallback-child'])
    expect(focused.visibleNodeIds.has(`execution:${id}`)).toBe(false);
  for (const id of ['similar', 'other', 'ordinary'])
    expect(focused.visibleNodeIds.has(`execution:${id}`)).toBe(true);
  expect([...focused.eventIds]).toEqual([
    events[4]!.eventId,
    events[5]!.eventId,
    events[7]!.eventId,
  ]);
  expect(filterTrajectoryTree(root, 'all_events').visibleNodeIds.size).toBe(byId.size);
  expectComplete(root, events);
});

test('hidden intermediate ancestors keep their original parent chain but none of their own default facts', () => {
  const events = [
    fact(1, { kind: 'artifact', attributes: { artifactId: 'middle' } }),
    fact(2, { kind: 'model', executionId: 'business' }),
  ];
  const { root, byId } = tree(events, []);
  const middle = byId.get('artifact:middle')!;
  const business = byId.get('execution:business')!;
  // A non-business relationship carrier may sit between a structural group and a call.
  // This fixture supplies that original path; the display filter must never rewrite it.
  root.children = [middle];
  middle.children = [business];
  business.parentId = middle.id;
  const original = JSON.stringify(root);
  const focused = filterTrajectoryTree(root, 'key_steps');
  expect([...focused.visibleNodeIds].sort()).toEqual([
    'artifact:middle',
    'execution:business',
    'session',
  ]);
  expect([...focused.structuralNodeIds].sort()).toEqual(['artifact:middle', 'session']);
  expect([...focused.eventIds]).toEqual([events[1]!.eventId]);
  expect(business.parentId).toBe(middle.id);
  expect(JSON.stringify(root)).toBe(original);
  expect(trajectoryNodeEventIds(middle)).toEqual(events.map((event) => event.eventId));
});

test('focused visibility handles ten thousand real parent links iteratively without losing lifecycle membership', () => {
  const events = Array.from({ length: 10_000 }, (_, index) =>
    fact(index + 1, {
      executionId: `depth-${index}`,
      ...(index ? { parentExecutionId: `depth-${index - 1}` } : {}),
    }),
  );
  const { root, byId } = tree(events, []);
  const focused = filterTrajectoryTree(root, 'key_steps');
  expect(focused.visibleNodeIds.size).toBe(10_001);
  expect(focused.structuralNodeIds.size).toBe(1);
  expect(focused.eventIds.size).toBe(10_000);
  expect([...focused.eventIds]).toEqual(events.map((event) => event.eventId));
  expect(byId.get('execution:depth-9999')!.parentId).toBe('execution:depth-9998');
});

test('real user and assistant messages form context nodes while stream updates and Model lifecycles keep one owner each', () => {
  const message = (
    sequence: number,
    messageId: string,
    role: 'user' | 'assistant',
    status: 'complete' | 'incomplete',
    executionId?: string,
  ) =>
    fact(sequence, {
      kind: 'message',
      runId: 'run',
      sourceEventType: 'message.updated',
      phase: status === 'complete' ? 'completed' : 'observed',
      ...(executionId ? { executionId } : {}),
      attributes: {
        messageId,
        role,
        messageSeq: role === 'user' ? '1' : '2',
        revision: String(sequence),
        status,
      },
    });
  const events = [
    fact(1, { kind: 'run', runId: 'run' }),
    message(2, 'user-message', 'user', 'complete'),
    fact(3, { kind: 'model', executionId: 'model', runId: 'run', phase: 'planned' }),
    message(4, 'partial_model', 'assistant', 'incomplete', 'model'),
    fact(5, { kind: 'model', executionId: 'model', runId: 'run', phase: 'running' }),
    message(6, 'partial_model', 'assistant', 'incomplete', 'model'),
    message(7, 'partial_model', 'assistant', 'complete', 'model'),
    fact(8, { kind: 'model', executionId: 'model', runId: 'run', phase: 'completed' }),
  ];
  const { root, byId } = tree(events, []);
  const user = byId.get('message:user-message')!,
    reply = byId.get('message:partial_model')!,
    model = byId.get('execution:model')!;
  expect(user.label).toBe('用户消息');
  expect(reply.label).toBe('Agent 回复');
  expect(user.parentId).toBe('run:run');
  expect(reply.parentId).toBe('execution:model');
  expect(reply.sourceEventIds).toEqual([
    events[3]!.eventId,
    events[5]!.eventId,
    events[6]!.eventId,
  ]);
  expect(model.sourceEventIds).toEqual([
    events[2]!.eventId,
    events[4]!.eventId,
    events[7]!.eventId,
  ]);
  expect(trajectoryNodeEventIds(model)).toEqual(events.slice(2).map((event) => event.eventId));
  const focused = filterTrajectoryTree(root, 'key_steps');
  expect(focused.visibleNodeIds.has(user.id)).toBe(true);
  expect(focused.visibleNodeIds.has(reply.id)).toBe(true);
  expect([...focused.eventIds]).toEqual(events.slice(1).map((event) => event.eventId));
  expectComplete(root, events);
});

test('message relationships use only explicit Model and Run identities, without a first-source or nearest-time guess', () => {
  const events = [
    fact(1, { kind: 'run', runId: 'run' }),
    fact(2, { kind: 'model', executionId: 'model', runId: 'run' }),
    fact(3, { executionId: 'tool', runId: 'run' }),
    fact(4, {
      kind: 'message',
      runId: 'run',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'unbound',
        role: 'assistant',
        messageSeq: '1',
        revision: '4',
        status: 'complete',
      },
    }),
    fact(5, {
      kind: 'message',
      runId: 'run',
      executionId: 'tool',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'not-a-model',
        role: 'assistant',
        messageSeq: '2',
        revision: '5',
        status: 'complete',
      },
    }),
    fact(6, {
      kind: 'message',
      runId: 'run',
      executionId: 'model',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'user',
        role: 'user',
        messageSeq: '3',
        revision: '6',
        status: 'complete',
      },
    }),
    fact(7, {
      kind: 'message',
      sourceEventType: 'message.updated',
      attributes: {
        messageId: 'pending-user',
        role: 'user',
        messageSeq: '4',
        revision: '7',
        status: 'complete',
      },
    }),
  ];
  const { root, byId } = tree(events, []);
  for (const id of ['message:unbound', 'message:not-a-model', 'message:user'])
    expect(byId.get(id)!.parentId).toBe('run:run');
  expect(byId.get('message:not-a-model')!.relationNotice).toContain('关联');
  expect(byId.get('message:pending-user')!.parentId).toBe('session');
  expectComplete(root, events);
});

test('pre-message Model checkpoints and legacy message logs do not synthesize a conversation node', () => {
  const events = [
    fact(1, { kind: 'model', executionId: 'old-model', sourceEventType: 'message.updated' }),
    fact(2, {
      kind: 'unknown',
      sourceEventType: 'message.updated',
      phase: 'observed',
      identityConfidence: 'legacy_local',
      attributes: { reason: 'legacy_fields_missing' },
    }),
  ];
  const { root, byId } = tree(events, []);
  expect([...byId.values()].some((node) => node.kind === 'message')).toBe(false);
  expect(byId.get('execution:old-model')!.sourceEventIds).toEqual([events[0]!.eventId]);
  expectComplete(root, events);
});

test('many independent child carriers resolve exact Run namespaces without repeated bridge scans', () => {
  const events: TrajectoryEvent[] = [];
  for (let index = 0; index < 2500; index++) {
    events.push(
      fact(index * 2 + 1, {
        kind: 'job',
        executionId: `carrier-${index}`,
        attributes: { childSessionId: `child-${index}` },
      }),
    );
    events.push(
      fact(index * 2 + 2, {
        kind: 'run',
        sessionId: `child-${index}`,
        runId: `run-${index}`,
        attributes: {},
      }),
    );
  }
  const result = tree(events, []);
  for (const index of [0, 1200, 2499])
    expect(result.byId.get(`run:run-${index}`)!.parentId).toBe(`execution:carrier-${index}`);
  expect(trajectoryNodeEventIds(result.root)).toEqual(events.map((event) => event.eventId));
});
