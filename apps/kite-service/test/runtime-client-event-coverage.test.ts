import { expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { isAcceptedPresentationEnvelope, isRuntimeClientEvent } from '@kite-ai/runtime-contract';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
import { runtimeClientEventCoverageEntries } from '../src/runtime-client/event-coverage';
import { projectRuntimeClientEvent } from '../src/runtime-client/event-projector';

test('classifies every current Kernel event exactly once for Runtime Client projection', () => {
  const entries = runtimeClientEventCoverageEntries();
  const current = [...runtimeHostCurrentStateEventTypes()].sort();
  expect([...entries.keys()].sort().join('\n')).toBe(current.join('\n'));
  for (const decision of entries.values()) {
    expect(['client_visible', 'internal_only', 'client_unavailable', 'normalized_by']).toContain(
      decision,
    );
  }
});

test('keeps interactive and Subagent lifecycle facts client-visible', () => {
  const entries = runtimeClientEventCoverageEntries();
  for (const type of [
    'approval.requested',
    'approval.granted',
    'approval.rejected',
    'auto_review.requested',
    'auto_review.completed',
    'subagent.started',
    'subagent.suspended',
    'subagent.approval_deferred',
    'subagent.step',
    'subagent.tool_result',
    'subagent.completed',
    'subagent.failed',
  ] as const) {
    expect(entries.get(type)).toBe('client_visible');
  }
});

test('projects every client-visible Kernel event into a valid accepted presentation envelope', () => {
  const coverage = runtimeClientEventCoverageEntries();
  const visibleTypes = [...coverage.entries()]
    .filter(([, decision]) => decision === 'client_visible')
    .map(([type]) => type)
    .sort();
  const fixtures = clientVisibleRuntimeEventFixtures();
  expect([...fixtures.keys()].sort()).toEqual(visibleTypes);

  for (const type of visibleTypes) {
    const event = fixtures.get(type);
    if (!event) throw new Error(`Missing client-visible fixture: ${type}`);
    const projected = projectRuntimeClientEvent(event, { sessionRevision: 1 });
    expect(projected, `${type} must have a Runtime Client projection`).toBeDefined();
    if (!projected) continue;
    expect(isRuntimeClientEvent(projected), `${type} projection must be client-safe`).toBe(true);
    expect(
      isAcceptedPresentationEnvelope({
        sessionId: 'coverage-session',
        connectionGeneration: 1,
        durability: 'durable',
        revision: 1,
        runId: 'run-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        event: projected,
      }),
      `${type} projection must be accepted with lifecycle identity`,
    ).toBe(true);
  }
});

test('projects the selected ask-user answer into the safe settlement event', () => {
  expect(
    projectRuntimeClientEvent(
      {
        type: 'user_input.answered',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        answer: '代码结构与工具链',
      },
      { sessionRevision: 2 },
    ),
  ).toEqual({
    type: 'input.answered',
    interactionId: 'interaction-1',
    summary: '代码结构与工具链',
  });
});

const ROOT_OWNER = { kind: 'root_tool', toolCallId: 'tool-1' } as const;
const CHILD_OWNER = {
  kind: 'subagent_tool',
  toolCallId: 'child-tool-1',
  subagentId: 'subagent-1',
  parentToolCallId: 'parent-tool-1',
} as const;
const APPROVAL = {
  scope: 'once' as const,
  cwd: '/workspace',
  threadId: 'coverage-session',
  tool: 'shell_execute',
  command: 'echo ok',
  risk: 'execute_code' as const,
  approvalHash: 'approval-hash',
  summary: 'Run the fixture command.',
  reason: 'Fixture approval.',
  expectedEffects: [],
  grantOptions: ['approve_once'] as const,
  recommendedGrant: 'approve_once' as const,
};
const PLAN = {
  name: 'Fixture plan',
  description: 'A minimal plan fixture.',
  status: 'pending' as const,
  steps: [{ step: 'Inspect', status: 'pending' as const }],
};
const PLAN_ARTIFACT = {
  artifactId: 'artifact-1',
  taskId: 'task-1',
  planId: 'plan-1',
  version: 1,
  fileName: 'plan.md',
  relativePath: 'plan.md',
  displayPath: 'plan.md',
  structuralDigest: 'digest-1',
  byteLength: 1,
};
const PLAN_EVIDENCE = {
  schemaVersion: 1 as const,
  verification: [],
  execution: [],
  skipped: [],
  unresolved: [],
};
const COMMAND_IDENTITY = {
  sessionId: 'coverage-session',
  threadId: 'coverage-session',
  workspace: '/workspace',
  canonicalWorkspaceIdentity: 'workspace-identity',
  cwd: '/workspace',
  executor: 'shell',
  environment: 'test',
  scope: 'once',
  effects: 'none',
  parserRevision: 'parser-1',
  commandDigest: 'command-digest',
};
const PRIVATE_REF = (kind: string, suffix: string) => ({
  kind,
  artifactId: `pa_${suffix.repeat(64).slice(0, 64)}`,
  integrityIdentifier: `sha256:${suffix.repeat(64).slice(0, 64)}`,
  byteLength: 1,
});
const SUBAGENT = {
  id: 'subagent-1',
  role: 'code' as const,
  name: 'Fixture child',
  toolName: 'read_file',
  toolArgs: {},
  stepId: 'step-1',
  toolCallId: 'child-tool-1',
  summary: 'Child completed.',
  error: 'Child failed.',
  toolCallCount: 1,
  durationMs: 1,
};
const SUSPENSION_SNAPSHOT = {
  blockedTool: {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
    toolCallId: 'child-tool-1',
    toolName: 'shell_execute',
  },
  continuationArtifact: PRIVATE_REF('subagent_continuation', 'a'),
  continuationId: `continuation-${'b'.repeat(64)}`,
  modelInvocationOrdinal: 0,
  parentAttempt: 1,
  parentInvocationId: 'parent-invocation-1',
  role: 'code' as const,
  storage: 'private_artifact_v1' as const,
  subagentId: 'subagent-1',
};

function clientVisibleRuntimeEventFixtures(): ReadonlyMap<RuntimeEvent['type'], RuntimeEvent> {
  const event = (value: object): RuntimeEvent => value as RuntimeEvent;
  return new Map([
    [
      'approval.granted',
      event({
        type: 'approval.granted',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        grant: 'approve_once',
        receiptId: 'receipt-1',
        generation: 1,
        owner: ROOT_OWNER,
      }),
    ],
    [
      'approval.batch_released',
      event({
        type: 'approval.batch_released',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        grant: 'same_command',
        grantKey: 'grant-key-1',
        sessionRevision: 1,
        generation: 1,
        commandIdentity: COMMAND_IDENTITY,
        owner: ROOT_OWNER,
        matches: [
          {
            interactionId: 'interaction-1',
            toolCallId: 'tool-1',
            receiptId: 'receipt-1',
            generation: 1,
            owner: ROOT_OWNER,
          },
        ],
        createdAt: '2026-09-05T00:00:00.000Z',
      }),
    ],
    [
      'approval.rejected',
      event({
        type: 'approval.rejected',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        generation: 1,
        reason: 'Rejected in fixture.',
        owner: ROOT_OWNER,
      }),
    ],
    [
      'approval.requested',
      event({
        type: 'approval.requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        approval: APPROVAL,
        fullModeBypassEligible: false,
        fullModePolicyBypassAllowed: false,
        owner: ROOT_OWNER,
        queueGeneration: 1,
        queueSequence: 1,
      }),
    ],
    [
      'auto_review.completed',
      event({
        type: 'auto_review.completed',
        reviewId: 'review-1',
        toolCallId: 'child-tool-1',
        result: {
          ok: true,
          approved: true,
          reviewerModelName: 'fixture-model',
          durationMs: 1,
        },
        owner: CHILD_OWNER,
      }),
    ],
    [
      'auto_review.requested',
      event({
        type: 'auto_review.requested',
        reviewId: 'review-1',
        toolCallId: 'child-tool-1',
        toolName: 'shell_execute',
        reason: 'Review this fixture command.',
        approval: APPROVAL,
        fullModeBypassEligible: false,
        fullModePolicyBypassAllowed: false,
        owner: CHILD_OWNER,
      }),
    ],
    [
      'context.compaction_completed',
      event({
        type: 'context.compaction_completed',
        compactionId: 'compaction-1',
        sourceRevision: 1,
        checkpoint: {},
      }),
    ],
    [
      'context.compaction_failed',
      event({
        type: 'context.compaction_failed',
        compactionId: 'compaction-1',
        sourceRevision: 1,
        errorKind: 'empty_summary',
        message: 'Compaction failed.',
        retryable: true,
      }),
    ],
    [
      'context.compaction_requested',
      event({
        type: 'context.compaction_requested',
        compactionId: 'compaction-1',
        reason: 'manual',
        requestedAtRevision: 1,
        requestedAtTurnId: 'turn-1',
        force: false,
        estimate: { totalInputTokens: 1 },
      }),
    ],
    [
      'context.compaction_reset',
      event({ type: 'context.compaction_reset', checkpointId: 'checkpoint-1', reason: 'manual' }),
    ],
    [
      'interaction_mode.changed',
      event({
        type: 'interaction_mode.changed',
        mode: 'auto',
        source: 'user',
        changedAt: '2026-09-05T00:00:00.000Z',
      }),
    ],
    [
      'model.cache_metrics',
      event({
        type: 'model.cache_metrics',
        inputTokens: 1,
        cacheHitTokens: 1,
        cacheMissTokens: 0,
        hitRate: 1,
      }),
    ],
    [
      'model.reasoning_completed',
      event({
        type: 'model.reasoning_completed',
        requestId: 'request-1',
        segmentId: 'segment-1',
        text: 'Thought.',
      }),
    ],
    [
      'model.reasoning_delta',
      event({
        type: 'model.reasoning_delta',
        requestId: 'request-1',
        segmentId: 'segment-1',
        text: 'Thought.',
      }),
    ],
    ['model.requested', event({ type: 'model.requested', requestId: 'request-1' })],
    [
      'model.responded',
      event({
        type: 'model.responded',
        messageId: 'message-1',
        invocationId: 'request-1',
        text: 'Answer.',
        toolCalls: [],
      }),
    ],
    [
      'model.retry',
      event({
        type: 'model.retry',
        invocationId: 'request-1',
        attempt: 1,
        maxAttempts: 2,
        error: 'Retry.',
        delayMs: 1,
      }),
    ],
    [
      'model.text_delta',
      event({ type: 'model.text_delta', requestId: 'request-1', text: 'Answer.' }),
    ],
    [
      'plan.approved',
      event({
        type: 'plan.approved',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'digest-1',
        executionMode: 'auto',
      }),
    ],
    [
      'plan.completed',
      event({
        type: 'plan.completed',
        toolCallId: 'tool-1',
        taskId: 'task-1',
        plan: PLAN,
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'digest-1',
        completionEvidence: PLAN_EVIDENCE,
      }),
    ],
    [
      'plan.progress_updated',
      event({
        type: 'plan.progress_updated',
        toolCallId: 'tool-1',
        taskId: 'task-1',
        plan: PLAN,
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'digest-1',
        completionEvidence: PLAN_EVIDENCE,
      }),
    ],
    [
      'plan.review_cancelled',
      event({
        type: 'plan.review_cancelled',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'digest-1',
        reason: 'Cancelled.',
      }),
    ],
    [
      'plan.review_requested',
      event({
        type: 'plan.review_requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        taskId: 'task-1',
        plan: PLAN,
        planSummary: 'Review the plan.',
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'digest-1',
        artifact: PLAN_ARTIFACT,
      }),
    ],
    [
      'plan.revision_requested',
      event({
        type: 'plan.revision_requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'digest-1',
        feedback: 'Revise.',
      }),
    ],
    [
      'planning.entered',
      event({ type: 'planning.entered', taskId: 'task-1', source: 'user_command' }),
    ],
    ['planning.exited', event({ type: 'planning.exited', taskId: 'task-1' })],
    [
      'provider.action_completed',
      event({
        type: 'provider.action_completed',
        interactionId: 'interaction-1',
        originatingToolCallId: 'tool-1',
      }),
    ],
    [
      'provider.action_deferred',
      event({
        type: 'provider.action_deferred',
        interactionId: 'interaction-1',
        originatingToolCallId: 'tool-1',
      }),
    ],
    [
      'provider.action_failed',
      event({
        type: 'provider.action_failed',
        interactionId: 'interaction-1',
        originatingToolCallId: 'tool-1',
        failureCode: 'unknown',
      }),
    ],
    [
      'provider.action_required',
      event({
        type: 'provider.action_required',
        interactionId: 'interaction-1',
        providerId: 'provider-1',
        action: 'login',
        originatingToolCallId: 'tool-1',
      }),
    ],
    [
      'provider.admission_cancelled',
      event({
        type: 'provider.admission_cancelled',
        interactionId: 'interaction-1',
        providerId: 'provider-1',
      }),
    ],
    [
      'provider.admission_required',
      event({
        type: 'provider.admission_required',
        interactionId: 'interaction-1',
        providerId: 'provider-1',
        source: 'project',
        providerStatus: 'login_required',
        retryable: true,
      }),
    ],
    [
      'provider.admission_satisfied',
      event({
        type: 'provider.admission_satisfied',
        interactionId: 'interaction-1',
        providerDirectoryRevision: 'directory-1',
      }),
    ],
    [
      'provider.admission_waived',
      event({
        type: 'provider.admission_waived',
        interactionId: 'interaction-1',
        providerId: 'provider-1',
        source: 'project',
        reason: 'user_session_waiver',
        waivedAt: '2026-09-05T00:00:00.000Z',
      }),
    ],
    ['run.completed', event({ type: 'run.completed', turnId: 'run-1', output: 'Answer.' })],
    [
      'run.error',
      event({
        type: 'run.error',
        message: 'Run failed.',
        recoverable: false,
        turnId: 'run-1',
      }),
    ],
    [
      'subagent.approval_deferred',
      event({
        type: 'subagent.approval_deferred',
        toolCallId: 'child-tool-1',
        subagentId: 'subagent-1',
        parentToolCallId: 'parent-tool-1',
        interactionId: 'interaction-1',
        approvalState: 'authorized_queued',
      }),
    ],
    ['subagent.completed', event({ type: 'subagent.completed', subagent: SUBAGENT })],
    ['subagent.failed', event({ type: 'subagent.failed', subagent: SUBAGENT })],
    ['subagent.started', event({ type: 'subagent.started', subagent: SUBAGENT })],
    ['subagent.step', event({ type: 'subagent.step', subagent: SUBAGENT })],
    [
      'subagent.suspended',
      event({
        type: 'subagent.suspended',
        toolCallId: 'parent-tool-1',
        snapshot: SUSPENSION_SNAPSHOT,
      }),
    ],
    [
      'subagent.tool_result',
      event({ type: 'subagent.tool_result', subagent: { ...SUBAGENT, status: 'completed' } }),
    ],
    ['task.cancelled', event({ type: 'task.cancelled', taskId: 'task-1', reason: 'Cancelled.' })],
    ['task.completed', event({ type: 'task.completed', taskId: 'task-1', turnId: 'turn-1' })],
    [
      'tool.cancelled',
      event({ type: 'tool.cancelled', toolCallId: 'tool-1', reason: 'Cancelled.' }),
    ],
    [
      'tool.failed',
      event({
        type: 'tool.failed',
        toolCallId: 'tool-1',
        failure: { kind: 'unknown', message: 'Failed.' },
      }),
    ],
    [
      'tool.file_change',
      event({ type: 'tool.file_change', toolCallId: 'tool-1', path: 'file.txt', kind: 'edit' }),
    ],
    [
      'tool.finished',
      event({
        type: 'tool.finished',
        toolCallId: 'tool-1',
        name: 'shell_execute',
        result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
      }),
    ],
    [
      'tool.progress',
      event({ type: 'tool.progress', toolCallId: 'tool-1', chunk: 'running', stream: 'stdout' }),
    ],
    [
      'tool.queued',
      event({ type: 'tool.queued', toolCallId: 'tool-1', name: 'shell_execute', args: {} }),
    ],
    ['tool.rejected', event({ type: 'tool.rejected', toolCallId: 'tool-1', reason: 'Rejected.' })],
    ['tool.started', event({ type: 'tool.started', toolCallId: 'tool-1' })],
    [
      'turn.aborted',
      event({ type: 'turn.aborted', turnId: 'turn-1', reason: 'Aborted.', cause: 'user' }),
    ],
    ['turn.completed', event({ type: 'turn.completed', turnId: 'turn-1' })],
    [
      'user.message_appended',
      event({ type: 'user.message_appended', messageId: 'message-1', content: 'Hello.' }),
    ],
    [
      'user_input.answered',
      event({
        type: 'user_input.answered',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        answer: 'yes',
      }),
    ],
    [
      'user_input.cancelled',
      event({
        type: 'user_input.cancelled',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        reason: 'Cancelled.',
      }),
    ],
    [
      'user_input.requested',
      event({
        type: 'user_input.requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        request: { question: 'Continue?', options: [], allow_free_text: true },
      }),
    ],
    [
      'verification.completed',
      event({
        type: 'verification.completed',
        verificationId: 'verification-1',
        outcome: 'passed',
        completedAt: '2026-09-05T00:00:00.000Z',
      }),
    ],
    [
      'verification.requested',
      event({
        type: 'verification.requested',
        verificationId: 'verification-1',
        mode: 'required',
        spec: {},
        requestedAt: '2026-09-05T00:00:00.000Z',
      }),
    ],
    [
      'verification.started',
      event({
        type: 'verification.started',
        verificationId: 'verification-1',
        attempt: 1,
        startedAt: '2026-09-05T00:00:00.000Z',
      }),
    ],
    [
      'verification.waived',
      event({
        type: 'verification.waived',
        verificationId: 'verification-1',
        actor: 'user',
        reason: 'Waived.',
        waivedAt: '2026-09-05T00:00:00.000Z',
      }),
    ],
  ]);
}
