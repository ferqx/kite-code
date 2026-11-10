import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { trajectoryRequestTargets } from '../src/desktop/trajectory/request-details';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import { buildTrajectoryWorkbench, type WorkbenchRow } from '../src/desktop/trajectory/workbench';
import {
  normalizeTrajectoryDetailTab,
  type TrajectoryDetailTab,
  trajectoryCompressionMetadata,
  trajectoryDetailKind,
  trajectoryDetailTabs,
  trajectoryMaterialTargets,
  trajectoryModelRequestGroups,
  trajectorySelectedMember,
  trajectorySelectedObservation,
} from '../src/desktop/trajectory/workbench-details';

const ref = (kind: TrajectoryEvidenceRef['kind'], name: string): TrajectoryEvidenceRef => ({
  kind,
  evidenceId: name,
  contentVersion: `${name}-version`,
  availability: 'available',
  mediaType: 'application/json',
});
function fact(sequence: number, values: Record<string, unknown>): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
    sequence: String(sequence),
    origin: { storeId: 'store', cursor: String(sequence) },
    sessionId: 's',
    workspaceId: 'w',
    runId: 'run',
    kind: 'tool',
    sourceEventType: 'execution.changed',
    sourceRecordRevision: String(sequence),
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: sequence,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
function rows(events: TrajectoryEvent[]) {
  const projection = projectTrajectory(events, {
    atCursor: events.at(-1)!.sequence,
    completePrefix: true,
  });
  return buildTrajectoryWorkbench(projection, buildTrajectoryTree(projection, []));
}

test('detail tabs follow the real node type, preserve supported tabs and safely migrate legacy values', () => {
  const result = rows([
    fact(1, { executionId: 'tool' }),
    fact(2, { kind: 'model', executionId: 'model' }),
    fact(3, {
      kind: 'message',
      attributes: {
        messageId: 'message',
        role: 'user',
        messageSeq: '1',
        revision: '3',
        status: 'complete',
      },
    }),
  ]);
  const tool = result.byId.get('execution:tool')!,
    model = result.byId.get('execution:model')!,
    message = result.byId.get('message:message')!;
  expect(trajectoryDetailTabs(tool)).toEqual(['overview', 'parameters', 'result']);
  expect(trajectoryDetailTabs(model)).toEqual(['overview', 'preview']);
  expect(trajectoryDetailTabs(message)).toEqual(['content']);
  expect(normalizeTrajectoryDetailTab(message, 'preview')).toBe('content');
  expect(trajectoryDetailTabs(result.byId.get('session')!)).toEqual(['overview']);
  expect(normalizeTrajectoryDetailTab(model, 'parameters')).toBe('overview');
  expect(normalizeTrajectoryDetailTab(tool, 'preview')).toBe('overview');
  expect(normalizeTrajectoryDetailTab(message, 'raw')).toBe('content');
  for (const node of result.rows) {
    expect(trajectoryDetailTabs(node)).not.toContain('raw');
    expect(normalizeTrajectoryDetailTab(node, 'raw')).toBe(trajectoryDetailTabs(node)[0]!);
  }
  for (const legacy of ['input', 'output', 'lifecycle', 'raw'])
    expect(normalizeTrajectoryDetailTab(tool, legacy)).toBe('overview');
});

test('input and output targets retain exact independent original observations and never fall into a future or foreign revision', () => {
  const events = [
    fact(1, {
      executionId: 'tool',
      phase: 'planned',
      evidenceRefs: [ref('tool_input', 'input-old')],
    }),
    fact(2, {
      executionId: 'tool',
      evidenceRefs: [ref('tool_result', 'output-old'), ref('artifact', 'image-old')],
    }),
    fact(3, { executionId: 'other', evidenceRefs: [ref('tool_result', 'foreign')] }),
    fact(4, {
      executionId: 'tool',
      phase: 'completed',
      evidenceRefs: [
        ref('tool_result', 'output-final'),
        ref('artifact', 'image-final-a'),
        ref('artifact', 'image-final-b'),
        ref('file_change', 'diff-final'),
      ],
    }),
  ];
  const row = rows(events).byId.get('execution:tool')!;
  expect(
    trajectoryMaterialTargets(row, 'parameters').map((target) => [
      target.event.sequence,
      target.reference.evidenceId,
    ]),
  ).toEqual([['1', 'input-old']]);
  expect(
    trajectoryMaterialTargets(row, 'result', events[1]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['output-old', 'image-old']);
  expect(
    trajectoryMaterialTargets(row, 'result').map((target) => target.reference.evidenceId),
  ).toEqual(['output-final', 'image-final-a', 'image-final-b', 'diff-final']);
  expect(trajectoryMaterialTargets(row, 'result', events[2]!.eventId)).toEqual([]);
  expect(trajectoryMaterialTargets(row, 'parameters', 'missing-revision')).toEqual([]);
  expect(trajectorySelectedObservation(row, events[1]!.eventId)?.sequence).toBe('2');
  expect(trajectoryMaterialTargets(row, 'overview')).toEqual([]);
});

test('a known type with no saved material retains its tab and missing target, without exposing another linked object', () => {
  const result = rows([
    fact(1, { executionId: 'tool' }),
    fact(2, {
      kind: 'model',
      executionId: 'model',
      evidenceRefs: [ref('model_input', 'other-input'), ref('model_output', 'other-output')],
    }),
  ]);
  const tool = result.byId.get('execution:tool')!;
  expect(trajectoryDetailTabs(tool)).toContain('parameters');
  expect(trajectoryMaterialTargets(tool, 'parameters')).toEqual([]);
  expect(trajectoryMaterialTargets(tool, 'result')).toEqual([]);
  const legacy = { ...tool, events: [] } as WorkbenchRow;
  expect(trajectoryMaterialTargets(legacy, 'raw')).toEqual([]);
});

test('published compression links only its explicitly bound Model summary and keeps adoption separate from generation', () => {
  const events = [
    fact(1, {
      kind: 'model',
      executionId: 'compress',
      attributes: {
        compressionId: 'c',
        compressionTrigger: 'automatic',
        compression: { adopted: false },
      },
      evidenceRefs: [ref('model_output', 'candidate-summary')],
    }),
    fact(2, {
      kind: 'model',
      executionId: 'unrelated',
      attributes: { compressionId: 'c', compressionTrigger: 'automatic' },
      evidenceRefs: [ref('model_output', 'wrong-summary')],
    }),
    fact(3, {
      kind: 'context',
      executionId: 'compress',
      sourceEventType: 'context.compressed',
      attributes: {
        compressionId: 'c',
        compressionTrigger: 'automatic',
        action: 'compressed',
        compression: {
          adopted: true,
          accounting: { basis: 'local-context-estimate-v1', beforeTokens: 100, afterTokens: 40 },
        },
      },
      evidenceRefs: [ref('context', 'adopted')],
    }),
    fact(4, {
      kind: 'model',
      executionId: 'compress',
      attributes: { compressionId: 'c', compressionTrigger: 'automatic' },
      evidenceRefs: [ref('model_output', 'future-summary')],
    }),
  ];
  const result = rows(events),
    model = result.byId.get('execution:compress')!,
    published = model.operation!.members.find((member) => member.kind === 'context')!;
  expect(trajectoryDetailKind(model)).toBe('compression');
  expect(published.step!.compression!.adopted).toBe(true);
  expect(
    trajectoryMaterialTargets(model, 'preview', events[2]!.eventId, result.byId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['candidate-summary', 'adopted']);
  expect(result.byId.get('execution:compress')!.step!.compression!.adopted).toBe(false);
  expect(trajectoryCompressionMetadata(model, null, result.byId)).toMatchObject({
    adopted: true,
    accounting: { beforeTokens: 100, afterTokens: 40 },
  });
  expect(trajectoryCompressionMetadata(model, events[0]!.eventId, result.byId)).toEqual({
    adopted: false,
  });
  expect(
    trajectoryMaterialTargets(model, 'preview', events[0]!.eventId, result.byId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['candidate-summary']);
  expect(
    trajectoryMaterialTargets(model, 'preview', null, result.byId).some(
      (target) => target.reference.evidenceId === 'adopted',
    ),
  ).toBe(true);
});

test('a logical model request defaults to its final attempt and reads only the selected original attempt', () => {
  const events = [
    fact(1, {
      kind: 'model',
      executionId: 'first',
      phase: 'planned',
      evidenceRefs: [ref('model_input', 'first-input')],
    }),
    fact(2, {
      kind: 'model',
      executionId: 'first',
      phase: 'failed',
      evidenceRefs: [ref('model_output', 'first-prefix')],
    }),
    fact(3, {
      kind: 'model',
      executionId: 'second',
      phase: 'planned',
      attributes: {
        previousExecutionId: 'first',
        previousExecutionOriginStoreId: 'store',
        retryReason: 'connection_failed',
        retryAttempt: 2,
      },
      evidenceRefs: [ref('model_input', 'second-input')],
    }),
    fact(4, {
      kind: 'model',
      executionId: 'second',
      phase: 'completed',
      attributes: {
        previousExecutionId: 'first',
        previousExecutionOriginStoreId: 'store',
        retryReason: 'connection_failed',
        retryAttempt: 2,
      },
      evidenceRefs: [ref('model_output', 'second-output')],
    }),
  ];
  const result = rows(events),
    row = result.byId.get('execution:first')!;
  expect(row.operation?.attempts).toHaveLength(2);
  expect(trajectorySelectedObservation(row)?.eventId).toBe(events[3]!.eventId);
  expect(trajectorySelectedMember(row)?.step?.executionId).toBe('second');
  expect(
    trajectoryMaterialTargets(row, 'preview').map((target) => target.reference.evidenceId),
  ).toEqual(['second-input', 'second-output']);
  expect(
    trajectoryMaterialTargets(row, 'preview', events[1]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['first-input', 'first-prefix']);
  expect(
    trajectoryMaterialTargets(row, 'preview', events[2]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['second-input']);
  expect(trajectoryMaterialTargets(row, 'preview', 'missing')).toEqual([]);
});

test('Shell parameters belong to the original launch while result defaults to the command, not a successful wait', () => {
  const display = (operation: string, target = 'command') => ({
    kind: 'shell',
    operation,
    targetExecutionId: target,
    targetExecutionOriginStoreId: 'store',
  });
  const events = [
    fact(1, {
      executionId: 'launch',
      phase: 'planned',
      attributes: { display: display('execute') },
      evidenceRefs: [ref('tool_input', 'launch-input')],
    }),
    fact(2, {
      executionId: 'launch',
      phase: 'completed',
      attributes: { display: display('execute') },
      evidenceRefs: [ref('tool_result', 'launch-receipt')],
    }),
    fact(3, {
      kind: 'job',
      executionId: 'command',
      parentExecutionId: 'launch',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: { display: display('execute') },
      evidenceRefs: [ref('job_output', 'command-prefix')],
    }),
    fact(4, {
      kind: 'job',
      executionId: 'command',
      parentExecutionId: 'launch',
      parentExecutionOriginStoreId: 'store',
      phase: 'failed',
      attributes: { display: { ...display('execute'), observedStatus: 'failed', exitCode: 1 } },
      evidenceRefs: [ref('job_output', 'command-final')],
    }),
    fact(5, {
      executionId: 'wait',
      phase: 'planned',
      attributes: { display: display('wait') },
      evidenceRefs: [ref('tool_input', 'wait-input')],
    }),
    fact(6, {
      executionId: 'wait',
      phase: 'completed',
      attributes: { display: { ...display('wait'), timedOut: true } },
      evidenceRefs: [ref('tool_result', 'wait-result')],
    }),
  ];
  const row = rows(events).byId.get('execution:launch')!;
  expect(row.operation?.type).toBe('shell');
  expect(trajectoryDetailTabs(row)).toEqual(['overview', 'parameters', 'result']);
  expect(trajectorySelectedObservation(row)?.eventId).toBe(events[3]!.eventId);
  expect(trajectorySelectedObservation(row)?.phase).toBe('failed');
  expect(
    trajectoryMaterialTargets(row, 'parameters').map((target) => target.reference.evidenceId),
  ).toEqual(['launch-input']);
  expect(
    trajectoryMaterialTargets(row, 'result').map((target) => target.reference.evidenceId),
  ).toEqual(['launch-receipt', 'command-final']);
  expect(
    trajectoryMaterialTargets(row, 'parameters', events[5]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['wait-input']);
  expect(
    trajectoryMaterialTargets(row, 'result', events[5]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['wait-result']);
  expect(trajectoryMaterialTargets(row, 'overview')).toEqual([]);
});

test('public model input groups preserve exact messages and tools without inferring instruction sources', () => {
  const system = {
      role: 'system',
      content: 'Original system instructions',
      sourceIds: ['source-a'],
    },
    history = { role: 'user', content: 'A tool result containing AGENTS.md is still user data.' },
    unsupported = { role: 'developer', content: 'Not a system instruction.' },
    tool = { id: 'files.read', schema: { type: 'object' } };
  const grouped = trajectoryModelRequestGroups({
    request: { modelId: 'actual-model', messages: [system, unsupported, history], tools: [tool] },
    metadata: { context: { sources: [{ id: 'source-a', digest: 'saved' }] } },
  })!;
  expect(grouped.system).toEqual([system]);
  expect(grouped.messages).toEqual([unsupported, history]);
  expect(grouped.tools).toEqual([tool]);
  expect(grouped.sources).toEqual(['source-a']);
  expect(grouped.modelId).toBe('actual-model');
  expect(
    trajectoryModelRequestGroups({ request: { messages: ['not-a-message'], tools: [] } }),
  ).toBeNull();
  expect(trajectoryModelRequestGroups({ content: 'not a saved request' })).toBeNull();
});

test('a Shell without a saved Job checkpoint reads only its latest associated observation by default', () => {
  const display = (operation: string) => ({
    kind: 'shell',
    operation,
    targetExecutionId: 'command',
    targetExecutionOriginStoreId: 'store',
  });
  const events = [
    fact(1, {
      executionId: 'launch',
      phase: 'planned',
      attributes: { display: display('execute') },
      evidenceRefs: [ref('tool_input', 'command-input')],
    }),
    fact(2, {
      executionId: 'launch',
      phase: 'completed',
      attributes: { display: display('execute') },
      evidenceRefs: [ref('tool_result', 'accepted')],
    }),
    fact(3, {
      kind: 'job',
      executionId: 'command',
      parentExecutionId: 'launch',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: { display: display('execute') },
    }),
    fact(4, {
      executionId: 'read-old',
      phase: 'completed',
      attributes: { display: display('read') },
      evidenceRefs: [ref('tool_result', 'old-output')],
    }),
    fact(5, {
      executionId: 'read-new',
      phase: 'completed',
      attributes: { display: display('read') },
      evidenceRefs: [ref('tool_result', 'new-output')],
    }),
  ];
  const row = rows(events).byId.get('execution:launch')!;
  expect(trajectorySelectedObservation(row)?.phase).toBe('running');
  expect(
    trajectoryMaterialTargets(row, 'result').map((target) => target.reference.evidenceId),
  ).toEqual(['accepted', 'new-output']);
  expect(
    trajectoryMaterialTargets(row, 'result', events[3]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['old-output']);
});

test('a child task previews its original delegation and actual output without treating an observer receipt as its result', () => {
  const display = (operation: string) => ({
    kind: 'task',
    operation,
    targetExecutionId: 'child-job',
    targetExecutionOriginStoreId: 'store',
    targetSessionId: 'child-session',
  });
  const events = [
    fact(1, {
      executionId: 'spawn',
      phase: 'planned',
      attributes: { display: display('spawn') },
      evidenceRefs: [ref('tool_input', 'delegation')],
    }),
    fact(2, {
      executionId: 'spawn',
      phase: 'completed',
      attributes: { display: { ...display('spawn'), accepted: true } },
      evidenceRefs: [ref('tool_result', 'spawn-receipt')],
    }),
    fact(3, {
      kind: 'job',
      executionId: 'child-job',
      parentExecutionId: 'spawn',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: { childSessionId: 'child-session', display: display('spawn') },
    }),
    fact(4, {
      kind: 'job',
      executionId: 'child-job',
      parentExecutionId: 'spawn',
      parentExecutionOriginStoreId: 'store',
      phase: 'completed',
      attributes: {
        childSessionId: 'child-session',
        delivery: 'pending',
        display: display('spawn'),
      },
      evidenceRefs: [ref('job_output', 'child-result')],
    }),
    fact(5, {
      executionId: 'observe',
      phase: 'completed',
      attributes: { display: display('events') },
      evidenceRefs: [ref('tool_result', 'observed-receipt')],
    }),
  ];
  const row = rows(events).byId.get('execution:spawn')!;
  expect(trajectoryDetailKind(row)).toBe('child');
  expect(trajectoryDetailTabs(row)).toEqual(['overview', 'preview']);
  expect(trajectorySelectedObservation(row)?.eventId).toBe(events[3]!.eventId);
  expect(
    trajectoryMaterialTargets(row, 'preview').map((target) => target.reference.evidenceId),
  ).toEqual(['delegation', 'spawn-receipt', 'child-result']);
  expect(
    trajectoryMaterialTargets(row, 'preview', events[4]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['observed-receipt']);
});

test('a child final result replaces only its own earlier Job checkpoint in the default preview', () => {
  const display = {
    kind: 'task',
    operation: 'spawn',
    targetExecutionId: 'child-job',
    targetExecutionOriginStoreId: 'store',
    targetSessionId: 'child-session',
  };
  const events = [
    fact(1, {
      executionId: 'spawn',
      phase: 'planned',
      attributes: { display },
      evidenceRefs: [ref('tool_input', 'delegation')],
    }),
    fact(2, {
      executionId: 'spawn',
      phase: 'completed',
      attributes: { display: { ...display, accepted: true } },
      evidenceRefs: [ref('tool_result', 'spawn-receipt')],
    }),
    fact(3, {
      kind: 'job',
      executionId: 'child-job',
      parentExecutionId: 'spawn',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      attributes: { childSessionId: 'child-session', display },
      evidenceRefs: [ref('job_output', 'managed-progress')],
    }),
    fact(4, {
      kind: 'job',
      executionId: 'child-job',
      parentExecutionId: 'spawn',
      parentExecutionOriginStoreId: 'store',
      phase: 'completed',
      attributes: { childSessionId: 'child-session', display },
      evidenceRefs: [ref('tool_result', 'actual-child-reply')],
    }),
  ];
  const before = JSON.stringify(events);
  const row = rows(events).byId.get('execution:spawn')!;
  const ids = (value = row, observationId?: string) =>
    trajectoryMaterialTargets(value, 'preview', observationId).map(
      (target) => target.reference.evidenceId,
    );
  expect(row.operation?.type).toBe('child');
  expect(ids()).toEqual(['delegation', 'spawn-receipt', 'actual-child-reply']);
  expect(ids(row, events[2]!.eventId)).toEqual(['managed-progress']);
  expect(ids(row, events[3]!.eventId)).toEqual(['managed-progress', 'actual-child-reply']);
  expect(ids(rows(events.slice(0, 3)).byId.get('execution:spawn')!)).toEqual([
    'delegation',
    'spawn-receipt',
    'managed-progress',
  ]);
  // The real Job writer reattaches its progress checkpoint in the terminal fact itself.
  const sameEvent = [
    ...events.slice(0, 3),
    {
      ...events[3]!,
      evidenceRefs: [
        ref('job_output', 'reattached-progress'),
        ref('tool_result', 'actual-child-reply'),
      ],
    },
  ];
  const sameRow = rows(sameEvent).byId.get('execution:spawn')!;
  expect(ids(sameRow)).toEqual(['delegation', 'spawn-receipt', 'actual-child-reply']);
  expect(ids(sameRow, events[3]!.eventId)).toEqual(['reattached-progress', 'actual-child-reply']);
  const late = fact(5, {
    kind: 'job',
    executionId: 'child-job',
    parentExecutionId: 'spawn',
    parentExecutionOriginStoreId: 'store',
    phase: 'completed',
    attributes: events[3]!.attributes,
    evidenceRefs: [ref('job_output', 'later-progress')],
  });
  expect(ids(rows([...events, late]).byId.get('execution:spawn')!)).toContain('later-progress');
  for (const phase of ['failed', 'cancelled', 'outcome_unknown'] as const) {
    const changed = [...events.slice(0, 3), { ...events[3]!, phase }];
    expect(ids(rows(changed).byId.get('execution:spawn')!)).not.toContain('managed-progress');
  }
  const operation = row.operation!;
  const withResult = (change: Partial<TrajectoryEvent>): WorkbenchRow => ({
    ...row,
    operation: {
      ...operation,
      members: operation.members.map((member) =>
        member.nodeId === operation.primaryNodeId
          ? {
              ...member,
              events: member.events.map((event) =>
                event.eventId === events[3]!.eventId
                  ? ({ ...event, ...change } as TrajectoryEvent)
                  : event,
              ),
            }
          : member,
      ),
    },
  });
  for (const change of [
    { executionId: 'other-job' },
    { sessionId: 'other-session' },
    { origin: { storeId: 'other-store', cursor: '4' } },
    { executionOriginStoreId: 'other-store' },
    { runId: 'other-run' },
    { runOriginStoreId: 'other-store' },
    { identityConfidence: 'legacy_local' },
    { kind: 'tool' },
    { phase: 'running' },
    { sequence: '2' },
    {
      evidenceRefs: [{ ...ref('tool_result', 'actual-child-reply'), availability: 'unavailable' }],
    },
  ] as Partial<TrajectoryEvent>[])
    expect(ids(withResult(change))).toContain('managed-progress');
  expect(JSON.stringify(events)).toBe(before);
});

test('approval preview retains its exact saved request and answer while legacy raw restores metadata without exposing saved bytes', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { JSDOM } = await import('jsdom');
  const { TrajectoryDetails } = await import('../src/desktop/trajectory/TrajectoryDetails');
  const reference = ref('interaction', 'approval-answer');
  reference.contentVersion = 'sha256:'.concat('a9'.repeat(32));
  const event = fact(1, {
    kind: 'interaction',
    phase: 'completed',
    attributes: {
      interactionId: 'approval',
      interactionKind: 'approval',
      decision: 'accepted',
      revision: '2',
    },
    evidenceRefs: [reference],
  });
  const projection = projectTrajectory([event], { atCursor: '1', completePrefix: true });
  const tree = buildTrajectoryTree(projection, []);
  const workbench = buildTrajectoryWorkbench(projection, tree);
  const row = workbench.byId.get('interaction:approval')!;
  const node = tree.byId.get(row.nodeId)!;
  const body = Object.freeze({
    request: Object.freeze({
      title: '允许运行认证测试？',
      description: '执行本地测试并读取认证配置。',
      command: 'bun test auth',
    }),
    answer: Object.freeze({ decision: 'approve', feedback: '仅允许这一次测试。' }),
  });
  // Saved material bytes remain intact even though there is no raw-content presentation tab.
  const rawText = JSON.stringify(body, null, 4);
  const before = JSON.stringify(body);
  const previewTargets = trajectoryMaterialTargets(row, 'preview');
  expect(trajectoryMaterialTargets(row, 'overview')).toEqual([]);
  expect(previewTargets).toEqual([{ event, reference }]);
  expect(trajectoryMaterialTargets(row, normalizeTrajectoryDetailTab(row, 'raw'))).toEqual([]);
  let callbacks = 0;
  const callback = () => callbacks++;
  const render = (tab: 'preview' | 'raw') =>
    new JSDOM(
      renderToStaticMarkup(
        createElement(TrajectoryDetails, {
          node,
          active: true,
          row,
          events: [event],
          tab: normalizeTrajectoryDetailTab(row, tab),
          onTabChange: callback,
          targets: trajectoryMaterialTargets(row, normalizeTrajectoryDetailTab(row, tab)),
          materials: [
            {
              eventId: event.eventId,
              evidenceId: reference.evidenceId,
              contentVersion: reference.contentVersion,
              status: 'available',
              data: body,
              rawText,
            },
          ],
          excluded: false,
          collapsed: false,
          scrollTop: 0,
          onScroll: callback,
          onClose: callback,
          onRetry: callback,
          onParent: callback,
          relatedRows: [],
          rowsById: workbench.byId,
          onRelated: callback,
          onObservationChange: callback,
        }),
      ),
    );
  const preview = render('preview');
  expect(preview.window.document.body.textContent).not.toContain(reference.contentVersion);
  expect(preview.window.document.querySelector('.trajectory-material h4 span')).toBeNull();
  expect(preview.window.document.querySelector('.trajectory-material')?.getAttribute('title')).toBe(
    `材料版本：${reference.contentVersion}`,
  );
  expect(preview.window.document.body.textContent).not.toContain('来源');
  expect(preview.window.document.querySelector('.trajectory-detail-caption')).toBeNull();
  const readable = preview.window.document.querySelector('[aria-label="审批与问答内容"]');
  expect(readable?.textContent).toContain('请求内容');
  expect(readable?.textContent).toContain('允许运行认证测试？');
  expect(readable?.textContent).toContain('执行本地测试并读取认证配置。');
  expect(readable?.textContent).toContain('已保存的答复');
  expect(readable?.textContent).toContain('已批准');
  expect(readable?.textContent).toContain('仅允许这一次测试。');
  expect(readable?.textContent).not.toContain('"decision"');
  preview.window.close();
  const raw = render('raw');
  expect(raw.window.document.querySelector('[aria-label="原公开 JSON"]')).toBeNull();
  expect(raw.window.document.body.textContent).not.toContain(rawText);
  expect(
    Array.from(raw.window.document.querySelectorAll('[role="tab"]')).map(
      (item) => item.textContent,
    ),
  ).toEqual(['概述', '预览']);
  expect(raw.window.document.querySelector('[aria-label="审批与问答内容"]')).toBeNull();
  expect(JSON.stringify(body)).toBe(before);
  expect(callbacks).toBe(0);
  // Rendering neither adds material owners nor requests another request/answer revision.
  expect(trajectoryMaterialTargets(row, 'preview')).toEqual(previewTargets);
  raw.window.close();
});

test('model details show the frozen provider name and public thought and reply without exposing opaque IDs or private fields', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { JSDOM } = await import('jsdom');
  const { TrajectoryDetails } = await import('../src/desktop/trajectory/TrajectoryDetails');
  const inputRef = ref('model_input', 'request');
  inputRef.contentVersion = 'sha256:'.concat('b8'.repeat(32));
  const outputRef = ref('model_output', 'reply');
  const events = [
    fact(1, {
      kind: 'model',
      executionId: 'model',
      phase: 'planned',
      evidenceRefs: [inputRef],
    }),
    fact(2, {
      kind: 'model',
      executionId: 'model',
      phase: 'completed',
      attributes: { usage: { inputTokens: '123', outputTokens: '45', cachedInputTokens: '6' } },
      evidenceRefs: [outputRef],
    }),
  ];
  const projection = projectTrajectory(events, { atCursor: '2', completePrefix: true });
  const tree = buildTrajectoryTree(projection, []);
  const workbench = buildTrajectoryWorkbench(projection, tree);
  const row = workbench.byId.get('execution:model')!;
  const input = {
    request: {
      modelId: 'model-opaque-adapter-id',
      messages: [
        { role: 'system', content: '保存的系统指令。' },
        { role: 'user', content: '保存的用户问题。' },
      ],
      tools: [
        {
          id: 'public_visible_tool',
          description: '当次公开的工具说明。',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    },
    metadata: {
      adapter: {
        availability: 'available',
        provider: { availability: 'available', family: 'openai', modelId: 'gpt-6-luna' },
      },
    },
  };
  const output = {
    content: '保存的回复正文。',
    reasoning: '保存的公开思考内容。',
    toolCalls: [{ id: 'read', name: 'files.read', arguments: '{"path":"src/auth.ts"}' }],
    complete: true,
  };
  const callbacks = () => {};
  const render = (
    tab: TrajectoryDetailTab | 'raw',
    values = { input, output },
    selectedRow = row,
    materialStatus: 'available' | 'missing' | 'unavailable' | 'loading' | 'empty' = 'available',
    observationId?: string,
  ) =>
    new JSDOM(
      renderToStaticMarkup(
        createElement(TrajectoryDetails, {
          node: tree.byId.get(row.nodeId)!,
          active: true,
          row: selectedRow,
          events,
          tab: normalizeTrajectoryDetailTab(selectedRow, tab),
          observationId,
          onTabChange: callbacks,
          materials: [
            {
              eventId: events[0]!.eventId,
              evidenceId: inputRef.evidenceId,
              contentVersion: inputRef.contentVersion,
              status: materialStatus,
              data: values.input,
              rawText: JSON.stringify(values.input, null, 4),
            },
            {
              eventId: events[1]!.eventId,
              evidenceId: outputRef.evidenceId,
              contentVersion: outputRef.contentVersion,
              status: materialStatus,
              data: { ...values.output, reasoning_encrypted: 'PRIVATE_ENCRYPTED_THOUGHT' },
              rawText: JSON.stringify(values.output, null, 4),
              details: [{ label: '已保存思考（默认收起）', text: values.output.reasoning }],
            },
          ],
          targets: trajectoryMaterialTargets(
            selectedRow,
            normalizeTrajectoryDetailTab(selectedRow, tab),
            observationId,
          ),
          excluded: false,
          collapsed: false,
          scrollTop: 0,
          onScroll: callbacks,
          onClose: callbacks,
          onParent: callbacks,
          relatedRows: [],
          rowsById: workbench.byId,
          onRelated: callbacks,
        }),
      ),
    );
  const { TrajectoryRequestDetails } = await import(
    '../src/desktop/trajectory/TrajectoryRequestDetails'
  );
  const renderRequest = (values = { input, output }) =>
    new JSDOM(
      renderToStaticMarkup(
        createElement(TrajectoryRequestDetails, {
          row,
          tab: 'overview',
          targets: trajectoryRequestTargets(row, 'overview'),
          active: true,
          scrollTop: 0,
          onScroll: callbacks,
          onClose: callbacks,
          onTabChange: callbacks,
          onObservationChange: callbacks,
          materials: [
            {
              eventId: events[0]!.eventId,
              evidenceId: inputRef.evidenceId,
              contentVersion: inputRef.contentVersion,
              status: 'available',
              data: values.input,
            },
            {
              eventId: events[1]!.eventId,
              evidenceId: outputRef.evidenceId,
              contentVersion: outputRef.contentVersion,
              status: 'available',
              data: { ...values.output, reasoning_encrypted: 'PRIVATE_ENCRYPTED_THOUGHT' },
            },
          ],
        }),
      ),
    );
  const preview = render('preview');
  const content = preview.window.document.body.textContent!;
  expect(content).toContain('请求模型：gpt-6-luna');
  expect(content).not.toContain('model-opaque-adapter-id');
  expect(content).toContain('保存的系统指令。');
  expect(content).toContain('保存的用户问题。');
  const thought = preview.window.document.querySelector('[aria-label="Agent 思考"]')!;
  expect(thought.textContent).toContain('保存的公开思考内容。');
  expect(thought.closest('details')).toBeNull();
  expect(
    preview.window.document.querySelector('[aria-label="Agent 本次输出"]')?.textContent,
  ).toContain('保存的回复正文。');
  expect(content.match(/保存的公开思考内容。/g)).toHaveLength(1);
  expect(content).toContain('files.read');
  expect(content).toContain('src/auth.ts');
  expect(content).not.toContain('PRIVATE_ENCRYPTED_THOUGHT');
  preview.window.close();
  const unknown = render('preview', {
    input: {
      ...input,
      metadata: {
        adapter: {
          availability: 'unavailable',
          provider: {
            availability: 'available',
            family: '',
            modelId: 'unverified-provider-name',
          },
        },
      },
    },
    output: { ...output, reasoning: '' },
  });
  expect(unknown.window.document.body.textContent).toContain('模型名称未记录');
  expect(unknown.window.document.body.textContent).toContain('未保存可展示的思考。');
  expect(unknown.window.document.body.textContent).not.toContain('unverified-provider-name');
  unknown.window.close();
  const compressed = render('preview', { input, output }, { ...row, category: 'compression' });
  expect(compressed.window.document.body.textContent).not.toContain('保存的公开思考内容。');
  expect(compressed.window.document.querySelector('[aria-label="Agent 思考"]')).toBeNull();
  compressed.window.close();
  const raw = render('raw');
  expect(raw.window.document.querySelector('[aria-label="Agent 思考"]')).toBeNull();
  expect(raw.window.document.querySelector('[aria-label="原公开 JSON"]')).toBeNull();
  expect(raw.window.document.body.textContent).not.toContain('保存的系统指令。');
  expect(raw.window.document.body.textContent).not.toContain('保存的回复正文。');
  expect(raw.window.document.body.textContent).not.toContain('PRIVATE_ENCRYPTED_THOUGHT');
  raw.window.close();
  const overview = render('overview');
  expect(
    Array.from(overview.window.document.querySelectorAll('dt')).map((dt) => dt.textContent),
  ).not.toContain('父级');
  expect(overview.window.document.body.textContent).toContain('gpt-6-luna');
  expect(overview.window.document.body.textContent).not.toContain('model-opaque-adapter-id');
  expect(overview.window.document.body.textContent).not.toContain('来源记录');
  overview.window.close();
  for (const [status, expectedLabel] of [
    ['loading', '正在读取模型名称…'],
    ['unavailable', '模型名称暂不可读'],
    ['missing', '模型名称暂不可读'],
    ['empty', '模型名称未保存'],
  ] as const) {
    const pending = render('overview', { input, output }, row, status);
    expect(pending.window.document.body.textContent).toContain(expectedLabel);
    expect(pending.window.document.body.textContent).not.toContain('gpt-6-luna');
    expect(pending.window.document.body.textContent).not.toContain('model-opaque-adapter-id');
    pending.window.close();
  }
  for (const [kind, expected, excluded] of [
    ['system', '保存的系统指令。', '保存的用户问题。'],
    ['input', '保存的用户问题。', '保存的系统指令。'],
    ['thinking', '保存的公开思考内容。', '保存的回复正文。'],
    ['reply', '保存的回复正文。', '保存的公开思考内容。'],
  ] as const) {
    const partRow: WorkbenchRow = {
      ...row,
      id: `${row.id}:part:${kind}`,
      parentId: row.id,
      label: { system: '系统提示词', input: '请求用户上下文', thinking: '思考', reply: '本次输出' }[
        kind
      ],
      virtualPart: {
        kind,
        ownerId: row.id,
        source: kind === 'system' || kind === 'input' ? 'model_input' : 'model_output',
        targets: [
          kind === 'system' || kind === 'input'
            ? { event: events[0]!, reference: inputRef }
            : { event: events[1]!, reference: outputRef },
        ],
      },
    };
    const partTabs = trajectoryDetailTabs(partRow);
    expect(normalizeTrajectoryDetailTab(partRow, 'raw')).toBe(partTabs[0]!);
    expect(partTabs).toEqual(
      kind === 'system'
        ? ['system_prompt', 'tools']
        : kind === 'thinking'
          ? ['thinking']
          : ['content'],
    );
    for (const tab of [partTabs[0]!]) {
      const part = render(tab, { input, output }, partRow);
      expect(part.window.document.body.textContent).toContain(expected);
      expect(part.window.document.body.textContent).not.toContain(excluded);
      expect(part.window.document.body.textContent).not.toContain('PRIVATE_ENCRYPTED_THOUGHT');
      if (kind === 'thinking') {
        expect(part.window.document.querySelector('.trajectory-detail-summary')).toBeNull();
        expect(part.window.document.querySelector('[aria-label="请求计时"]')).toBeNull();
        const request = renderRequest();
        expect(request.window.document.body.textContent).toContain('状态');
        expect(request.window.document.body.textContent).toContain('gpt-6-luna');
        expect(request.window.document.body.textContent).toContain('输出 Token');
        expect(request.window.document.body.textContent).toContain('45');
        expect(request.window.document.querySelector('[aria-label="请求计时"]')).not.toBeNull();
        expect(request.window.document.body.textContent).not.toContain('保存的公开思考内容。');
        request.window.close();
      } else expect(part.window.document.querySelector('dl.trajectory-metadata')).toBeNull();
      if (kind === 'thinking')
        expect(
          part.window.document.querySelector('[aria-label="Agent 思考"]')?.closest('details'),
        ).toBeNull();
      if (kind === 'thinking')
        expect(
          Array.from(part.window.document.querySelectorAll('h3, h4')).filter(
            (heading) => heading.textContent === '思考内容',
          ),
        ).toHaveLength(1);
      if (kind === 'thinking') {
        expect(part.window.document.body.textContent).not.toContain('查看该次公开输出');
        expect(part.window.document.querySelector('.trajectory-material-source')).toBeNull();
        const unavailable = render(
          'thinking',
          { input, output },
          partRow,
          'available',
          'absent-observation',
        );
        expect(unavailable.window.document.body.textContent).toContain('此版本不在当前历史范围中');
        expect(unavailable.window.document.body.textContent).not.toContain('gpt-6-luna');
        expect(unavailable.window.document.body.textContent).not.toContain('保存的公开思考内容。');
        unavailable.window.close();
      }
      if (kind === 'system')
        expect(part.window.document.querySelector('[aria-label="系统提示词"] h4')).toBeNull();
      if (kind === 'reply') expect(part.window.document.body.textContent).toContain('Agent 说明');
      if (kind === 'input') {
        expect(part.window.document.querySelector('[aria-label="本次请求上下文"]')).not.toBeNull();
        expect(part.window.document.body.textContent).not.toContain('未将其推定为当前用户唯一一次');
        expect(part.window.document.body.textContent).not.toContain(inputRef.contentVersion);
        const source = part.window.document.querySelector('.trajectory-material-source');
        expect(source).toBeNull();
        expect(
          part.window.document.querySelector('.trajectory-material')?.getAttribute('title'),
        ).toBe(`材料版本：${inputRef.contentVersion}`);
        expect(
          part.window.document
            .querySelector('[data-slot="accordion-trigger"]')
            ?.getAttribute('aria-expanded'),
        ).toBe('true');
        const bodyHash = render(
          tab,
          {
            input: {
              ...input,
              request: {
                ...input.request,
                messages: [{ role: 'user', content: `请检查 ${inputRef.contentVersion}` }],
              },
            },
            output,
          },
          partRow,
        );
        expect(
          bodyHash.window.document.querySelector(
            '[aria-label="本次请求上下文"] [data-slot="accordion-content"]',
          )?.textContent,
        ).toBe(`请检查 ${inputRef.contentVersion}`);
        expect(
          bodyHash.window.document.body.textContent?.split(inputRef.contentVersion),
        ).toHaveLength(2);
        bodyHash.window.close();
      }
      part.window.close();
    }
    for (const [status, expectedStatus] of [
      ['missing', '未保存此材料。'],
      ['unavailable', '此材料当前不可读取。'],
      ['loading', '正在读取原版本材料…'],
      ['empty', '已保存的内容为空。'],
    ] as const) {
      const part = render(partTabs[0]!, { input, output }, partRow, status);
      expect(part.window.document.body.textContent).toContain(expectedStatus);
      expect(part.window.document.body.textContent).not.toContain(expected);
      part.window.close();
    }
    if (kind === 'system') {
      const tools = render('tools', { input, output }, partRow);
      expect(tools.window.document.body.textContent).toContain('public_visible_tool');
      expect(tools.window.document.body.textContent).toContain('当次公开的工具说明。');
      expect(tools.window.document.querySelector('details > summary')?.textContent).toContain(
        'public_visible_tool',
      );
      expect(tools.window.document.querySelector('[aria-label="原公开 JSON"]')).toBeNull();
      expect(tools.window.document.querySelector('details')?.hasAttribute('open')).toBe(false);
      tools.window.close();
    }
    if (kind === 'thinking') {
      const withSettings = {
        input: {
          ...input,
          metadata: {
            adapter: {
              ...input.metadata.adapter,
              settings: {
                temperature: 0.4,
                reasoningEffort: 'high',
                SECRET_PRIVATE_SETTING: 'NEVER_SHOW_SETTING',
              },
            },
          },
        },
        output,
      };
      const info = renderRequest(withSettings);
      const infoText = info.window.document.body.textContent!;
      expect(infoText).toContain('gpt-6-luna');
      expect(infoText).toContain('0.4');
      expect(infoText).toContain('high');
      expect(infoText).toContain('123');
      expect(infoText).toContain('45');
      expect(infoText).not.toContain('保存的系统指令。');
      expect(infoText).not.toContain('保存的用户问题。');
      expect(infoText).not.toContain('保存的公开思考内容。');
      expect(infoText).not.toContain('public_visible_tool');
      expect(infoText).not.toContain('NEVER_SHOW_SETTING');
      info.window.close();
    }
  }
});

test('flat system and thinking stages retain all four exact retry choices and read only their selected original attempt', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { JSDOM } = await import('jsdom');
  const { TrajectoryDetails } = await import('../src/desktop/trajectory/TrajectoryDetails');
  const events: TrajectoryEvent[] = [];
  for (let index = 0; index < 4; index++) {
    const attributes = index
      ? {
          previousExecutionId: `retry-${index - 1}`,
          previousExecutionOriginStoreId: 'store',
          retryReason: 'connection_failed',
          retryAttempt: index + 1,
        }
      : {};
    events.push(
      fact(index * 2 + 1, {
        kind: 'model',
        executionId: `retry-${index}`,
        phase: 'planned',
        attributes,
        evidenceRefs: [ref('model_input', `retry-input-${index}`)],
      }),
    );
    events.push(
      fact(index * 2 + 2, {
        kind: 'model',
        executionId: `retry-${index}`,
        phase: index === 3 ? 'completed' : 'failed',
        attributes,
        evidenceRefs: [ref('model_output', `retry-output-${index}`)],
      }),
    );
  }
  const projection = projectTrajectory(events, { atCursor: '8', completePrefix: true });
  const tree = buildTrajectoryTree(projection, []),
    workbench = buildTrajectoryWorkbench(projection, tree);
  const owner = workbench.byId.get('execution:retry-0')!;
  const materials = events.flatMap((event) =>
    event.evidenceRefs.map((reference) => ({
      eventId: event.eventId,
      evidenceId: reference.evidenceId,
      contentVersion: reference.contentVersion,
      status: 'available' as const,
      data:
        reference.kind === 'model_input'
          ? {
              request: {
                modelId: 'OPAQUE_BINDING',
                messages: [{ role: 'system', content: `system-attempt-${event.executionId}` }],
                tools: [],
              },
              metadata: {
                adapter: {
                  availability: 'available',
                  provider: { availability: 'available', modelId: `provider-${event.executionId}` },
                },
              },
            }
          : {
              reasoning: `thought-attempt-${event.executionId}`,
              content: '',
              toolCalls: [],
              complete: event.phase === 'completed',
            },
    })),
  );
  for (const kind of ['system', 'thinking'] as const) {
    const row: WorkbenchRow = {
      ...owner,
      id: `${owner.id}:part:${kind}`,
      label: kind === 'system' ? '系统提示词' : '思考',
      virtualPart: {
        kind,
        ownerId: owner.id,
        source: kind === 'system' ? 'model_input' : 'model_output',
        targets: [],
      },
    };
    const tab = kind === 'system' ? 'system_prompt' : 'thinking';
    const original = events[3]!.eventId;
    const noop = () => {};
    const document = new JSDOM(
      renderToStaticMarkup(
        createElement(TrajectoryDetails, {
          node: tree.byId.get(owner.nodeId)!,
          active: true,
          row,
          events,
          tab,
          onTabChange: noop,
          materials,
          targets: trajectoryMaterialTargets(row, tab, original),
          excluded: false,
          collapsed: false,
          scrollTop: 0,
          onScroll: noop,
          onClose: noop,
          onParent: noop,
          relatedRows: [],
          rowsById: workbench.byId,
          onRelated: noop,
          observationId: original,
          onObservationChange: noop,
        }),
      ),
    );
    const body = document.window.document.body;
    expect(
      body.querySelector('details.trajectory-request-retries > summary')?.textContent,
    ).toContain('重连 3 次');
    expect(body.querySelectorAll('[aria-label="模型重连记录"] li button')).toHaveLength(4);
    expect(
      body.querySelector('details.trajectory-request-retries > summary')?.textContent,
    ).toContain('4 次已保存请求');
    expect(body.querySelector('[aria-label="模型重连记录"]')?.textContent).not.toContain(
      '4 次已保存请求',
    );
    expect(body.querySelector('[aria-label="模型重连记录"]')?.textContent).not.toContain(
      '重连记录',
    );
    expect(body.textContent).toContain('返回最新一次请求');
    expect(body.textContent).not.toContain('system-attempt-retry-3');
    expect(body.textContent).not.toContain('provider-retry-3');
    expect(body.textContent).not.toContain('OPAQUE_BINDING');
    expect(body.textContent).toContain(
      kind === 'system' ? 'system-attempt-retry-1' : 'thought-attempt-retry-1',
    );
    document.window.close();
    if (kind === 'thinking') {
      const { TrajectoryRequestDetails } = await import(
        '../src/desktop/trajectory/TrajectoryRequestDetails'
      );
      const request = new JSDOM(
        renderToStaticMarkup(
          createElement(TrajectoryRequestDetails, {
            row: owner,
            tab: 'overview',
            targets: trajectoryRequestTargets(owner, 'overview', original),
            materials,
            observationId: original,
            active: true,
            scrollTop: 0,
            onScroll: noop,
            onClose: noop,
            onTabChange: noop,
            onObservationChange: noop,
          }),
        ),
      );
      expect(request.window.document.body.textContent).toContain('provider-retry-1');
      expect(request.window.document.body.textContent).not.toContain('provider-retry-3');
      expect(request.window.document.body.textContent).not.toContain('thought-attempt-retry-1');
      expect(
        request.window.document.querySelectorAll('.trajectory-request-retries li button'),
      ).toHaveLength(4);
      request.window.close();
    }
  }
});

test('overview keeps one action and typed result while folding provenance and separating compression capacity from model usage', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { JSDOM } = await import('jsdom');
  const { TrajectoryDetails } = await import('../src/desktop/trajectory/TrajectoryDetails');
  const target = (kind: 'shell' | 'task', operation: 'execute' | 'spawn', id: string) => ({
    kind,
    operation,
    targetExecutionId: id,
    targetExecutionOriginStoreId: 'store',
  });
  const fileDisplay = { kind: 'file', title: '读取文件', summary: 'src/unique-target.ts' };
  const shell = target('shell', 'execute', 'command');
  const child = target('task', 'spawn', 'child-job');
  const events = [
    fact(1, {
      executionId: 'read',
      phase: 'planned',
      attributes: { definitionId: 'files.read', display: fileDisplay },
    }),
    fact(2, {
      executionId: 'read',
      phase: 'completed',
      attributes: { definitionId: 'files.read', display: fileDisplay },
    }),
    fact(3, { executionId: 'launch', phase: 'completed', attributes: { display: shell } }),
    fact(4, {
      kind: 'job',
      executionId: 'command',
      parentExecutionId: 'launch',
      parentExecutionOriginStoreId: 'store',
      phase: 'cancelled',
      attributes: { display: { ...shell, exitCode: 130, cancelRequested: true } },
    }),
    fact(5, {
      executionId: 'spawn',
      phase: 'completed',
      attributes: { display: { ...child, accepted: true } },
    }),
    fact(6, {
      kind: 'job',
      executionId: 'child-job',
      parentExecutionId: 'spawn',
      parentExecutionOriginStoreId: 'store',
      phase: 'completed',
      attributes: { display: child, childSessionId: 'child', delivery: 'pending' },
    }),
    fact(7, {
      kind: 'model',
      executionId: 'compress',
      phase: 'completed',
      attributes: {
        compressionId: 'cmp',
        compressionTrigger: 'automatic',
        compression: {
          adopted: true,
          accounting: { basis: 'local-context-estimate-v1', beforeTokens: 500, afterTokens: 100 },
          triggerTokens: 550,
          triggerBasis: 'local_estimate',
          thresholdTokens: 400,
        },
        usage: { inputTokens: '450', outputTokens: '30', cachedInputTokens: '0' },
      },
    }),
  ];
  const original = JSON.stringify(events);
  const projection = projectTrajectory(events, { atCursor: '7', completePrefix: true });
  const tree = buildTrajectoryTree(projection, []),
    workbench = buildTrajectoryWorkbench(projection, tree);
  let callbacks = 0;
  const noop = () => {
    callbacks++;
  };
  const render = (id: string, observationId?: string) => {
    const row = workbench.byId.get(id)!;
    return new JSDOM(
      renderToStaticMarkup(
        createElement(TrajectoryDetails, {
          node: tree.byId.get(row.nodeId)!,
          active: true,
          row,
          events,
          tab: 'overview',
          observationId,
          onTabChange: noop,
          materials: [],
          targets: [],
          excluded: false,
          collapsed: false,
          scrollTop: 0,
          onScroll: noop,
          onClose: noop,
          onParent: noop,
          relatedRows: [],
          rowsById: workbench.byId,
          onRelated: noop,
          runLabel: 'Agent loop 1',
        }),
      ),
    );
  };
  const file = render('execution:read');
  const fileBody = file.window.document.body;
  const labels = Array.from(fileBody.querySelectorAll('dt')).map((item) => item.textContent);
  for (const duplicate of ['操作', '操作摘要', '所属轮次']) expect(labels).not.toContain(duplicate);
  expect(fileBody.textContent!.match(/src\/unique-target\.ts/g)).toHaveLength(1);
  expect(fileBody.textContent!.match(/Agent loop 1/g)).toHaveLength(1);
  expect(fileBody.textContent).toContain('1 毫秒');
  const records = Array.from(fileBody.querySelectorAll('details')).find(
    (item) => item.querySelector('summary')?.textContent === '记录信息',
  )!;
  expect(records.hasAttribute('open')).toBe(false);
  expect(records.textContent).not.toContain('原记录');
  expect(records.textContent).toContain('记录时间');
  expect(records.textContent).not.toContain('从已计划到终态');
  expect(file.window.document.querySelector('[aria-label="执行计时"]')?.textContent).toContain(
    '观察区间',
  );
  expect(fileBody.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe('概述');
  expect(
    Array.from(fileBody.querySelectorAll('[role="tab"]')).map((item) => item.textContent),
  ).not.toContain('原始内容');
  file.window.close();
  const shellDocument = render('execution:launch');
  const shellBody = shellDocument.window.document.body;
  const shellLabels = Array.from(shellBody.querySelectorAll('dt')).map((item) => item.textContent);
  expect(shellLabels).not.toContain('状态');
  expect(shellLabels.filter((label) => label === '命令状态')).toHaveLength(1);
  expect(shellBody.textContent).toContain('已取消');
  expect(shellBody.textContent).toContain('130');
  expect(shellBody.textContent).toContain('已请求；以命令终态确认是否停止');
  shellDocument.window.close();
  const childDocument = render('execution:spawn');
  const childBody = childDocument.window.document.body;
  expect(
    Array.from(childBody.querySelectorAll('dt')).map((item) => item.textContent),
  ).not.toContain('状态');
  for (const state of ['委派受理', '已受理', '工作状态', '已完成', '结果交付', '等待交付'])
    expect(childBody.textContent).toContain(state);
  childDocument.window.close();
  const oldChild = render('execution:spawn', events[4]!.eventId);
  const oldWork = oldChild.window.document.querySelector('[aria-label="子 Agent 工作与返回"]')!;
  expect(oldWork.textContent).toContain('已受理');
  expect(oldWork.textContent).toContain('尚未核实');
  expect(oldWork.textContent).not.toContain('已完成');
  expect(oldWork.textContent).not.toContain('等待交付');
  oldChild.window.close();
  const oldShell = render('execution:launch', events[2]!.eventId);
  const oldCommand = oldShell.window.document.querySelector('[aria-label="命令与观察结果"]')!;
  expect(oldCommand.textContent).not.toContain('已取消');
  expect(oldCommand.textContent).not.toContain('130');
  oldShell.window.close();
  const compression = render('execution:compress');
  const compressionBody = compression.window.document.body;
  expect(compressionBody.querySelector('.trajectory-compression strong')?.textContent).toBe(
    '500 → 100 Token',
  );
  expect(compressionBody.textContent).toContain('减少 400 Token · 80.0%');
  expect(compressionBody.textContent).toContain('压缩已采用');
  const compressionInfo = compressionBody.querySelector('.trajectory-compression details')!;
  expect(compressionInfo.hasAttribute('open')).toBe(false);
  expect(compressionInfo.querySelector('summary')?.textContent).toBe('压缩信息');
  expect(compressionInfo.textContent).toContain('550 Token');
  expect(compressionInfo.textContent).toContain('触发阈值400 Token');
  expect(compressionInfo.textContent).toContain('同一方法');
  const usage = compressionBody.querySelector('[aria-label="模型调用用量"]')!;
  expect(usage.closest('.trajectory-compression')).toBeNull();
  expect(usage.textContent).toContain('输入 450 · 输出 30 · 缓存 0 Token');
  expect(compressionBody.querySelector('.trajectory-compression')?.textContent).not.toContain(
    '输入 450',
  );
  compression.window.close();
  expect(JSON.stringify(events)).toBe(original);
  expect(callbacks).toBe(0);
});
