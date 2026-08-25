import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
  type RuntimeState,
  type ToolCallRecord,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  decideNextEffect as decideKernelNextEffect,
  MAX_PARALLEL_READ_TOOLS,
  MAX_PARALLEL_SUBAGENTS,
} from '#agent-kernel';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import { projectRuntimeSchedulerFacts } from '#app/bootstrap/runtime/scheduler-facts';
import { eventsForRuntimeAction } from '#app/bootstrap/runtime/state-actions';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { testBuiltinToolCatalog } from '../helpers/runtime-model';

function decideNextEffect(state: RuntimeState) {
  return decideKernelNextEffect(
    state as unknown as Parameters<typeof decideKernelNextEffect>[0],
    projectRuntimeSchedulerFacts(state, testBuiltinToolCatalog()),
  );
}

function queueCall(
  state: RuntimeState,
  id: string,
  input: Pick<ToolCallRecord, 'name' | 'args' | 'effectClass' | 'sideEffect'>,
): void {
  state.tools.queue = [...state.tools.queue, id];
  state.tools.calls[id] = {
    toolCallId: id,
    modelMessageId: 'model',
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
    ...input,
  };
}

function privateSuspensionRecord(parentToolCallId: string) {
  return {
    storage: 'private_artifact_v1' as const,
    subagentId: `child-${parentToolCallId}`,
    role: 'review' as const,
    continuationId: `continuation-${'a'.repeat(64)}`,
    modelInvocationOrdinal: 0,
    continuationArtifact: {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'subagent_continuation' as const,
      integrityIdentifier: `sha256:${'c'.repeat(64)}`,
      byteLength: 1,
    },
    parentInvocationId: `parent-${parentToolCallId}`,
    parentAttempt: 1,
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' as const,
      toolCallId: `child-tool-${parentToolCallId}`,
      toolName: 'shell_execute',
    },
  };
}

describe('decideNextEffect', () => {
  test('rejects a Tool interaction whose owner belongs to an older Task', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'stale-interaction-owner',
      userId: 'u',
      workspace: '/workspace',
    });
    state.activeTaskId = 'current-task';
    state.tasks = {
      'current-task': {
        taskId: 'current-task',
        userGoal: 'continue',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      },
    };
    state.tools.calls.old = {
      toolCallId: 'old',
      taskId: 'older-task',
      modelMessageId: 'older-model',
      name: 'shell_execute',
      args: {},
      status: 'awaiting_approval',
      createdAtTurnId: 'older-turn',
    };
    state.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'old-interaction',
      toolCallId: 'old',
      approval: {} as never,
    };

    expect(decideNextEffect(state)).toMatchObject({
      type: 'recovery_blocked',
      failureKind: 'persistence_unavailable',
    });
  });

  test('ignores Skill and suspended child owned by an older Task', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'old-task-control-state',
      userId: 'u',
      workspace: '/workspace',
    });
    state.activeTaskId = 'current-task';
    state.tasks = {
      'current-task': {
        taskId: 'current-task',
        userGoal: 'finish',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      },
    };
    state.tools.calls.old = {
      toolCallId: 'old',
      taskId: 'older-task',
      modelMessageId: 'older-model',
      name: 'task',
      args: {},
      status: 'awaiting_approval',
      createdAtTurnId: 'older-turn',
    };
    state.suspendedSubagents.old = {} as never;
    state.skills.frames.old = {
      activationId: 'old',
      skillId: 'old-skill',
      skillRevision: '1',
      taskId: 'older-task',
      input: {},
      contextMode: 'inline',
      agent: 'main',
      capabilityCeiling: [],
      verificationMode: 'not_required',
      requestedBy: 'user',
      activatedAt: '2026-08-14T00:00:00.000Z',
      status: 'active',
    };
    state.transcript.final = 'done';

    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });
  });

  test('ignores orphaned or terminal suspended subagent residue', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'terminal-subagent-residue',
      userId: 'u',
      workspace: '/workspace',
    });
    state.tools.calls.terminal = {
      toolCallId: 'terminal',
      modelMessageId: 'terminal-model',
      name: 'task',
      args: {},
      status: 'cancelled',
      createdAtTurnId: state.turn.turnId,
    };
    state.suspendedSubagents.terminal = {} as never;
    state.transcript.final = 'done';

    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });

    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });
  });

  test('keeps an empty assistant response and an active Skill inside the model loop', () => {
    const empty = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'empty-final',
      userId: 'u',
      workspace: '/workspace',
    });
    empty.transcript.final = '';
    expect(decideNextEffect(empty)).toEqual({ type: 'call_model' });

    const activeSkill = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'active-skill-final',
      userId: 'u',
      workspace: '/workspace',
    });
    activeSkill.activeTaskId = 'task';
    activeSkill.skills.frames.current = {
      activationId: 'current',
      skillId: 'skill',
      skillRevision: '1',
      taskId: 'task',
      input: {},
      contextMode: 'inline',
      agent: 'main',
      capabilityCeiling: [],
      verificationMode: 'not_required',
      requestedBy: 'user',
      activatedAt: '2026-08-14T00:00:00.000Z',
      status: 'active',
    };
    activeSkill.transcript.final = 'finish only after complete_skill';
    expect(decideNextEffect(activeSkill)).toEqual({ type: 'call_model' });
  });

  test('returns an invalid task call to the normal model loop without forcing a task retry', () => {
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      normalizeCurrentToolOutcomeEvent(
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'quality',
      userId: 'u',
      workspace: '/',
    });
    state.toolRecovery = {
      ...state.toolRecovery,
      qualityGuard: {
        blocked: true,
        reasonCode: 'no_progress',
        observedFailures: 6,
        turnId: state.turn.turnId,
      },
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'recovery_blocked',
      reason: expect.stringContaining('no progress'),
      failureKind: 'loop_exhausted',
      recoveryCause: 'no_progress',
    });
  });

  test('classifies an invalid recovery journal as persistence unavailable', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'invalid',
      userId: 'u',
      workspace: '/',
    });
    state.toolRecovery = {
      ...state.toolRecovery,
      qualityGuard: {
        blocked: true,
        reasonCode: 'journal_invalid',
        observedFailures: 0,
        turnId: state.turn.turnId,
      },
    };
    expect(decideNextEffect(state)).toEqual({
      type: 'recovery_blocked',
      reason: expect.stringContaining('invalid'),
      failureKind: 'persistence_unavailable',
      recoveryCause: 'journal_invalid',
    });
  });

  test('keeps completed and aborted turns stopped until a new turn starts', () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'compact',
      userId: 'u',
      workspace: '/',
    });
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider',
      userId: 'u',
      workspace: '/',
    });
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'provider',
      userId: 'u',
      workspace: '/',
    });
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    state.tools.queue = [...state.tools.queue, 'tool'];
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    state.tools.queue = [...state.tools.queue, 'tool'];
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

  test('batches structured reads and a read-only baseline Shell command', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      args: { path: '.', pattern: 'needle' },
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

  test('does not batch a read whose captured classification fact is missing', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'missing-scheduler-fact',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'read-a', {
      name: 'read_file',
      args: { path: 'a.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'read-b', {
      name: 'read_file',
      args: { path: 'b.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    delete state.tools.calls['read-b']!.effectClass;

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['read-a'],
    });
  });

  test('does not batch a read whose captured classification fact is tampered', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'tampered-scheduler-fact',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'read-a', {
      name: 'read_file',
      args: { path: 'a.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'read-b', {
      name: 'read_file',
      args: { path: 'b.ts' },
      effectClass: 'read_only',
      sideEffect: false,
    });
    state.tools.calls['read-b']!.sideEffect = true;

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['read-a'],
    });
  });

  test('does not batch a shell command whose operands can write', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    const shellEntry = testBuiltinToolCatalog().entries.find(
      (entry) => entry.visibility === 'model' && entry.name === 'shell_execute',
    );
    if (!shellEntry) throw new Error('shell_execute catalog entry is unavailable');
    const effects = shellEntry.classifyEffects(args, { workspace: '/workspace' });
    queueCall(state, 'unsafe-shell', { name: 'shell_execute', args, ...effects });

    expect(effects).toMatchObject({ effectClass: 'unknown', sideEffect: true });
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['read-a'] });
  });

  test('stops a read batch at the first interaction or side-effect barrier', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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

  test('batches independent read-only sibling subagents', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'parallel-subagents',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'review-a', {
      name: 'task',
      args: {
        name: 'Review runtime correctness',
        subagent_type: 'review',
        task: 'Review runtime correctness and report evidence.',
      },
      effectClass: 'read_only',
      sideEffect: false,
    });
    queueCall(state, 'review-b', {
      name: 'task',
      args: {
        name: 'Review test coverage',
        subagent_type: 'review',
        task: 'Review test coverage and report evidence.',
      },
      effectClass: 'read_only',
      sideEffect: false,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['review-a', 'review-b'],
    });
  });

  test('serializes sibling workspace writers even when policy approval is bypassed', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'serialized-subagent-writers',
      userId: 'u',
      workspace: '/workspace',
      interactionMode: 'full',
    });
    queueCall(state, 'code-a', {
      name: 'task',
      args: {
        name: 'Implement first workspace change',
        subagent_type: 'code',
        task: 'Implement the first workspace change.',
      },
      effectClass: 'workspace_write',
      sideEffect: true,
    });
    queueCall(state, 'code-b', {
      name: 'task',
      args: {
        name: 'Implement second workspace change',
        subagent_type: 'code',
        task: 'Implement the second workspace change.',
      },
      effectClass: 'workspace_write',
      sideEffect: true,
    });

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['code-a'],
    });
  });

  test('caps one parallel subagent batch', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'bounded-subagents',
      userId: 'u',
      workspace: '/workspace',
    });
    for (let index = 0; index < MAX_PARALLEL_SUBAGENTS + 2; index++) {
      queueCall(state, `review-${index}`, {
        name: 'task',
        args: {
          name: `Review concern ${index}`,
          subagent_type: 'review',
          task: `Review independent concern ${index}.`,
        },
        effectClass: 'read_only',
        sideEffect: false,
      });
      state.tools.calls[`review-${index}`]!.modelMessageId = 'model';
    }

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: Array.from({ length: MAX_PARALLEL_SUBAGENTS }, (_, index) => `review-${index}`),
    });
  });

  test('batches workspace and external filesystem reads without approval serialization', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      toolCallIds: ['external', 'workspace'],
    });
  });

  test('caps one parallel read batch', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    // Tool was started → moved to active, not in queue
    state.tools.active = [...state.tools.active, 'task-tool'];
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

  test('skips historical queued calls that completion also excludes from current work', () => {
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'historical-tool-scope',
      userId: 'u',
      workspace: '/',
    });
    state = reduceRuntimeState(state, {
      type: 'task.started',
      taskId: 'current-task',
      userGoal: 'Continue current work.',
      turnId: state.turn.turnId,
    });
    state.tools.queue = [
      ...state.tools.queue,
      'older-task-tool',
      'legacy-older-turn',
      'current-tool',
    ];
    state.tools.calls['older-task-tool'] = {
      toolCallId: 'older-task-tool',
      taskId: 'older-task',
      modelMessageId: 'older-model',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: 'older-turn',
    };
    state.tools.calls['legacy-older-turn'] = {
      toolCallId: 'legacy-older-turn',
      modelMessageId: 'legacy-model',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: 'older-turn',
    };
    state.tools.calls['current-tool'] = {
      toolCallId: 'current-tool',
      taskId: 'current-task',
      modelMessageId: 'current-model',
      name: 'write_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['current-tool'],
    });
  });

  test('fails closed immediately for a current interaction-owned tool with no interaction', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'stranded-interaction-tool',
      userId: 'u',
      workspace: '/',
    });
    state.tools.calls.stranded = {
      toolCallId: 'stranded',
      modelMessageId: 'model',
      name: 'write_plan',
      args: {},
      status: 'awaiting_review',
      createdAtTurnId: state.turn.turnId,
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'recovery_blocked',
      reason: expect.stringContaining('without its owning interaction'),
      failureKind: 'persistence_unavailable',
    });
  });

  test('prefers queued tools over active tools', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    // Queued tool
    state.tools.queue = [...state.tools.queue, 'queued-tool'];
    state.tools.calls['queued-tool'] = {
      toolCallId: 'queued-tool',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    // Active approved tool
    state.tools.active = [...state.tools.active, 'active-tool'];
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

  test('resumes an approved suspended child before a deferred queued sibling', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'approved-child-before-deferred-sibling',
      userId: 'u',
      workspace: '/workspace',
    });
    queueCall(state, 'deferred-task', {
      name: 'task',
      args: {
        name: 'Review deferred sibling',
        subagent_type: 'review',
        task: 'Review the deferred sibling.',
      },
      effectClass: 'read_only',
      sideEffect: false,
    });
    state.suspendedSubagents['deferred-task'] = {} as never;
    state.tools.active = [...state.tools.active, 'approved-task'];
    state.tools.calls['approved-task'] = {
      toolCallId: 'approved-task',
      modelMessageId: 'model',
      name: 'task',
      args: {
        name: 'Resume approved review',
        subagent_type: 'review',
        task: 'Resume the approved child.',
      },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.suspendedSubagents['approved-task'] = {} as never;

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['approved-task'],
    });
  });

  test('preserves the current child across concurrent suspension, deferral, and auto-review', () => {
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'concurrent-child-auto-review-order',
      userId: 'u',
      workspace: '/workspace',
    });
    for (const id of ['task-a', 'task-b']) {
      queueCall(state, id, {
        name: 'task',
        args: { name: `Review ${id}`, subagent_type: 'review', task: `Review ${id}.` },
        effectClass: 'read_only',
        sideEffect: false,
      });
      state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: id });
      state = reduceRuntimeState(state, {
        type: 'subagent.suspended',
        toolCallId: id,
        snapshot: privateSuspensionRecord(id),
      });
    }
    state = reduceRuntimeState(state, {
      type: 'auto_review.requested',
      reviewId: 'review-a',
      toolCallId: 'task-a',
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      toolName: 'shell_execute',
      reason: 'Review child command.',
      approval: {} as never,
    });
    state = reduceRuntimeState(state, {
      type: 'subagent.approval_deferred',
      toolCallId: 'task-b',
    });
    state = reduceRuntimeState(state, {
      type: 'auto_review.completed',
      reviewId: 'review-a',
      toolCallId: 'task-a',
      result: {
        ok: true,
        approved: true,
        grant: 'approve_once',
        reason: 'safe',
        reviewerModelName: 'fixture',
        durationMs: 1,
      },
    });

    expect(state.tools.calls['task-a']?.status).toBe('authorized_queued');
    expect(state.tools.calls['task-b']?.status).toBe('queued');
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['task-a'] });
  });

  test('never schedules a deferred Subagent child tool ahead of its parent continuation', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'deferred-child-tool-ownership',
      userId: 'u',
      workspace: '/workspace',
    });
    const parentToolCallId = 'task-deferred';
    const childToolCallId = 'subagent-tool:deferred-shell';
    const childModelInvocationId = 'child-model-deferred';
    state.modelInvocations[childModelInvocationId] = {
      invocationId: childModelInvocationId,
      purpose: 'subagent',
      status: 'completed',
      surfaceArtifact: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'model_surface',
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 1,
      },
      surfaceIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
      routeFingerprint: `sha256:${'c'.repeat(64)}`,
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 1, perAttemptTimeoutMs: 1, totalTimeBudgetMs: 1 },
      preparedStateRevision: 0,
      parentInvocationId: 'parent-model',
      parentToolCallId,
      attempts: 1,
      finishReason: 'tool_calls',
    };
    state.tools.calls[childToolCallId] = {
      toolCallId: childToolCallId,
      modelInvocationId: childModelInvocationId,
      modelMessageId: childModelInvocationId,
      name: 'shell_execute',
      args: { command: 'find packages/runtime-host/src -type f | sort' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls[parentToolCallId] = {
      toolCallId: parentToolCallId,
      modelInvocationId: 'parent-model',
      modelMessageId: 'parent-model',
      name: 'task',
      args: { name: 'Inspect runtime', subagent_type: 'explore', task: 'Inspect runtime files.' },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [childToolCallId, parentToolCallId];
    state.suspendedSubagents[parentToolCallId] = {
      ...privateSuspensionRecord(parentToolCallId),
      blockedTool: {
        ...privateSuspensionRecord(parentToolCallId).blockedTool,
        runtimeToolCallId: childToolCallId,
      },
    };

    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: [parentToolCallId],
    });
    expect(state.tools.calls[childToolCallId]?.status).toBe('queued');
  });

  test('keeps completed siblings terminal while serializing concurrent child approvals', () => {
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'mixed-concurrent-child-approvals',
      userId: 'u',
      workspace: '/workspace',
    });
    for (const id of ['task-a', 'task-b', 'task-c']) {
      queueCall(state, id, {
        name: 'task',
        args: { name: `Review ${id}`, subagent_type: 'review', task: `Review ${id}.` },
        effectClass: 'read_only',
        sideEffect: false,
      });
      state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: id });
    }
    for (const id of ['task-a', 'task-b']) {
      state = reduceRuntimeState(state, {
        type: 'subagent.suspended',
        toolCallId: id,
        snapshot: privateSuspensionRecord(id),
      });
    }
    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-a',
      toolCallId: 'task-a',
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      approval: {} as never,
    });
    state = reduceRuntimeState(state, {
      type: 'subagent.approval_deferred',
      toolCallId: 'task-b',
    });
    state = reduceRuntimeState(
      state,
      normalizeCurrentToolOutcomeEvent(
        {
          type: 'tool.finished',
          toolCallId: 'task-c',
          name: 'task',
          result: { ok: true, command: '', exitCode: 0, stdout: 'done', stderr: '' },
        },
        state,
        '2026-08-24T00:00:00.000Z',
      ),
    );

    expect(state.interactions).toMatchObject({
      kind: 'awaiting_tool_approval',
      interactionId: 'approval-a',
      toolCallId: 'task-a',
    });
    expect(state.tools.calls['task-a']?.status).toBe('awaiting_approval');
    expect(state.tools.calls['task-b']?.status).toBe('queued');
    expect(state.tools.calls['task-c']?.status).toBe('succeeded');
    expect(Object.keys(state.suspendedSubagents).sort()).toEqual(['task-a', 'task-b']);
    expect(decideNextEffect(state)).toEqual({
      type: 'request_tool_approval',
      interactionId: 'approval-a',
      toolCallId: 'task-a',
    });

    state = reduceRuntimeState(state, {
      type: 'approval.granted',
      interactionId: 'approval-a',
      toolCallId: 'task-a',
      grant: 'approve_once',
      receiptId: 'receipt-task-a',
      generation: 0,
    });
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['task-a'] });

    state = reduceRuntimeState(
      state,
      normalizeCurrentToolOutcomeEvent(
        {
          type: 'tool.finished',
          toolCallId: 'task-a',
          name: 'task',
          result: { ok: true, command: '', exitCode: 0, stdout: 'resumed', stderr: '' },
        },
        state,
        '2026-08-24T00:00:01.000Z',
      ),
    );
    expect(state.tools.calls['task-a']?.status).toBe('succeeded');
    expect(state.tools.calls['task-c']?.status).toBe('succeeded');
    expect(Object.keys(state.suspendedSubagents)).toEqual(['task-b']);
    expect(decideNextEffect(state)).toEqual({ type: 'run_tools', toolCallIds: ['task-b'] });

    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-b',
      toolCallId: 'task-b',
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      approval: {} as never,
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'request_tool_approval',
      interactionId: 'approval-b',
      toolCallId: 'task-b',
    });
    expect(state.tools.calls['task-c']?.status).toBe('succeeded');
  });

  test('resumes a queued tool after auto-review approval', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    state.tools.queue = [...state.tools.queue, 'shell-tool'];
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
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
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
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'parallel-shell-approvals',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'parallel-shell-model';
    for (const [ordinal, toolCallId] of ['shell-1', 'shell-2', 'shell-3'].entries()) {
      state.tools.queue = [...state.tools.queue, toolCallId];
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
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      approval: approval as never,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.granted',
      interactionId: 'approval-1',
      toolCallId: 'shell-1',
      grant: 'approve_once',
      receiptId: 'receipt-shell-1',
      generation: 0,
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
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      approval: approval as never,
    });
    state = reduceRuntimeState(
      state,
      normalizeCurrentToolOutcomeEvent(
        {
          type: 'approval.rejected',
          interactionId: 'approval-2',
          toolCallId: 'shell-2',
          generation: 0,
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
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      approval: approval as never,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.granted',
      interactionId: 'approval-3',
      toolCallId: 'shell-3',
      grant: 'approve_once',
      receiptId: 'receipt-shell-3',
      generation: 0,
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'run_tools',
      toolCallIds: ['shell-3'],
    });
  });

  test('does not batch shell calls across an interaction barrier', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'shell-interaction-barrier',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'mixed-tool-model';
    state.tools.queue = [...state.tools.queue, 'shell-before', 'question', 'shell-after'];
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'model-msg';
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'assistant',
        messageId: modelMessageId,
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        toolCalls: [
          { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
          { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
        ],
      },
    ];
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'model-msg';
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'assistant',
        messageId: modelMessageId,
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        toolCalls: [
          { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
          { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
        ],
      },
    ];
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'model-msg';
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'assistant',
        messageId: modelMessageId,
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        toolCalls: [
          { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
          { id: 'shell-2', name: 'shell_execute', args: { command: 'node task.js' } },
        ],
      },
    ];
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'model-msg';
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'assistant',
        messageId: modelMessageId,
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        toolCalls: [
          { id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } },
          { id: 'shell-2', name: 'shell_execute', args: { command: 'ls' } },
        ],
      },
    ];
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    const modelMessageId = 'model-msg';
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'assistant',
        messageId: modelMessageId,
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        toolCalls: [{ id: 'shell-1', name: 'shell_execute', args: { command: 'rm -rf /' } }],
      },
    ];
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
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: '/',
    });
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'assistant',
        messageId: 'model-msg',
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        toolCalls: [],
      },
    ];
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
