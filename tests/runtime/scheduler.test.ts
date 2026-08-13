import { describe, expect, test } from 'bun:test';
import { eventsForRuntimeAction } from '../../src/core/runtime/actions';
import { classifyFailure } from '../../src/core/runtime/failures';
import { guardLegacyPlanContinuationEffect } from '../../src/core/runtime/plan-continuation';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { decideNextEffect, MAX_PARALLEL_READ_TOOLS } from '../../src/core/runtime/scheduler';
import {
  createInitialRuntimeState,
  type RuntimeState,
  type ToolCallRecord,
} from '../../src/core/runtime/state';
import { normalizeCurrentToolOutcomeEventV1 } from '../../src/core/runtime/tool-outcome-events';
import { shellExecuteSpec } from '../../src/core/tools/registry/builtins/shell-execute';

function queueCall(
  state: RuntimeState,
  id: string,
  input: Pick<ToolCallRecord, 'name' | 'args' | 'effectClass' | 'sideEffect'>,
): void {
  state.tools.queue.push(id);
  state.tools.calls[id] = {
    toolCallId: id,
    modelMessageId: 'model',
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
    ...input,
  };
}

function legacyExecutingPlanState(): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'legacy-executing',
    userId: 'u',
    workspace: '/workspace',
  });
  state.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: state.turn.turnId,
  };
  return state;
}

describe('decideNextEffect', () => {
  test('returns an invalid task call to the normal model loop without forcing a task retry', () => {
    let state = createInitialRuntimeState({
      threadId: 'task-error-normal-loop',
      userId: 'u',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'task-error-response',
      toolCalls: [{ id: 'bad-task', name: 'task', args: { subagent_type: 'explore' } }],
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'bad-task',
      name: 'task',
      args: { subagent_type: 'explore' },
      modelMessageId: 'task-error-response',
    });
    state = reduceRuntimeState(
      state,
      normalizeCurrentToolOutcomeEventV1(
        {
          type: 'tool.failed',
          toolCallId: 'bad-task',
          failure: classifyFailure(
            'model_invalid_tool_args',
            'task is missing its required task argument',
          ),
        },
        state,
        '2026-08-12T00:00:00.000Z',
      ),
    );

    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
    const toolResult = state.transcript.messages.at(-1);
    expect(toolResult).toMatchObject({ kind: 'tool', name: 'task', ok: false });
    expect(JSON.stringify(toolResult)).toContain('model_invalid_tool_args');
  });

  test('classifies a normal no-progress ceiling as loop exhaustion, not persistence failure', () => {
    const state = createInitialRuntimeState({ threadId: 'quality', userId: 'u', workspace: '/' });
    state.toolRecovery.qualityGuard = {
      blocked: true,
      reasonCode: 'no_progress',
      observedFailures: 6,
      turnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'recovery_blocked',
      reason: expect.stringContaining('no progress'),
      failureKind: 'loop_exhausted',
      recoveryCause: 'no_progress',
    });
  });

  test('classifies an invalid recovery journal as persistence unavailable', () => {
    const state = createInitialRuntimeState({ threadId: 'invalid', userId: 'u', workspace: '/' });
    state.toolRecovery.qualityGuard = {
      blocked: true,
      reasonCode: 'journal_invalid',
      observedFailures: 0,
      turnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'recovery_blocked',
      reason: expect.stringContaining('invalid'),
      failureKind: 'persistence_unavailable',
      recoveryCause: 'journal_invalid',
    });
  });

  test('routes a queued legacy effect through governance before Provider recovery', () => {
    const state = legacyExecutingPlanState();
    queueCall(state, 'legacy-shell', {
      name: 'shell_execute',
      args: { command: 'pwd' },
      effectClass: 'read_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['legacy-shell'],
    });
  });

  test('uses a restricted recovery model when a legacy V1 plan has no queued replan', () => {
    const state = legacyExecutingPlanState();
    const canonical = decideNextEffect(state);
    expect(canonical).toEqual({
      type: 'call_model',
      toolSurface: 'legacy_plan_recovery',
    });
    const prepared = {
      ...canonical,
      resourceEstimate: { inputTokens: 1_000, maxOutputTokens: 200 },
    };
    expect(guardLegacyPlanContinuationEffect(state, prepared, canonical)).toEqual(prepared);
  });

  test('allows a queued V2 replan save while a legacy V1 plan is executing', () => {
    const state = legacyExecutingPlanState();
    queueCall(state, 'legacy-replan', {
      name: 'write_plan',
      args: { action: 'save' },
      effectClass: 'plan_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['legacy-replan'],
    });
  });

  test('continues restricted recovery after a successful read_plan result', () => {
    const state = legacyExecutingPlanState();
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: 'legacy-read-response',
      turnId: state.turn.turnId,
      ordinal: 0,
      createdAt: '2026-08-10T00:00:00.000Z',
      toolSurface: 'legacy_plan_recovery',
      toolCalls: [{ id: 'legacy-read', name: 'read_plan', args: {} }],
    });
    state.tools.calls['legacy-read'] = {
      toolCallId: 'legacy-read',
      modelMessageId: 'legacy-read-response',
      name: 'read_plan',
      args: {},
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'call_model',
      toolSurface: 'legacy_plan_recovery',
    });
  });

  test('admits a pending context compaction needed by restricted recovery', () => {
    const state = legacyExecutingPlanState();
    state.context.pendingCompaction = {
      compactionId: 'legacy-recovery-compaction',
      reason: 'auto',
      requestedAtRevision: state.revision,
      requestedAtTurnId: state.turn.turnId,
      force: false,
      estimate: {
        systemTokens: 100,
        toolSchemaTokens: 100,
        transcriptTokens: 1_000,
        summaryTokens: 0,
        dynamicRuntimeTokens: 100,
        framingTokens: 10,
        totalInputTokens: 1_310,
      },
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'compact_context',
      compactionId: 'legacy-recovery-compaction',
    });
  });

  test('keeps an unknown external invocation ahead of legacy plan recovery', () => {
    const state = legacyExecutingPlanState();
    state.capabilities.invocations.unknown = {
      invocationId: 'unknown',
      toolCallId: 'mcp-call',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'revision',
      argumentsDigest: 'args',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      status: 'unknown',
      recordedAt: '2026-08-10T00:00:00.000Z',
      finishedAt: '2026-08-10T00:00:01.000Z',
    };

    expect(decideNextEffect(state)).toMatchObject({
      type: 'recovery_blocked',
      reason: expect.stringContaining('unknown external outcome'),
    });
  });

  test('preserves canonical subagent recovery ahead of legacy plan recovery', () => {
    const state = legacyExecutingPlanState();
    state.legacyUnrecoverableSubagentApproval = {
      toolCallId: 'legacy-task',
      subagentId: 'legacy-subagent',
      reason: 'Legacy subagent continuation cannot be resumed.',
    };

    const effect = decideNextEffect(state);
    expect(effect).toEqual({
      type: 'subagent.recovery_unavailable',
      toolCallId: 'legacy-task',
      subagentId: 'legacy-subagent',
      reason: 'Legacy subagent continuation cannot be resumed.',
    });
    expect(guardLegacyPlanContinuationEffect(state, effect, decideNextEffect(state))).toEqual(
      effect,
    );
  });

  test('keeps every awaiting interaction ahead of legacy plan recovery', () => {
    const scenarios: Array<{
      interaction: RuntimeState['interactions'];
      expected: ReturnType<typeof decideNextEffect>;
    }> = [
      {
        interaction: {
          kind: 'awaiting_user_input',
          interactionId: 'input',
          toolCallId: 'tool-input',
          request: { question: 'Continue?', options: [], allow_free_text: true },
        },
        expected: { type: 'request_user_input', interactionId: 'input', toolCallId: 'tool-input' },
      },
      {
        interaction: {
          kind: 'awaiting_review',
          interactionId: 'review',
          toolCallId: 'tool-review',
          planId: 'legacy-plan',
          version: 1,
          structuralDigest: 'legacy-digest',
          plan: {
            name: 'Legacy Plan',
            description: 'Legacy plan pending review.',
            status: 'pending',
            steps: [{ id: 'legacy-step', step: 'Legacy step', status: 'pending' }],
          },
          planSummary: 'Legacy plan',
        },
        expected: {
          type: 'request_plan_review',
          interactionId: 'review',
          toolCallId: 'tool-review',
        },
      },
      {
        interaction: {
          kind: 'awaiting_tool_approval',
          interactionId: 'approval',
          toolCallId: 'tool-approval',
          approval: {} as never,
        },
        expected: {
          type: 'request_tool_approval',
          interactionId: 'approval',
          toolCallId: 'tool-approval',
        },
      },
      {
        interaction: {
          kind: 'awaiting_auto_review',
          interactionId: 'auto-review',
          toolCallId: 'tool-auto-review',
          toolName: 'shell_execute',
          reason: 'approval needed',
          approval: {} as never,
        },
        expected: {
          type: 'run_auto_review',
          reviewId: 'auto-review',
          toolCallId: 'tool-auto-review',
        },
      },
      {
        interaction: {
          kind: 'awaiting_provider_action',
          interactionId: 'provider-action',
          providerId: 'github',
          action: 'login',
          originatingToolCallId: 'tool-provider',
          status: 'required',
        },
        expected: {
          type: 'request_provider_action',
          interactionId: 'provider-action',
          providerId: 'github',
          action: 'login',
          originatingToolCallId: 'tool-provider',
        },
      },
      {
        interaction: {
          kind: 'awaiting_provider_admission',
          interactionId: 'provider-admission',
          providerId: 'github',
          source: 'project',
          providerStatus: 'login_required',
          retryable: false,
        },
        expected: {
          type: 'request_provider_admission',
          interactionId: 'provider-admission',
          providerId: 'github',
          providerStatus: 'login_required',
          retryable: false,
        },
      },
    ];

    for (const scenario of scenarios) {
      const state = legacyExecutingPlanState();
      state.interactions = scenario.interaction;
      const effect = decideNextEffect(state);
      expect(effect).toEqual(scenario.expected);
      expect(guardLegacyPlanContinuationEffect(state, effect, decideNextEffect(state))).toEqual(
        scenario.expected,
      );
    }
  });

  test('keeps completed and aborted turns stopped until a new turn starts', () => {
    const initial = createInitialRuntimeState({
      threadId: 'terminal-turn',
      userId: 'u',
      workspace: '/',
    });
    const aborted = reduceRuntimeState(initial, {
      type: 'turn.aborted',
      turnId: initial.turn.turnId,
      reason: 'Plan review cancelled.',
      cause: 'user',
    });
    expect(decideNextEffect(aborted)).toEqual({ type: 'stop' });

    const resumed = reduceRuntimeState(aborted, {
      type: 'turn.started',
      turnId: 'next-turn',
    });
    expect(resumed.turn).toEqual({
      turnId: 'next-turn',
      turnIndex: initial.turn.turnIndex + 1,
      status: 'active',
    });
    expect(decideNextEffect(resumed)).toEqual({ type: 'call_model' });

    const completed = reduceRuntimeState(resumed, {
      type: 'turn.completed',
      turnId: resumed.turn.turnId,
    });
    expect(decideNextEffect(completed)).toEqual({ type: 'stop' });
  });

  test('surfaces an auto compaction failure as a terminal recovery block and retries admission next turn', () => {
    const state = createInitialRuntimeState({ threadId: 'compact', userId: 'u', workspace: '/' });
    const failedTurnId = state.turn.turnId;
    state.context.lastFailure = {
      compactionId: 'failed-auto',
      sourceRevision: state.revision,
      errorKind: 'summary_model_failed',
      message: 'provider rejected summary',
      retryable: true,
      reason: 'auto',
      requestedAtTurnId: failedTurnId,
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'recovery_blocked',
      failureKind: 'compaction_failed',
      reason: 'Automatic context compaction failed: provider rejected summary',
    });

    const nextTurn = reduceRuntimeState(state, { type: 'turn.started', turnId: 'next-turn' });
    expect(decideNextEffect(nextTurn)).toEqual({ type: 'call_model' });
  });

  test('gates model execution on the first required provider admission', () => {
    const state = createInitialRuntimeState({ threadId: 'provider', userId: 'u', workspace: '/' });
    const record = {
      interactionId: 'admission',
      providerId: 'github',
      source: 'project' as const,
      providerStatus: 'login_required' as const,
      diagnosticCode: 'auth_required' as const,
      retryable: false,
    };
    state.providerAdmission.pending = [record];
    state.interactions = { kind: 'awaiting_provider_admission', ...record };
    expect(decideNextEffect(state)).toEqual({
      type: 'request_provider_admission',
      interactionId: 'admission',
      providerId: 'github',
      providerStatus: 'login_required',
      retryable: false,
    });
  });

  test('schedules a provider action without requeueing its terminal tool', () => {
    const state = createInitialRuntimeState({ threadId: 'provider', userId: 'u', workspace: '/' });
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__publish',
      args: {},
      status: 'failed',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_provider_action',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
      status: 'required',
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'request_provider_action',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
    });
    expect(state.tools.queue).toEqual([]);
    expect(state.tools.active).toEqual([]);
  });

  test('blocks scheduling until an unknown external invocation is reconciled', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.capabilities.invocations.unknown = {
      invocationId: 'unknown',
      toolCallId: 'mcp-call',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'revision',
      argumentsDigest: 'args',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      status: 'unknown',
      recordedAt: '2026-07-14T00:00:00.000Z',
      finishedAt: '2026-07-14T00:00:01.000Z',
    };
    expect(decideNextEffect(state)).toMatchObject({
      type: 'recovery_blocked',
      reason: expect.stringContaining('unknown external outcome'),
    });
    const events = eventsForRuntimeAction(state, {
      type: 'reconcile_invocation',
      invocationId: 'unknown',
      decision: 'confirmed_success',
    });
    const reconciled = reduceRuntimeState(state, events[0]!);
    expect(reconciled.capabilities.invocations.unknown?.status).toBe('succeeded');
    expect(decideNextEffect(reconciled)).toEqual({ type: 'call_model' });
  });

  test('gives unresolved user interaction priority over queued tools', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.tools.queue.push('tool');
    state.tools.calls.tool = {
      toolCallId: 'tool',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'i',
      toolCallId: 'tool',
      request: { question: 'q', options: [], allow_free_text: true },
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'request_user_input',
      interactionId: 'i',
      toolCallId: 'tool',
    });
  });

  test('runs queued calls before asking the model again', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.tools.queue.push('tool');
    state.tools.calls.tool = {
      toolCallId: 'tool',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['tool'] });
  });

  test('batches consecutive approval-free reads', () => {
    const state = createInitialRuntimeState({
      threadId: 'parallel-reads',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'read-a', {
      name: 'read_file',
      args: { path: 'a.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'search', {
      name: 'search_content',
      args: { path: '.', query: 'needle' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'status', {
      name: 'shell_execute',
      args: { command: 'pwd' },
      effectClass: 'read_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['read-a', 'search', 'status'],
    });
  });

  test('does not batch a shell command whose operands can write', () => {
    const state = createInitialRuntimeState({
      threadId: 'shell-write-shape-barrier',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'read-a', {
      name: 'read_file',
      args: { path: 'a.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    const args = { command: 'uniq input.txt output.txt' };
    const effects = shellExecuteSpec.effects(args, { workspace: '/workspace' });
    queueCall(state, 'unsafe-shell', { name: 'shell_execute', args, ...effects });

    expect(effects).toMatchObject({ effectClass: 'unknown', sideEffect: true });
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['read-a'] });
  });

  test('stops a read batch at the first interaction or side-effect barrier', () => {
    const state = createInitialRuntimeState({
      threadId: 'read-barrier',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'read-a', {
      name: 'read_file',
      args: { path: 'a.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'unknown-shell', {
      name: 'shell_execute',
      args: { command: 'bun test' },
      effectClass: 'unknown',
      sideEffect: true,
    });
    queueCall(state, 'read-b', {
      name: 'read_file',
      args: { path: 'b.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['read-a'],
    });
  });

  test('does not let reads overtake an unknown shell barrier', () => {
    const state = createInitialRuntimeState({
      threadId: 'shell-first-barrier',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'test-shell', {
      name: 'shell_execute',
      args: { command: 'bun test' },
      effectClass: 'unknown',
      sideEffect: true,
    });
    queueCall(state, 'read-after-shell', {
      name: 'read_file',
      args: { path: 'README.md' },
      effectClass: 'read_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['test-shell'],
    });
  });

  test('does not batch control tools even when their capability is read-only', () => {
    const state = createInitialRuntimeState({
      threadId: 'interaction-barrier',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'ask', {
      name: 'ask_user',
      args: { question: 'Continue?' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'read', {
      name: 'read_file',
      args: { path: 'a.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['ask'],
    });
  });

  test('keeps external reads exclusive until their approval is resolved', () => {
    const state = createInitialRuntimeState({
      threadId: 'external-read',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'external', {
      name: 'read_file',
      args: { path: '/outside/secrets.txt' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'workspace', {
      name: 'read_file',
      args: { path: 'a.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['external'],
    });
  });

  test('caps one parallel read batch', () => {
    const state = createInitialRuntimeState({
      threadId: 'bounded-reads',
      userId: 'u',
      workspace: '/workspace',
    });
    for (let index = 0; index < MAX_PARALLEL_READ_TOOLS + 2; index++) {
      queueCall(state, `read-${index}`, {
        name: 'read_file',
        args: { path: `${index}.ts` },
        effectClass: 'read_only',
        sideEffect: false,
      });
    }

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: Array.from({ length: MAX_PARALLEL_READ_TOOLS }, (_, index) => `read-${index}`),
    });
  });

  test('picks approved tool from active list (sub-agent approval resume)', () => {
    // Bug reproduction: after tool.started moves a tool from queue → active,
    // and the tool is later approved (approval.granted), the scheduler must
    // find it in active to issue run_tools, not fall through to call_model.
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    // Tool was started → moved to active, not in queue
    state.tools.active.push('task-tool');
    state.tools.calls['task-tool'] = {
      toolCallId: 'task-tool',
      modelMessageId: '',
      name: 'task',
      args: {},
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    // Queue is empty — approval.granted cleared interaction, but tool stayed in active
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['task-tool'] });
  });

  test('prefers queued tools over active tools', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    // Queued tool
    state.tools.queue.push('queued-tool');
    state.tools.calls['queued-tool'] = {
      toolCallId: 'queued-tool',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    // Active approved tool
    state.tools.active.push('active-tool');
    state.tools.calls['active-tool'] = {
      toolCallId: 'active-tool',
      modelMessageId: '',
      name: 'task',
      args: {},
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    // Queue takes priority
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['queued-tool'] });
  });

  test('resumes a queued tool after auto-review approval', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.tools.queue.push('shell-tool');
    state.tools.calls['shell-tool'] = {
      toolCallId: 'shell-tool',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'printf ok' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    const approval = {
      risk: 'execute_code',
      summary: 'Run shell command',
      reason: 'Needs review',
      command: 'printf ok',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    };
    const awaiting = reduceRuntimeState(state, {
      type: 'auto_review.requested',
      reviewId: 'review-1',
      toolCallId: 'shell-tool',
      toolName: 'shell_execute',
      reason: 'Needs review',
      approval: approval as never,
    });
    const approved = reduceRuntimeState(awaiting, {
      type: 'auto_review.completed',
      reviewId: 'review-1',
      toolCallId: 'shell-tool',
      result: {
        ok: true,
        approved: true,
        grant: 'approve_once',
        reviewerModelName: 'test',
        durationMs: 1,
      },
    });

    expect(approved.interactions.kind).toBe('idle');
    expect(decideNextEffect(approved)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-tool'],
    });
  });

  test('runs each approved shell before requesting approval for its next sibling', () => {
    let state = createInitialRuntimeState({
      threadId: 'parallel-shell-approvals',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'parallel-shell-model';
    for (const [ordinal, toolCallId] of ['shell-1', 'shell-2', 'shell-3'].entries()) {
      state.tools.queue.push(toolCallId);
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId,
        ordinal,
        name: 'shell_execute',
        args: { command: `node task-${ordinal + 1}.js` },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
    }
    const approval = {
      risk: 'execute_code',
      summary: 'Run shell command',
      reason: 'Needs review',
      command: 'node task.js',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    };

    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-1',
      toolCallId: 'shell-1',
      approval: approval as never,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.granted',
      interactionId: 'approval-1',
      toolCallId: 'shell-1',
      grant: 'approve_once',
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-1'],
    });

    state = reduceRuntimeState(state, {
      type: 'tool.started',
      toolCallId: 'shell-1',
    });
    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-2',
      toolCallId: 'shell-2',
      approval: approval as never,
    });
    state = reduceRuntimeState(
      state,
      normalizeCurrentToolOutcomeEventV1(
        {
          type: 'approval.rejected',
          interactionId: 'approval-2',
          toolCallId: 'shell-2',
          reason: 'Rejected by user.',
        },
        state,
        '2026-08-11T00:00:00.000Z',
      ),
    );
    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-3'],
    });

    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-3',
      toolCallId: 'shell-3',
      approval: approval as never,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.granted',
      interactionId: 'approval-3',
      toolCallId: 'shell-3',
      grant: 'approve_once',
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-3'],
    });
  });

  test('does not batch shell calls across an interaction barrier', () => {
    const state = createInitialRuntimeState({
      threadId: 'shell-interaction-barrier',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'mixed-tool-model';
    state.tools.queue.push('shell-before', 'question', 'shell-after');
    state.tools.calls['shell-before'] = {
      toolCallId: 'shell-before',
      modelMessageId,
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.question = {
      toolCallId: 'question',
      modelMessageId,
      ordinal: 1,
      name: 'ask_user',
      args: { question: 'Continue?' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-after'] = {
      toolCallId: 'shell-after',
      modelMessageId,
      ordinal: 2,
      name: 'shell_execute',
      args: { command: 'git status' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-before'],
    });
  });

  test('stops when tools from the latest model response carry a user approval rejection', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
        { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
      ],
    });
    const apprFailure = {
      kind: 'approval_rejected' as const,
      message: 'Rejected',
      retryable: false,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    };
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'rejected',
      failure: apprFailure,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'ls' },
      status: 'rejected',
      failure: apprFailure,
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('calls model for a legacy rejection without an approval_rejected failure', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
        { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
      ],
    });
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'rejected',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'ls' },
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
  });

  test('stops when one sibling succeeded but another has a user approval rejection', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
        { id: 'shell-2', name: 'shell_execute', args: { command: 'node task.js' } },
      ],
    });
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'node task.js' },
      status: 'rejected',
      failure: {
        kind: 'approval_rejected',
        message: 'Cancelled by user.',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
      createdAtTurnId: state.turn.turnId,
    };

    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('stops when all tools from the latest model response are cancelled', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
        { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
      ],
    });
    const cancFailure = {
      kind: 'approval_rejected' as const,
      message: 'Cancelled',
      retryable: false,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    };
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'cancelled',
      failure: cancFailure,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'ls' },
      status: 'cancelled',
      failure: cancFailure,
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('stops when a single tool from the latest model response is rejected', () => {
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    const modelMessageId = 'model-msg';
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: modelMessageId,
      toolCalls: [{ id: 'shell-1', name: 'shell_execute', args: { command: 'rm -rf /' } }],
    });
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId,
      name: 'shell_execute',
      args: { command: 'rm -rf /' },
      status: 'rejected',
      failure: {
        kind: 'approval_rejected' as const,
        message: 'Rejected',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('skips the rejection stop when the latest assistant message has no tool calls', () => {
    // When the last assistant message is text-only, fall through to call_model.
    const state = createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/' });
    state.transcript.messages.push({
      kind: 'assistant',
      messageId: 'model-msg',
      toolCalls: [],
    });
    // Even with stray rejected calls from a prior message, the check only
    // considers the *latest* assistant message with tool calls — and there is none.
    state.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId: 'stale',
      name: 'shell_execute',
      args: {},
      status: 'rejected',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
  });
});
