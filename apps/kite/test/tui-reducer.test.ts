import { describe, expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { createInitialState } from '../src/tui/App';
import { eventReducer } from '../src/tui/reducers';
import type { OutputBlock, TuiState } from '../src/tui/types';

function apply(state: TuiState, event: RuntimeClientEvent): TuiState {
  return eventReducer(state, { type: 'RUNTIME_EVENT', event });
}

function blocks(state: TuiState) {
  return state.turns.flatMap((turn) => turn.blocks);
}

describe('TUI RuntimeClientEvent reducer', () => {
  test('renders safe user, model, tool, and terminal facts', () => {
    let state = createInitialState();
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

    expect(state.running).toBe(false);
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

  test('uses only closed approval fields and does not duplicate model terminal text', () => {
    let state = apply(createInitialState(), {
      type: 'model.responded',
      requestId: 'request-1',
      messageId: 'message-1',
      toolCallCount: 0,
      summary: 'Completed safely.',
    });
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
    expect(state.running).toBe(false);
    expect(state.exited).toBe(true);
  });

  test('projects content-free lifecycle and failure facts', () => {
    let state = apply(createInitialState(), { type: 'planning.entered', taskId: 'task-1' });
    state = apply(state, { type: 'interaction_mode.changed', mode: 'full' });
    state = apply(state, {
      type: 'reasoning.activity',
      requestId: 'request-reasoning-1',
      state: 'streaming',
      segmentId: 'reasoning-1',
      text: 'Thinking.',
    });
    state = apply(state, {
      type: 'run.failure',
      runId: 'run-1',
      code: 'provider_unavailable',
      retryable: true,
      recoveryEntry: 'retry',
    });

    expect(state.status.phase).toBe('planning');
    expect(state.interactionMode).toBe('full');
    expect(state.currentModelReasoningStreamed).toBe(true);
    expect(state.running).toBe(false);
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
      { type: 'subagent.completed', subagentId: 'subagent-1', summary: 'Review complete.' },
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
