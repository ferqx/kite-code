import {
  type TrajectoryEvent,
  type TrajectoryEvidenceDescriptor,
  type TrajectoryEvidenceOpen,
  type TrajectoryEvidenceRef,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { initialTrajectoryViewState, type TrajectoryViewState } from '@kite-ai/ui/desktop';
import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import type { NativeBridge, NativeEvent, NativeRequest, NativeResult } from '../src/native-bridge';
import { NativeTrajectory } from '../src/native-trajectory';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import { outputStateCases, seedOutputState } from './trajectory-output-state.fixture';
import { seedSemanticTrajectory } from './trajectory-semantic.fixture';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

// Explicit isolated artifact only. The ordinary Native product has no fixture entry or flag.
const original = sessionSwitchBridge({ replyParagraphs: 12 });
const listeners = new Set<(event: NativeEvent) => void>();
const requests: NativeRequest[] = [];
const facts: TrajectoryEvent[] = [];
let semantic: ReturnType<typeof seedSemanticTrajectory> | null = null;
let outputState: ReturnType<typeof seedOutputState> | null = null;
let holdMaterials = false;
const heldMaterials: (() => void)[] = [];
const waitForMaterials = () =>
  holdMaterials ? new Promise<void>((resolve) => heldMaterials.push(resolve)) : Promise.resolve();
const messageBodies = new Map<
  string,
  {
    messageId: string;
    role: 'user' | 'assistant';
    messageSeq: string;
    revision: string;
    status: 'complete' | 'incomplete';
    content: string;
  }
>();
const seenMessages = new Set<string>();
let sequence = 0,
  failed = false,
  epoch = 0;
const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
function append(
  sessionId = 'a',
  phase: TrajectoryEvent['phase'] = 'running',
  executionId = 'model',
) {
  const cursor = String(++sequence);
  const ref = {
    evidenceId: `evidence-${cursor}`,
    contentVersion: `head-${cursor}`,
    kind: 'model_output' as const,
    mediaType: 'application/json',
    availability: phase === 'completed' ? ('available' as const) : ('partial' as const),
  };
  facts.push(
    trajectoryEventSchema.parse({
      schema: 'kite.trajectory',
      schemaVersion: 1,
      eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
      sequence: cursor,
      origin: { storeId: 'store', cursor },
      sessionId,
      workspaceId: 'w',
      runId: `run-${sessionId}`,
      executionId,
      sourceEventType: 'execution.state_changed',
      sourceRecordRevision: cursor,
      kind: 'model',
      phase,
      recordedStatus: phase === 'completed' ? 'succeeded' : phase,
      occurredAt: new URL(location.href).searchParams.has('workbench') ? sequence * 1000 : null,
      identityConfidence: 'verified_origin',
      attributes:
        executionId === 'retry-2'
          ? {
              previousExecutionId: 'model',
              previousExecutionOriginStoreId: 'store',
              retryReason: 'stream_incomplete',
              retryAttempt: 2,
              maxAttempts: null,
            }
          : {},
      attempt: executionId === 'retry-2' ? 2 : 1,
      evidenceRefs: [ref],
    }),
  );
  for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
}
function observation(
  kind: TrajectoryEvent['kind'],
  attributes: Record<string, unknown>,
  phase: TrajectoryEvent['phase'],
  executionId?: string,
  recordedStatus: string | null = null,
  context: {
    parentExecutionId?: string;
    evidenceRefs?: TrajectoryEvidenceRef[];
    runId?: string | null;
    sourceEventType?: string;
    identityConfidence?: TrajectoryEvent['identityConfidence'];
  } = {},
) {
  const cursor = String(++sequence);
  facts.push(
    trajectoryEventSchema.parse({
      schema: 'kite.trajectory',
      schemaVersion: 1,
      eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
      sequence: cursor,
      origin: { storeId: 'store', cursor },
      sessionId: 'a',
      workspaceId: 'w',
      ...(context.runId === null ? {} : { runId: context.runId ?? 'run-a' }),
      ...(executionId ? { executionId } : {}),
      ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
      sourceEventType:
        context.sourceEventType ??
        (kind === 'interaction'
          ? `interaction.${String(attributes.decision)}`
          : `${kind}.recorded`),
      sourceRecordRevision: typeof attributes.revision === 'string' ? attributes.revision : cursor,
      kind,
      phase,
      recordedStatus,
      occurredAt: new URL(location.href).searchParams.has('workbench') ? sequence * 1000 : null,
      identityConfidence:
        context.identityConfidence ?? (kind === 'unknown' ? 'legacy_local' : 'verified_origin'),
      attributes,
      evidenceRefs: context.evidenceRefs ?? [],
    }),
  );
  for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
}
function appendMessage(
  messageId: string,
  role: 'user' | 'assistant',
  messageSeq: string,
  status: 'complete' | 'incomplete',
  content: string,
  executionId?: string,
  runId = 'run-a',
) {
  const revision = String(sequence + 1);
  const evidenceId = `message-${messageId}`;
  const contentVersion = `message-revision-${revision}`;
  messageBodies.set(`${evidenceId}:${contentVersion}`, {
    messageId,
    role,
    messageSeq,
    revision,
    status,
    content,
  });
  observation(
    'message',
    { messageId, role, messageSeq, revision, status },
    'observed',
    executionId,
    status,
    {
      runId,
      sourceEventType: seenMessages.has(messageId) ? 'message.updated' : 'message.created',
      evidenceRefs: [
        {
          evidenceId,
          contentVersion,
          kind: 'message',
          mediaType: 'application/json',
          availability: status === 'complete' ? 'available' : 'partial',
        },
      ],
    },
  );
  seenMessages.add(messageId);
}
function seedMessages() {
  observation('run', {}, 'running', undefined, 'running');
  appendMessage('messages-user', 'user', '1', 'complete', '请检查轨迹页的消息记录是否完整。');
  observation('model', { definitionId: 'fixture.respond' }, 'running', 'messages-model', 'running');
  appendMessage(
    'messages-reply',
    'assistant',
    '2',
    'incomplete',
    '我先检查已保存的记录。',
    'messages-model',
  );
  observation(
    'tool',
    { definitionId: 'read_file', callId: 'messages-read' },
    'planned',
    'messages-tool',
    'planned',
    { parentExecutionId: 'messages-model' },
  );
  observation(
    'interaction',
    {
      interactionId: 'messages-approval',
      interactionKind: 'approval',
      revision: '1',
      decision: 'requested',
    },
    'waiting_interaction',
    'messages-tool',
    'requested',
  );
  appendMessage(
    'messages-reply',
    'assistant',
    '2',
    'incomplete',
    '我先检查已保存的记录。\n正在核对用户消息与 Agent 回复的关联。',
    'messages-model',
  );
  observation(
    'interaction',
    {
      interactionId: 'messages-approval',
      interactionKind: 'approval',
      revision: '2',
      decision: 'accepted',
    },
    'observed',
    'messages-tool',
    'accepted',
  );
  observation(
    'tool',
    { definitionId: 'read_file', callId: 'messages-read', resultRevision: '1' },
    'completed',
    'messages-tool',
    'succeeded',
    {
      parentExecutionId: 'messages-model',
      sourceEventType: 'message.created',
      evidenceRefs: [
        {
          evidenceId: 'messages-tool-result',
          contentVersion: 'messages-tool-v1',
          kind: 'tool_result',
          mediaType: 'application/json',
          availability: 'available',
        },
      ],
    },
  );
  appendMessage(
    'messages-reply',
    'assistant',
    '2',
    'complete',
    '我先检查已保存的记录。\n已核对用户消息与 Agent 回复的关联，工具结果仍作为工具结果保留。',
    'messages-model',
  );
  observation(
    'model',
    { definitionId: 'fixture.respond' },
    'completed',
    'messages-model',
    'succeeded',
  );
  observation('run', {}, 'completed', undefined, 'succeeded');
  observation('run', {}, 'running', undefined, 'running', { runId: 'messages-next-run' });
  appendMessage(
    'messages-next-user',
    'user',
    '3',
    'complete',
    '继续检查第二轮的流式回复。',
    undefined,
    'messages-next-run',
  );
  observation(
    'model',
    { definitionId: 'fixture.respond' },
    'running',
    'messages-next-model',
    'running',
    { runId: 'messages-next-run' },
  );
  observation('unknown', { reason: 'legacy_fields_missing' }, 'observed', undefined, null, {
    runId: null,
    sourceEventType: 'message.updated',
    identityConfidence: 'legacy_local',
  });
}
function seedStructure() {
  const ref = (evidenceId: string, kind: TrajectoryEvidenceRef['kind']): TrajectoryEvidenceRef => ({
    evidenceId,
    contentVersion: `${evidenceId}-v1`,
    kind,
    mediaType: 'application/json',
    availability: 'available',
  });
  observation('run', {}, 'running', undefined, 'running');
  observation(
    'context',
    { selectionId: 'context-a', action: 'selected', revision: '1' },
    'observed',
  );
  observation(
    'model',
    { definitionId: 'fixture.respond' },
    'planned',
    'structure-model',
    'planned',
    {
      evidenceRefs: [ref('structure-input', 'model_input')],
    },
  );
  observation(
    'model',
    { definitionId: 'fixture.respond' },
    'completed',
    'structure-model',
    'succeeded',
    {
      evidenceRefs: [ref('structure-model-output', 'model_output')],
    },
  );
  observation(
    'tool',
    { definitionId: 'read_file', callId: 'read-file-a' },
    'planned',
    'structure-tool',
    'planned',
    {
      parentExecutionId: 'structure-model',
      evidenceRefs: [ref('structure-tool-input', 'tool_input')],
    },
  );
  observation(
    'interaction',
    {
      interactionId: 'structure-approval',
      interactionKind: 'approval',
      revision: '1',
      decision: 'requested',
    },
    'waiting_interaction',
    'structure-tool',
    'requested',
  );
  observation(
    'interaction',
    {
      interactionId: 'structure-approval',
      interactionKind: 'approval',
      revision: '2',
      decision: 'accepted',
    },
    'observed',
    'structure-tool',
    'accepted',
  );
  observation(
    'tool',
    { definitionId: 'read_file', callId: 'read-file-a', resultRevision: '1' },
    'completed',
    'structure-tool',
    'succeeded',
    {
      parentExecutionId: 'structure-model',
      evidenceRefs: [ref('structure-tool-result', 'tool_result')],
    },
  );
  observation(
    'job',
    { definitionId: 'check_tests', childSessionId: 'structure-child' },
    'running',
    'structure-carrier',
    'running',
    {
      parentExecutionId: 'structure-model',
    },
  );
  observation(
    'child',
    {
      childSessionId: 'structure-child',
      carrierExecutionId: 'structure-carrier',
      delivery: 'pending',
    },
    'observed',
  );
  observation('unknown', { reason: 'legacy_fields_missing' }, 'observed');
  observation(
    'verification',
    { verificationId: 'structure-check', outcome: 'passed', method: 'test_evidence' },
    'completed',
  );
}
function seedWorkbench() {
  seedStructure();
  appendMessage('workbench-user', 'user', '1', 'complete', '请读取文件，核对工具结果并总结。');
  appendMessage(
    'workbench-reply',
    'assistant',
    '2',
    'complete',
    '文件已读取，测试结果通过。',
    'structure-model',
  );
  const ref = {
    evidenceId: 'compression-summary',
    contentVersion: 'summary-v1',
    kind: 'model_output' as const,
    mediaType: 'application/json',
    availability: 'available' as const,
  };
  const attrs = {
    definitionId: 'compress',
    compressionId: 'workbench-compress',
    compressionTrigger: 'automatic' as const,
    compression: {
      adopted: false,
      triggerTokens: 12200,
      triggerBasis: 'local_estimate' as const,
      thresholdTokens: 12000,
    },
  };
  observation('model', attrs, 'running', 'workbench-compress', 'running', {
    parentExecutionId: 'structure-model',
  });
  observation('model', attrs, 'completed', 'workbench-compress', 'succeeded', {
    parentExecutionId: 'structure-model',
    evidenceRefs: [ref],
  });
  observation(
    'context',
    {
      compressionId: attrs.compressionId,
      compressionTrigger: attrs.compressionTrigger,
      action: 'compressed',
      compression: {
        ...attrs.compression,
        adopted: true,
        accounting: { basis: 'local-context-estimate-v1', beforeTokens: 12200, afterTokens: 2600 },
      },
    },
    'observed',
    'workbench-compress',
    null,
    { sourceEventType: 'context.compressed', evidenceRefs: [ref] },
  );
}
function seedLegacy() {
  const sources = [
    'execution.planned',
    'run.started',
    'execution.state_changed',
    'interaction.requested',
    'message.updated',
    'run.completed',
  ];
  for (let index = 0; index < 42; index++)
    observation('unknown', { reason: 'legacy_fields_missing' }, 'observed', undefined, null, {
      runId: null,
      sourceEventType: sources[index % sources.length],
      identityConfidence: 'legacy_local',
    });
  observation('unknown', { reason: 'unrecognized_source_type' }, 'observed', undefined, null, {
    runId: null,
    sourceEventType: 'future.operation',
    identityConfidence: 'verified_origin',
  });
}
function seedFilter() {
  const ref = (evidenceId: string, kind: TrajectoryEvidenceRef['kind']): TrajectoryEvidenceRef => ({
    evidenceId,
    contentVersion: `${evidenceId}-v1`,
    kind,
    mediaType: 'application/json',
    availability: 'available',
  });
  observation('run', {}, 'running', undefined, 'running');
  observation(
    'command',
    { commandId: 'filter-title', commandType: 'session.title' },
    'observed',
    undefined,
    null,
    { runId: null },
  );
  observation(
    'job',
    { definitionId: 'builtin.session-title/generate' },
    'running',
    'filter-title-job',
    'running',
    { runId: null },
  );
  observation(
    'model',
    { definitionId: 'title.respond' },
    'completed',
    'filter-title-model',
    'succeeded',
    {
      runId: null,
      parentExecutionId: 'filter-title-job',
      evidenceRefs: [ref('filter-title-output', 'model_output')],
    },
  );
  observation(
    'job',
    { definitionId: 'builtin.session-title/generate' },
    'completed',
    'filter-title-job',
    'succeeded',
    { runId: null },
  );
  observation(
    'context',
    { selectionId: 'filter-selection', action: 'selected', revision: '1' },
    'observed',
    undefined,
    null,
    { evidenceRefs: [ref('filter-context', 'context')] },
  );
  observation('model', { definitionId: 'fixture.respond' }, 'planned', 'filter-main', 'planned', {
    evidenceRefs: [ref('filter-input', 'model_input')],
  });
  observation(
    'model',
    { definitionId: 'fixture.respond' },
    'completed',
    'filter-main',
    'succeeded',
    { evidenceRefs: [ref('filter-output', 'model_output')] },
  );
  observation(
    'tool',
    { definitionId: 'read_file', callId: 'filter-read' },
    'planned',
    'filter-tool',
    'planned',
    { parentExecutionId: 'filter-main' },
  );
  observation(
    'interaction',
    {
      interactionId: 'filter-approval',
      interactionKind: 'approval',
      revision: '1',
      decision: 'requested',
    },
    'waiting_interaction',
    'filter-tool',
    'requested',
  );
  observation(
    'interaction',
    {
      interactionId: 'filter-approval',
      interactionKind: 'approval',
      revision: '2',
      decision: 'accepted',
    },
    'observed',
    'filter-tool',
    'accepted',
  );
  observation(
    'tool',
    { definitionId: 'read_file', callId: 'filter-read', resultRevision: '1' },
    'completed',
    'filter-tool',
    'succeeded',
    { parentExecutionId: 'filter-main', evidenceRefs: [ref('filter-tool-output', 'tool_result')] },
  );
  observation(
    'interaction',
    {
      interactionId: 'filter-question',
      interactionKind: 'question',
      revision: '1',
      decision: 'requested',
    },
    'waiting_interaction',
    'filter-tool',
    'requested',
    { evidenceRefs: [ref('filter-question', 'interaction')] },
  );
  observation(
    'interaction',
    { interactionId: 'filter-legacy-interaction', revision: '1', decision: 'requested' },
    'waiting_interaction',
    'filter-tool',
    'requested',
  );
  observation(
    'interaction',
    {
      interactionId: 'filter-plan',
      interactionKind: 'plan_review',
      revision: '1',
      decision: 'accepted',
    },
    'observed',
    'filter-tool',
    'accepted',
  );
  observation(
    'model',
    { definitionId: 'compress', compressionId: 'filter-auto', compressionTrigger: 'automatic' },
    'running',
    'filter-auto',
    'running',
    { parentExecutionId: 'filter-main' },
  );
  observation(
    'model',
    { definitionId: 'compress', compressionId: 'filter-auto', compressionTrigger: 'automatic' },
    'completed',
    'filter-auto',
    'succeeded',
    {
      parentExecutionId: 'filter-main',
      evidenceRefs: [ref('filter-compression-output', 'model_output')],
    },
  );
  observation(
    'context',
    { compressionId: 'filter-auto', compressionTrigger: 'automatic', action: 'compressed' },
    'observed',
    'filter-auto',
    null,
    {
      sourceEventType: 'context.compressed',
      evidenceRefs: [ref('filter-compression-result', 'context')],
    },
  );
  observation(
    'context',
    { compressionId: 'filter-manual', compressionTrigger: 'manual', action: 'compressed' },
    'observed',
    undefined,
    null,
    { sourceEventType: 'context.compressed' },
  );
  observation(
    'context',
    { compressionId: 'filter-missing-trigger', action: 'compressed' },
    'observed',
    undefined,
    null,
    { sourceEventType: 'context.compressed' },
  );
  observation(
    'job',
    { definitionId: 'check_tests', childSessionId: 'filter-child' },
    'running',
    'filter-carrier',
    'running',
    { parentExecutionId: 'filter-main' },
  );
  observation(
    'child',
    { childSessionId: 'filter-child', carrierExecutionId: 'filter-carrier', delivery: 'pending' },
    'observed',
  );
  observation('artifact', { artifactId: 'filter-artifact', mediaType: 'text/plain' }, 'observed');
  observation('recovery', { outcome: 'unknown', reasonCode: 'interrupted' }, 'observed');
  observation(
    'verification',
    { verificationId: 'filter-verification', outcome: 'passed', method: 'test_evidence' },
    'completed',
  );
  observation('unknown', { reason: 'unrecognized_source_type' }, 'observed', undefined, null, {
    sourceEventType: 'future.operation',
    identityConfidence: 'verified_origin',
  });
  observation('unknown', { reason: 'legacy_fields_missing' }, 'observed', undefined, null, {
    sourceEventType: 'execution.planned',
    identityConfidence: 'legacy_local',
    runId: null,
  });
}
if (!new URL(location.href).searchParams.has('empty')) {
  if (new URL(location.href).searchParams.get('outputState') === '1') {
    const requested = new URL(location.href).searchParams.get('outputCase');
    const caseName = outputStateCases.find((value) => value === requested) ?? 'empty-virtual';
    outputState = seedOutputState(facts, caseName);
    semantic = outputState;
    sequence = Number(facts.at(-1)!.sequence);
  } else if (new URL(location.href).searchParams.get('semantic') === '1') {
    semantic = seedSemanticTrajectory(facts, {
      legacyLoop: new URL(location.href).searchParams.get('legacyLoop') === '1',
      twoLoops: new URL(location.href).searchParams.get('twoLoops') === '1',
      twoRuns: new URL(location.href).searchParams.get('twoRuns') === '1',
      noRun: new URL(location.href).searchParams.get('noRun') === '1',
      toolCatalog: new URL(location.href).searchParams.get('toolCatalog') === '1',
      redundancy: new URL(location.href).searchParams.get('redundancy') === '1',
      changedTools: new URL(location.href).searchParams.get('changedTools') === '1',
      inputContext: new URL(location.href).searchParams.get('inputContext') === '1',
      nodeDetails: new URL(location.href).searchParams.get('nodeDetails') === '1',
      pasteExactHost: new URL(location.href).searchParams.get('pasteExactHost') === '1',
    });
    sequence = Number(facts.at(-1)!.sequence);
  } else if (new URL(location.href).searchParams.has('workbench')) seedWorkbench();
  else if (new URL(location.href).searchParams.get('messages') === '1') seedMessages();
  else if (new URL(location.href).searchParams.get('filter') === '1') seedFilter();
  else {
    seedStructure();
    if (new URL(location.href).searchParams.has('legacy')) seedLegacy();
    else {
      // Keep the original default 425-record long-history case beside the explicit tree relationships.
      for (let index = 0; index < 425; index++)
        append('a', index % 3 === 2 ? 'completed' : 'running', `model-${Math.floor(index / 3)}`);
    }
  }
  append('b', 'completed', 'model-b');
}
const leases = new Map<
  string,
  { descriptor: TrajectoryEvidenceDescriptor; bytes: Uint8Array; offset: number }
>();
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
const bridge: NativeBridge = {
  watch(listener) {
    listeners.add(listener);
    const remove = original.bridge.watch(listener);
    return () => {
      listeners.delete(listener);
      remove();
    };
  },
  async request(input): Promise<NativeResult> {
    requests.push(structuredClone(input));
    if (input.method.startsWith('trajectory.')) {
      if (input.method === 'trajectory.cancel') {
        leases.clear();
        return null;
      }
      if (input.method === 'trajectory.evidence.close') {
        leases.delete(input.request.readId);
        return null;
      }
      if (failed) throw Error('trajectory_connection_unavailable');
      if (input.method === 'trajectory.open')
        return {
          kind: 'trajectory.snapshot',
          trajectory: {
            ...input.request,
            upperCursor: String(sequence),
            formatVersion: 1,
            historyCoverage: {
              enabledAfterCursor: '0',
              upperCursor: String(sequence),
              status: 'retained',
              integrity,
            },
          },
        };
      if (input.method === 'trajectory.events') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const { limit: _limit, ...scope } = input.request;
        const selected = facts.filter(
          (fact) =>
            fact.sessionId === input.request.sessionId &&
            (input.request.runId === undefined || fact.runId === input.request.runId) &&
            (input.request.executionId === undefined ||
              fact.executionId === input.request.executionId) &&
            BigInt(fact.sequence) > BigInt(input.request.afterCursor) &&
            BigInt(fact.sequence) <= BigInt(input.request.upperCursor),
        );
        const page = selected.slice(0, input.request.limit ?? 200);
        const exhausted = page.length === selected.length;
        return {
          kind: 'trajectory.page',
          trajectory: {
            ...scope,
            events: page,
            scannedThrough: exhausted ? scope.upperCursor : page.at(-1)!.sequence,
            exhausted,
            integrity,
          },
        };
      }
      if (input.method === 'trajectory.evidence.open') {
        const request: TrajectoryEvidenceOpen = input.request;
        const event = facts.find(
          (fact) => fact.eventId === request.eventId && fact.sessionId === request.sessionId,
        )!;
        const reference = event?.evidenceRefs.find(
          (ref) =>
            ref.evidenceId === request.evidenceId && ref.contentVersion === request.contentVersion,
        );
        if (!reference || BigInt(event.sequence) > BigInt(request.atCursor))
          throw Error('trajectory_scope_denied');
        const content = `原位置 ${event.sequence} 的已保存正文。${'Unicode 前缀 👋\n'.repeat(9000)}`;
        const semanticBody = semantic?.bodies.get(semantic.bodyKey(event.eventId, reference));
        const body =
          semanticBody !== undefined
            ? semanticBody
            : reference.evidenceId === 'compression-summary'
              ? {
                  content:
                    '## 已采用的压缩摘要\n\n- 已读取 README.md。\n- 测试 12 项通过。\n- 保留后续用户消息和最近工具结果。',
                  complete: true,
                }
              : reference.kind === 'tool_input'
                ? { path: 'README.md', offset: 0, limit: 200 }
                : reference.kind === 'message'
                  ? messageBodies.get(`${reference.evidenceId}:${reference.contentVersion}`)
                  : reference.kind === 'model_input'
                    ? {
                        request: {
                          modelId: 'model-opaque-fixture-binding',
                          requestId: event.executionId,
                          messages: [{ role: 'user', content }],
                          tools: [],
                        },
                        metadata: {
                          adapter: {
                            availability: 'available',
                            provider: {
                              availability: 'available',
                              family: 'fixture',
                              modelId: 'fixture-provider-model',
                            },
                          },
                        },
                      }
                    : reference.kind === 'model_output'
                      ? {
                          content,
                          reasoning: '',
                          toolCalls: [],
                          complete: event.phase === 'completed',
                        }
                      : reference.kind === 'interaction'
                        ? { request: { text: '需要继续检查吗？' }, answer: { text: content } }
                        : reference.kind === 'tool_result'
                          ? {
                              content: '# Kite\n\n测试结果：12 项通过。',
                              outcome: 'succeeded',
                              presentation: {
                                kind: 'file',
                                operation: 'read',
                                path: 'README.md',
                                text: '# Kite\n\n测试结果：12 项通过。',
                                bytes: 48,
                                startLine: 1,
                                endLine: 3,
                              },
                            }
                          : { content, contentVersion: reference.contentVersion };
        if (!body) throw Error('fixture_message_body_missing');
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        const descriptor: TrajectoryEvidenceDescriptor = {
          readId: crypto.randomUUID(),
          eventId: event.eventId,
          evidenceId: reference.evidenceId,
          contentVersion: reference.contentVersion,
          availability: reference.availability,
          mediaType: 'application/json',
          viewBytes: String(bytes.byteLength),
          viewSha256: await hash(bytes),
          transformation: 'fixture.public@1',
          policyRevision: '1',
          authorizationEpoch: '1',
        };
        leases.set(descriptor.readId, { descriptor, bytes, offset: 0 });
        await waitForMaterials();
        return { kind: 'trajectory.evidence.opened', trajectory: descriptor };
      }
      if (input.method === 'trajectory.evidence.read') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await waitForMaterials();
        const lease = leases.get(input.request.readId);
        if (!lease || String(lease.offset) !== input.request.offset)
          throw Error('trajectory_evidence_read_missing');
        const end = Math.min(lease.bytes.byteLength, lease.offset + (input.request.limit ?? 65536));
        let binary = '';
        for (const byte of lease.bytes.subarray(lease.offset, end))
          binary += String.fromCharCode(byte);
        const chunk = {
          readId: input.request.readId,
          offset: String(lease.offset),
          nextOffset: String(end),
          data: btoa(binary),
          eof: end === lease.bytes.byteLength,
          viewSha256: lease.descriptor.viewSha256,
          policyRevision: '1',
          authorizationEpoch: '1',
        };
        lease.offset = end;
        return { kind: 'trajectory.evidence.chunk', trajectory: chunk };
      }
    }
    const value = await original.bridge.request(input);
    if (value && 'generation' in value && 'selection' in value && value.selection)
      return { ...value, selection: { ...value.selection, canReadTrajectory: true } };
    return value;
  },
};
Object.defineProperty(window, 'kiteNative', { value: bridge });
const host = document.createElement('div');
host.style.height = 'calc(100vh - 78px)';
const isolatedStyle = document.createElement('style');
isolatedStyle.textContent = '.kite-client.shell{height:100%;min-height:0}';
document.head.append(isolatedStyle);
document.body.append(host);
let root = createRoot(host);
const restoredRawKind = new URL(location.href).searchParams.get('legacyRaw');
const restoredRawNodes: Record<string, string> = {
  tool: 'execution:semantic-read',
  system: 'execution:semantic-model:part:system',
  thinking: 'execution:semantic-model:part:thinking',
  message: 'message:semantic-user',
};
const restoredRawKey = JSON.stringify(['store', 'a']);
const restoredRawReadings = new Map<string, TrajectoryViewState>();
const restoredRawReading =
  restoredRawKind && restoredRawNodes[restoredRawKind]
    ? {
        ...initialTrajectoryViewState(),
        mode: 'history' as const,
        selectedNodeId: restoredRawNodes[restoredRawKind],
        detailOpen: true,
        workbenchTab: 'raw' as const,
        selectedObservationId:
          restoredRawKind === 'system' || restoredRawKind === 'thinking'
            ? facts.find(
                (event) => event.executionId === 'semantic-retry-1' && event.phase === 'failed',
              )?.eventId
            : null,
      }
    : null;
if (restoredRawReading) restoredRawReadings.set(restoredRawKey, restoredRawReading);
function render() {
  root.render(
    restoredRawReading ? (
      <div
        className="kite-client"
        style={{ height: '100%', width: 'min(100%, 960px)', marginLeft: 'auto' }}
      >
        <NativeTrajectory
          key={epoch}
          bridge={bridge}
          generation={1}
          storeId="store"
          sessionId="a"
          stateCache={restoredRawReadings}
        />
      </div>
    ) : (
      <NativeDesktop key={epoch} />
    ),
  );
}
const toolbar = document.createElement('div');
toolbar.style.cssText =
  'height:78px;overflow:auto;display:flex;gap:8px;align-items:center;align-content:flex-start;flex-wrap:wrap;padding:4px;box-sizing:border-box';
document.body.prepend(toolbar);
function button(label: string, action: () => void) {
  const button = document.createElement('button');
  button.textContent = label;
  button.onclick = action;
  toolbar.append(button);
}
button('Fixture: 流式追加', () => append('a'));
button('Fixture: 失败', () => append('a', 'failed'));
button('Fixture: 重试', () => append('a', 'running', 'retry-2'));
button('Fixture: 完成', () => append('a', 'completed', 'retry-2'));
if (semantic) {
  button('Fixture: 后台测试完成', () => {
    semantic!.completeShell();
    sequence = Number(facts.at(-1)!.sequence);
    for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
  });
  button('Fixture: 挂起材料', () => {
    holdMaterials = true;
  });
  button('Fixture: 释放材料', () => {
    holdMaterials = false;
    for (const release of heldMaterials.splice(0)) release();
  });
}
button('Fixture: 审批等待', () => {
  observation('tool', {}, 'planned', 'approved-tool', 'planned');
  observation(
    'interaction',
    {
      interactionId: 'approval',
      interactionKind: 'approval',
      revision: '1',
      decision: 'requested',
    },
    'waiting_interaction',
    'approved-tool',
    'requested',
  );
});
button('Fixture: 回答审批', () =>
  observation(
    'interaction',
    { interactionId: 'approval', interactionKind: 'approval', revision: '2', decision: 'answered' },
    'observed',
    'approved-tool',
    'answered',
  ),
);
button('Fixture: 派发工具', () =>
  observation('tool', {}, 'dispatching', 'approved-tool', 'dispatching'),
);
button('Fixture: 未知记录', () =>
  observation('unknown', { reason: 'legacy_fields_missing' }, 'observed'),
);
button('Fixture: 并行子任务', () => {
  observation('job', { childSessionId: 'child-a' }, 'running', 'carrier-a', 'running');
  observation('job', { childSessionId: 'child-b' }, 'running', 'carrier-b', 'running');
});
button('Fixture: 结构场景', seedStructure);
if (new URL(location.href).searchParams.get('filter') === '1') {
  button('Fixture: 自动压缩等待', () =>
    observation(
      'model',
      {
        definitionId: 'compress',
        compressionId: 'filter-auto-live',
        compressionTrigger: 'automatic',
      },
      'running',
      'filter-auto-live',
      'running',
      { parentExecutionId: 'filter-main' },
    ),
  );
  button('Fixture: 自动压缩完成', () => {
    observation(
      'model',
      {
        definitionId: 'compress',
        compressionId: 'filter-auto-live',
        compressionTrigger: 'automatic',
      },
      'completed',
      'filter-auto-live',
      'succeeded',
      { parentExecutionId: 'filter-main' },
    );
    observation(
      'context',
      { compressionId: 'filter-auto-live', compressionTrigger: 'automatic', action: 'compressed' },
      'observed',
      'filter-auto-live',
      null,
      { sourceEventType: 'context.compressed' },
    );
  });
  button('Fixture: 问答追加', () =>
    observation(
      'interaction',
      {
        interactionId: 'filter-question-live',
        interactionKind: 'question',
        revision: '1',
        decision: 'requested',
      },
      'waiting_interaction',
      'filter-tool',
      'requested',
    ),
  );
}
if (new URL(location.href).searchParams.get('messages') === '1') {
  const reply = (status: 'complete' | 'incomplete', content: string) =>
    appendMessage(
      'messages-next-reply',
      'assistant',
      '4',
      status,
      content,
      'messages-next-model',
      'messages-next-run',
    );
  button('Fixture: 消息开始', () => reply('incomplete', '正在核对第二轮。'));
  button('Fixture: 消息追加', () =>
    reply('incomplete', '正在核对第二轮。\n新增内容已保存为独立版本。'),
  );
  button('Fixture: 消息完成', () =>
    reply('complete', '正在核对第二轮。\n新增内容已保存为独立版本，当前回复完整结束。'),
  );
}
button('Fixture: 恢复观察', () => {
  observation('model', {}, 'outcome_unknown', 'interrupted-model', 'outcome_unknown');
  observation('recovery', { outcome: 'unknown', reasonCode: 'session_reconciled' }, 'observed');
});
button('Fixture: 恢复后新尝试', () =>
  observation(
    'model',
    { previousExecutionId: 'interrupted-model', previousExecutionOriginStoreId: 'store' },
    'planned',
    'restarted-model',
    'planned',
  ),
);
const disconnect = () => {
  failed = true;
  for (const listener of listeners) listener({ kind: 'lifecycle', phase: 'quitting' });
};
const reconnect = () => {
  failed = false;
  for (const listener of listeners) listener({ kind: 'lifecycle', phase: 'active' });
};
button('Fixture: 断开', disconnect);
button('Fixture: 重连', reconnect);
button('Fixture: 冷重开', () => {
  root.unmount();
  root = createRoot(host);
  epoch++;
  render();
});
Object.assign(window, {
  trajectoryFixture: {
    requests,
    append,
    leases,
    facts,
    bridge,
    semantic,
    outputState,
    advanceOutputState: () => {
      outputState?.advance();
      sequence = Number(facts.at(-1)!.sequence);
      for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
    },
    restoredRawReading,
    restoredRawReadings,
    disconnect,
    reconnect,
    holdMaterials: () => {
      holdMaterials = true;
    },
    releaseMaterials: () => {
      holdMaterials = false;
      for (const release of heldMaterials.splice(0)) release();
    },
    heldMaterials: () => heldMaterials.length,
  },
});
render();
