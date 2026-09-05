import { describe, expect, test } from 'bun:test';
import type {
  RuntimeClientEvent,
  RuntimeInteractionQueueProjection,
} from '@kite-ai/runtime-contract';
import { createInitialState } from '../src/tui/App';
import { isTuiRunActive } from '../src/tui/presentation/selectors';
import type { Action } from '../src/tui/reducers';
import { eventReducer as reduceEvent } from '../src/tui/reducers';
import type { OutputBlock, TuiRuntimeAuthorityProjection, TuiState } from '../src/tui/types';
import { acceptedEnvelopeForState } from './helpers/accepted-envelope';

type AcceptedEnvelopeAction = { type: 'ACCEPT_PRESENTATION_ENVELOPE'; event: RuntimeClientEvent };

/** Test-only adapter: production eventReducer accepts envelopes exclusively. */
function eventReducer(state: TuiState, action: Action | AcceptedEnvelopeAction): TuiState {
  if (action.type !== 'ACCEPT_PRESENTATION_ENVELOPE') return reduceEvent(state, action);
  const event =
    typeof action.event === 'object' && action.event !== null && 'event' in action.event
      ? action.event
      : acceptedEnvelopeForState(action.event, state);
  return reduceEvent(state, { type: 'ACCEPT_PRESENTATION_ENVELOPE', event });
}

function apply(state: TuiState, event: RuntimeClientEvent): TuiState {
  return eventReducer(state, { type: 'ACCEPT_PRESENTATION_ENVELOPE', event });
}

function blocks(state: TuiState) {
  return state.turns.flatMap((turn) => turn.blocks);
}

function activeRuntimeAuthority(runId = 'run-1', turnId = 'turn-1'): TuiRuntimeAuthorityProjection {
  return {
    revision: 1,
    currentRun: {
      runId,
      initialTurnId: turnId,
      activeTurnId: turnId,
      status: 'running',
      revision: 1,
    },
    interactionQueue: { revision: 1, interactions: [] },
  };
}

function runtimeProjection(
  interactionQueue: RuntimeInteractionQueueProjection,
  active = true,
): TuiRuntimeAuthorityProjection {
  return {
    revision: interactionQueue.revision,
    ...(active
      ? {
          currentRun: {
            runId: 'run-snapshot',
            initialTurnId: 'turn-snapshot',
            activeTurnId: 'turn-snapshot',
            status: 'waiting' as const,
            revision: interactionQueue.revision,
          },
        }
      : {}),
    interactionQueue,
  };
}

describe('TUI RuntimeClientEvent reducer', () => {
  test('keeps a local slash command in the current presentation turn', () => {
    let state = createInitialState();
    state = apply(state, {
      type: 'user.message',
      messageId: 'user-1',
      kind: 'task',
      text: '你好',
    });
    state = apply(state, {
      type: 'model.responded',
      requestId: 'request-1',
      messageId: 'message-1',
      toolCallCount: 0,
      summary: '你好！',
    });
    const turnCount = state.turns.length;

    state = eventReducer(state, { type: 'LOCAL_COMMAND', text: '/status' });
    state = eventReducer(state, { type: 'LOCAL_TEXT', text: '  ⎿  Service PID: 42' });

    expect(state.turns).toHaveLength(turnCount);
    expect(state.turns.at(-1)?.blocks.slice(-2)).toEqual([
      expect.objectContaining({ kind: 'user', content: '/status' }),
      expect.objectContaining({ kind: 'text', content: '  ⎿  Service PID: 42' }),
    ]);
  });

  test('clear output preserves monotonic block identities for the next epoch', () => {
    let state = apply(createInitialState(), {
      type: 'user.message',
      messageId: 'user-before-clear',
      kind: 'task',
      text: 'Before clear',
    });
    const firstId = state.turns.at(-1)?.blocks.at(-1)?.id;
    expect(firstId).toBeDefined();

    state = eventReducer(state, { type: 'CLEAR_OUTPUT' });
    expect(state.turns).toEqual([]);
    expect(state.nextBlockId).toBeGreaterThan(firstId!);

    state = apply(state, {
      type: 'user.message',
      messageId: 'user-after-clear',
      kind: 'task',
      text: 'After clear',
    });
    expect(state.turns.at(-1)?.blocks.at(-1)?.id).toBe(state.nextBlockId - 1);
    expect(state.turns.at(-1)?.blocks.at(-1)?.id).toBeGreaterThan(firstId!);
  });

  test('renders safe user, model, tool, and terminal facts', () => {
    let state: TuiState = {
      ...createInitialState(),
      runtimeAuthority: activeRuntimeAuthority(),
    };
    const events: readonly RuntimeClientEvent[] = [
      { type: 'user.message', messageId: 'user-1', kind: 'task', text: 'Update the client.' },
      { type: 'model.requested', requestId: 'request-1' },
      { type: 'model.text_delta', requestId: 'request-1', text: 'Working on it.' },
      {
        type: 'tool.queued',
        toolId: 'tool-1',
        toolName: 'write_file',
        presentation: 'standalone',
        arguments: {},
        summary: 'Inspecting dependencies.',
      },
      { type: 'tool.progress', toolId: 'tool-1', summary: 'Tool output updated.', lineCount: 2 },
      {
        type: 'tool.finished',
        toolId: 'tool-1',
        toolName: 'write_file',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
        summary: 'Inspection completed.',
      },
      {
        type: 'model.responded',
        requestId: 'request-1',
        messageId: 'message-1',
        toolCallCount: 0,
        summary: 'Done.',
      },
      { type: 'run.terminal', runId: 'run-1', status: 'completed' },
    ];
    for (const event of events) state = apply(state, event);

    expect(isTuiRunActive(state)).toBe(false);
    expect(state.exited).toBe(true);
    expect(blocks(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', content: 'Update the client.' }),
        expect.objectContaining({ kind: 'tool_card', callId: 'tool-1', args: {}, status: 'done' }),
        expect.objectContaining({ kind: 'text', content: 'Done.' }),
      ]),
    );
  });

  test('keeps approval identity and generation without a raw approval payload', () => {
    const state = apply(createInitialState(), {
      type: 'approval.queued',
      queueSequence: 3,
      interaction: {
        kind: 'approval',
        interactionId: 'approval-1',
        sessionRevision: 8,
        generation: 2,
        grants: ['approve_once'],
        owner: { kind: 'root_tool', toolCallId: 'approval-1' },
      },
    });

    expect(state.interrupt).toEqual(
      expect.objectContaining({ kind: 'approval', interactionId: 'approval-1' }),
    );
    expect(state.pendingApprovals?.get('approval-1')).toEqual(
      expect.objectContaining({
        generation: 2,
        sequence: 3,
        clientInteraction: expect.objectContaining({
          interactionId: 'approval-1',
          grants: ['approve_once'],
        }),
      }),
    );
  });

  test('renders the original tool card when approval rejects it before dispatch', () => {
    let state = createInitialState();
    state = apply(state, {
      type: 'tool.queued',
      toolId: 'shell-rejected-by-user',
      toolName: 'shell_execute',
      presentation: 'standalone',
      arguments: { command: 'git status' },
      summary: 'Queued.',
    });
    state = apply(state, {
      type: 'approval.queued',
      queueSequence: 1,
      interaction: {
        kind: 'approval',
        interactionId: 'approval-rejected-by-user',
        sessionRevision: 3,
        generation: 0,
        grants: ['approve_once'],
        owner: { kind: 'root_tool', toolCallId: 'approval-rejected-by-user' },
        command: 'git status',
      },
    });
    state = apply(state, {
      type: 'approval.rejected',
      interactionId: 'approval-rejected-by-user',
      generation: 0,
      owner: { kind: 'root_tool', toolCallId: 'approval-rejected-by-user' },
    });
    state = apply(state, {
      type: 'tool.rejected',
      toolId: 'shell-rejected-by-user',
      presentation: 'standalone',
      summary: 'Cancelled by user.',
    });

    expect(blocks(state).filter((block) => block.kind === 'text')).toHaveLength(0);
    expect(blocks(state)).toContainEqual(
      expect.objectContaining({
        kind: 'tool_card',
        callId: 'shell-rejected-by-user',
        name: 'shell_execute',
        args: { command: 'git status' },
        status: 'rejected',
        summary: 'Cancelled by user.',
      }),
    );
  });

  test('keeps accepted approval tool metadata until authoritative tool events settle it', () => {
    const queuedTool: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'approval-accepted-tool',
      name: 'shell_execute',
      args: { command: 'git status' },
      status: 'queued',
      summary: 'Queued.',
    };
    const queuedSummary: OutputBlock = {
      id: 2,
      kind: 'tool_summary',
      tools: [
        {
          callId: 'approval-accepted-summary-tool',
          name: 'read_file',
          args: { path: 'README.md' },
          status: 'running',
          ok: false,
          summary: 'Running.',
        },
      ],
      totalElapsedMs: 0,
      createdAt: Date.now(),
      summaryLine: 'read 1 file',
      active: true,
      hasThought: false,
    };
    const interaction = {
      kind: 'approval' as const,
      interactionId: 'approval-accepted',
      sessionRevision: 4,
      generation: 0,
      grants: ['approve_once' as const],
      owner: { kind: 'root_tool' as const, toolCallId: 'approval-accepted' },
      command: 'git status',
    };
    let state = eventReducer(
      {
        ...createInitialState(),
        runPromptPresented: false,
        turns: [{ blocks: [queuedTool, queuedSummary] }],
        nextBlockId: 3,
        currentThoughtSummaryId: queuedSummary.id,
        pendingToolCalls: {
          [queuedTool.callId]: {
            name: queuedTool.name,
            args: queuedTool.args,
            presentation: 'standalone',
          },
        },
        pendingApprovals: new Map([
          [
            interaction.interactionId,
            {
              interactionId: interaction.interactionId,
              toolCallId: queuedTool.callId,
              owner: interaction.owner,
              route: 'user',
              status: 'awaiting_user',
              sequence: 0,
              generation: interaction.generation,
              clientInteraction: interaction,
            },
          ],
        ]),
        activeApprovalId: interaction.interactionId,
        interrupt: {
          kind: 'approval',
          interactionId: interaction.interactionId,
          toolCallId: queuedTool.callId,
        },
      },
      {
        type: 'RESOLVE_INTERRUPT',
        resolution: { action: 'approved', grant: 'approve_once' },
      },
    );
    expect(state.pendingApprovals?.get(interaction.interactionId)?.status).toBe('approving');
    state = eventReducer(state, {
      type: 'RECONCILE_RUNTIME_PROJECTION',
      projection: runtimeProjection({
        revision: 5,
        activeInteractionId: interaction.interactionId,
        interactions: [{ ...interaction, sessionRevision: 5 }],
      }),
    });

    expect(blocks(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'approval-accepted-tool',
          status: 'queued',
        }),
        expect.objectContaining({
          kind: 'tool_summary',
          id: queuedSummary.id,
          active: true,
          tools: [expect.objectContaining({ status: 'running' })],
        }),
      ]),
    );
    expect(state.pendingToolCalls[queuedTool.callId]).toEqual(
      expect.objectContaining({ name: 'shell_execute', args: { command: 'git status' } }),
    );

    state = apply(state, { type: 'tool.started', toolId: queuedTool.callId });
    expect(blocks(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_card',
          callId: queuedTool.callId,
          status: 'running',
        }),
      ]),
    );
    state = apply(state, {
      type: 'tool.finished',
      toolId: queuedTool.callId,
      toolName: 'shell_execute',
      presentation: 'standalone',
      result: { ok: true, exitCode: 0, stdout: 'clean', stderr: '' },
      summary: 'Completed.',
    });
    expect(blocks(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_card',
          callId: queuedTool.callId,
          status: 'done',
          args: { command: 'git status' },
        }),
      ]),
    );
  });

  test('reconciles an approval directly from an authoritative Runtime snapshot', () => {
    const state = eventReducer(
      { ...createInitialState(), runPromptPresented: false, runStartTime: Date.now() },
      {
        type: 'RECONCILE_RUNTIME_PROJECTION',
        projection: runtimeProjection({
          revision: 12,
          activeInteractionId: 'snapshot-approval-1',
          interactions: [
            {
              kind: 'approval',
              interactionId: 'snapshot-approval-1',
              sessionRevision: 12,
              generation: 4,
              grants: ['approve_once'],
              owner: { kind: 'root_tool', toolCallId: 'snapshot-approval-1' },
              command: 'ls packages',
            },
          ],
        }),
      },
    );

    expect(isTuiRunActive(state)).toBe(true);
    expect(state.interrupt).toEqual({
      kind: 'approval',
      interactionId: 'snapshot-approval-1',
      toolCallId: 'snapshot-approval-1',
    });
    expect(state.pendingApprovals?.get('snapshot-approval-1')).toEqual(
      expect.objectContaining({
        generation: 4,
        clientInteraction: expect.objectContaining({ command: 'ls packages' }),
      }),
    );
  });

  test('replaces stale approval state from the complete Runtime interaction queue', () => {
    let state = apply(createInitialState(), {
      type: 'approval.queued',
      queueSequence: 1,
      interaction: {
        kind: 'approval',
        interactionId: 'snapshot-old',
        sessionRevision: 8,
        generation: 1,
        grants: ['approve_once'],
        owner: { kind: 'root_tool', toolCallId: 'snapshot-old' },
      },
    });
    state = eventReducer(state, {
      type: 'RECONCILE_RUNTIME_PROJECTION',
      projection: runtimeProjection({
        revision: 9,
        activeInteractionId: 'snapshot-new',
        interactions: [
          {
            kind: 'approval',
            interactionId: 'snapshot-new',
            sessionRevision: 9,
            generation: 2,
            grants: ['approve_once'],
            owner: { kind: 'root_tool', toolCallId: 'snapshot-new' },
          },
        ],
      }),
    });

    expect([...state.pendingApprovals!.keys()]).toEqual(['snapshot-new']);
    expect(state.interrupt).toEqual(
      expect.objectContaining({ kind: 'approval', interactionId: 'snapshot-new' }),
    );

    state = eventReducer(
      { ...state, runPromptPresented: true, interrupt: null },
      {
        type: 'RECONCILE_RUNTIME_PROJECTION',
        projection: runtimeProjection({ revision: 10, interactions: [] }, false),
      },
    );
    expect(state.pendingApprovals).toEqual(new Map());
    expect(state.activeApprovalId).toBeNull();
    expect(state.interrupt).toBeNull();
  });

  test('reuses non-approval presentation blocks for repeated authoritative snapshots', () => {
    const interactions = [
      {
        kind: 'input' as const,
        interactionId: 'snapshot-input',
        sessionRevision: 12,
        question: 'Continue?',
        allowFreeText: true,
        options: [{ id: 'yes', label: 'Yes' }],
      },
      {
        kind: 'plan_review' as const,
        interactionId: 'snapshot-plan',
        sessionRevision: 12,
        plan: { planId: 'plan-1', version: 1, structuralDigest: 'sha256:plan-1' },
        title: 'Review this plan',
        summary: 'One safe review.',
      },
      {
        kind: 'provider_action' as const,
        interactionId: 'snapshot-provider',
        sessionRevision: 12,
        provider: { providerId: 'provider-1' },
        action: 'login' as const,
      },
      {
        kind: 'verification' as const,
        interactionId: 'snapshot-verification',
        sessionRevision: 12,
        verification: { verificationId: 'verification-1', revision: '1' },
      },
    ];

    for (const interaction of interactions) {
      let state = createInitialState();
      const action = {
        type: 'RECONCILE_RUNTIME_PROJECTION' as const,
        projection: runtimeProjection({
          revision: 12,
          activeInteractionId: interaction.interactionId,
          interactions: [interaction],
        }),
      };
      state = eventReducer(state, action);
      const firstInterrupt = state.interrupt;
      const firstBlocks = blocks(state);
      state = eventReducer(state, action);

      expect(state.interrupt).toEqual(firstInterrupt);
      expect(blocks(state)).toEqual(firstBlocks);
    }
  });

  test('settles presentation activity from an idle snapshot without inventing cancellation', () => {
    let state = apply(eventReducer(createInitialState(), { type: 'SET_RUNNING' }), {
      type: 'model.requested',
      requestId: 'snapshot-request-1',
    });
    state = apply(state, {
      type: 'reasoning.activity',
      requestId: 'snapshot-request-1',
      state: 'completed',
      segmentId: 'snapshot-reasoning-1',
      text: 'Selecting exploration tools.',
    });
    state = eventReducer(state, {
      type: 'RECONCILE_RUNTIME_PROJECTION',
      projection: runtimeProjection({ revision: 3, interactions: [] }, false),
    });

    expect(isTuiRunActive(state)).toBe(false);
    expect(state.exited).toBe(false);
    expect(state.interrupt).toBeNull();
    expect(blocks(state)).toEqual([
      expect.objectContaining({
        kind: 'tool_summary',
        active: false,
        tools: [],
      }),
    ]);
    expect(
      (blocks(state)[0] as Extract<OutputBlock, { kind: 'tool_summary' }>).result,
    ).toBeUndefined();
    expect(blocks(state)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Cancel') }),
      ]),
    );
  });

  test('uses only closed approval fields and does not duplicate model terminal text', () => {
    let state = apply(
      {
        ...createInitialState(),
        runtimeAuthority: activeRuntimeAuthority(),
      },
      {
        type: 'model.responded',
        requestId: 'request-1',
        messageId: 'message-1',
        toolCallCount: 0,
        summary: 'Completed safely.',
      },
    );
    state = apply(state, {
      type: 'run.terminal',
      runId: 'run-1',
      status: 'completed',
      summary: 'Completed safely.',
    });

    const rendered = blocks(state).filter(
      (block): block is Extract<OutputBlock, { kind: 'text' }> =>
        block.kind === 'text' && block.content === 'Completed safely.',
    );
    expect(rendered).toHaveLength(1);
    expect(isTuiRunActive(state)).toBe(false);
    expect(state.exited).toBe(true);
  });

  test('projects content-free lifecycle and failure facts', () => {
    let state = apply(
      {
        ...createInitialState(),
        runtimeAuthority: activeRuntimeAuthority(),
      },
      { type: 'planning.entered', taskId: 'task-1' },
    );
    state = apply(state, { type: 'interaction_mode.changed', mode: 'full' });
    state = apply(state, {
      type: 'reasoning.activity',
      requestId: 'request-reasoning-1',
      state: 'streaming',
      segmentId: 'reasoning-1',
      text: 'Thinking.',
    });
    state = apply(state, {
      type: 'run.terminal',
      runId: 'run-1',
      status: 'failed',
      outcome: {
        status: 'unknown',
        reasonCode: 'provider_unavailable',
        safeRetry: true,
        recoveryEntry: 'retry',
      },
    });

    expect(state.status.phase).toBe('planning');
    expect(state.interactionMode).toBe('full');
    expect(state.currentModelReasoningStreamed).toBe(false);
    expect(state.currentModelReasoningRequestId).toBeUndefined();
    expect(state.currentModelReasoningText).toBeUndefined();
    expect(isTuiRunActive(state)).toBe(false);
    expect(blocks(state)).toContainEqual(
      expect.objectContaining({ kind: 'tool_summary', active: false, hasThinking: true }),
    );
    expect(blocks(state)).toContainEqual(
      expect.objectContaining({ content: 'MODEL_ATTEMPT_RETRYABLE_FAILURE:provider_unavailable' }),
    );
  });

  test('projects input and plan interactions, then clears them only by identity', () => {
    let state = apply(createInitialState(), {
      type: 'input.requested',
      interaction: {
        kind: 'input',
        interactionId: 'input-1',
        sessionRevision: 4,
        question: 'Continue?',
        allowFreeText: true,
        options: [{ id: 'yes', label: 'Yes' }],
      },
    });
    state = apply(state, { type: 'input.answered', interactionId: 'other-input' });
    expect(state.interrupt).toEqual(expect.objectContaining({ interactionId: 'input-1' }));
    state = apply(state, {
      type: 'input.answered',
      interactionId: 'input-1',
      summary: 'Answered.',
    });
    expect(state.interrupt).toBeNull();

    state = apply(state, {
      type: 'plan.review_requested',
      interaction: {
        kind: 'plan_review',
        interactionId: 'plan-review-1',
        sessionRevision: 5,
        plan: { planId: 'plan-1', version: 1, structuralDigest: 'sha256:plan-1' },
        title: 'Safe plan title',
        summary: 'Safe plan summary',
      },
    });
    expect(state.interrupt).toEqual(
      expect.objectContaining({
        kind: 'plan_review',
        interactionId: 'plan-review-1',
        plan: expect.objectContaining({
          name: 'Safe plan title',
          description: 'Safe plan summary',
        }),
      }),
    );
    expect(blocks(state)).toContainEqual(expect.objectContaining({ content: 'Safe plan title' }));
  });

  test('renders provider, verification, subagent, compaction and unavailable notices', () => {
    let state = createInitialState();
    const events: readonly RuntimeClientEvent[] = [
      {
        type: 'provider.action',
        status: 'required',
        interaction: {
          kind: 'provider_action',
          interactionId: 'provider-1',
          sessionRevision: 1,
          provider: { providerId: 'provider' },
          action: 'login',
        },
      },
      {
        type: 'verification.status',
        status: 'pending',
        interaction: {
          kind: 'verification',
          interactionId: 'verification-1',
          sessionRevision: 1,
          verification: { verificationId: 'verification-1', revision: '1' },
        },
      },
      {
        type: 'subagent.started',
        subagentId: 'subagent-1',
        role: 'review',
        name: 'Review changes',
      },
      {
        type: 'subagent.completed',
        subagentId: 'subagent-1',
        summary: 'Review complete.',
        toolCallCount: 0,
        durationMs: 2_000,
      },
      { type: 'context.compaction', status: 'completed' },
      { type: 'unavailable', reason: 'redacted' },
    ];
    for (const event of events) state = apply(state, event);

    expect(blocks(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'subagent', subagentId: 'subagent-1', status: 'done' }),
        expect.objectContaining({ kind: 'text', content: 'Runtime update unavailable: redacted.' }),
      ]),
    );
  });
});
