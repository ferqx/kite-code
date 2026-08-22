import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite/agent-kernel';
import type { ToolApprovalPayload } from '@kite/runtime-contract';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import type { SessionData } from '../apps/kite/src/bootstrap/runtime/session-persistence';
import { sessionDataToUI, TUI_REPLAY_CANCELLED_TEXT } from '../apps/kite/src/tui/replay-blocks';
import { CURRENT_TEST_PLAN_IDENTITY, CURRENT_TEST_PLAN_REVIEW_FACTS } from './helpers/current-plan';
import { currentRuntimeEvents } from './helpers/current-runtime-event';

const approval = {
  scope: 'once',
  cwd: '/tmp',
  threadId: 'thread',
  tool: 'shell_execute',
  command: 'echo ok',
  risk: 'execute_code',
  approvalHash: 'hash',
  summary: 'Run echo ok',
  reason: 'approval required',
  expectedEffects: [],
  grantOptions: ['approve_once'],
  recommendedGrant: 'approve_once',
} as unknown as ToolApprovalPayload;

function data(
  runtimeEvents: RuntimeEvent[],
  interrupt: SessionData['interrupt'] = null,
): SessionData {
  return {
    threadId: 'thread',
    messages: [],
    runtimeEvents: currentRuntimeEvents(runtimeEvents),
    interrupt,
    modelProvider: 'test',
    modelName: 'test',
    thinkingLevel: null,
    plan: null,
    planAuthMode: null,
  };
}

function cards(result: ReturnType<typeof sessionDataToUI>) {
  return result.blocks.filter(
    (block): block is Extract<(typeof result.blocks)[number], { kind: 'tool_card' }> =>
      block.kind === 'tool_card',
  );
}

describe('TUI replay interaction recovery', () => {
  test('does not replay a pending tool approval and projects local cancellation', () => {
    const result = sessionDataToUI(
      data(
        [
          {
            type: 'tool.queued',
            toolCallId: 'tool-1',
            name: 'shell_execute',
            args: { command: 'echo ok' },
          },
          {
            type: 'approval.requested',
            interactionId: 'approval-1',
            toolCallId: 'tool-1',
            approval,
          },
        ],
        { kind: 'approval', callId: 'tool-1' },
      ),
    );

    expect(result.interrupt).toBeNull();
    expect(result.recoveredPendingInteraction).toBe(true);
    expect(result.pendingToolCalls).toEqual({});
    expect(cards(result)).toContainEqual(
      expect.objectContaining({
        callId: 'tool-1',
        status: 'cancelled',
        summary: TUI_REPLAY_CANCELLED_TEXT,
      }),
    );
  });

  test('does not cancel a tool that crossed the started boundary', () => {
    const result = sessionDataToUI(
      data([
        {
          type: 'tool.queued',
          toolCallId: 'tool-1',
          name: 'shell_execute',
          args: { command: 'echo ok' },
        },
        { type: 'tool.started', toolCallId: 'tool-1' },
        { type: 'approval.requested', interactionId: 'approval-1', toolCallId: 'tool-1', approval },
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(cards(result)).toContainEqual(
      expect.objectContaining({ callId: 'tool-1', status: 'running' }),
    );
    expect(cards(result).find((card) => card.callId === 'tool-1')?.summary).not.toBe(
      TUI_REPLAY_CANCELLED_TEXT,
    );
  });

  test('does not turn an unfinished side-effect invocation into a user cancellation', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'external-write',
        name: 'mcp_publish',
        args: { title: 'Release' },
      },
      {
        type: 'capability.invocation_recorded',
        invocationId: 'publish-1',
        toolCallId: 'external-write',
        capabilityId: 'mcp:github/publish',
        capabilityRevision: 'r1',
        argumentsDigest: 'args',
        authorizationDigest: 'auth',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        recordedAt: '2026-08-08T00:00:00.000Z',
      },
      {
        type: 'approval.requested',
        interactionId: 'approval-external-write',
        toolCallId: 'external-write',
        approval,
      },
    ];

    const result = sessionDataToUI(data(events));

    expect(result.interrupt).toBeNull();
    expect(result.pendingToolCalls).toEqual({});
    expect(cards(result).some((card) => card.summary === TUI_REPLAY_CANCELLED_TEXT)).toBe(false);
    // Replay owns no Runtime event and leaves the canonical fact untouched for
    // the next client to recover as an unknown invocation.
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ type: 'capability.invocation_recorded' });
  });

  test('recovers ask_user without leaving a pending input prompt', () => {
    const result = sessionDataToUI(
      data([
        {
          type: 'tool.queued',
          toolCallId: 'ask-1',
          name: 'ask_user',
          args: { question: 'Continue?' },
        },
        {
          type: 'user_input.requested',
          interactionId: 'input-1',
          toolCallId: 'ask-1',
          request: { question: 'Continue?', options: [], allow_free_text: true },
        },
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(result.blocks).toContainEqual(
      expect.objectContaining({ kind: 'question', resolved: TUI_REPLAY_CANCELLED_TEXT }),
    );
    expect(cards(result)).toContainEqual(
      expect.objectContaining({
        callId: 'ask-1',
        status: 'cancelled',
        summary: TUI_REPLAY_CANCELLED_TEXT,
      }),
    );
  });

  test('clears pending plan review and child-agent approval projection', () => {
    const result = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'plan-1', name: 'write_plan', args: { title: 'Plan' } },
        {
          type: 'plan.review_requested',
          interactionId: 'plan-interaction',
          toolCallId: 'plan-1',
          ...CURRENT_TEST_PLAN_REVIEW_FACTS,
          plan: { name: 'Plan', description: 'Do it', status: 'pending', steps: [] },
          planSummary: 'Do it',
          planId: 'plan-id',
          version: 1,
          structuralDigest: 'digest',
        },
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(result.blocks.some((block) => block.kind === 'subagent' && block.awaitingApproval)).toBe(
      false,
    );
  });

  test('restores the approved plan execution mode for the Footer', () => {
    const plan = { name: 'Plan', description: 'Do it', status: 'pending' as const, steps: [] };
    const result = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'plan-1', name: 'write_plan', args: {} },
        {
          type: 'plan.review_requested',
          interactionId: 'plan-interaction',
          toolCallId: 'plan-1',
          ...CURRENT_TEST_PLAN_REVIEW_FACTS,
          plan,
          planSummary: plan.description,
        },
        {
          type: 'plan.approved',
          interactionId: 'plan-interaction',
          toolCallId: 'plan-1',
          ...CURRENT_TEST_PLAN_IDENTITY,
          executionMode: 'auto',
        },
      ]),
    );

    expect(result.interactionMode).toBe('auto');
  });

  test('restores a later explicit interaction mode over the approved plan mode', () => {
    const plan = { name: 'Plan', description: 'Do it', status: 'pending' as const, steps: [] };
    const result = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'plan-1', name: 'write_plan', args: {} },
        {
          type: 'plan.review_requested',
          interactionId: 'plan-interaction',
          toolCallId: 'plan-1',
          ...CURRENT_TEST_PLAN_REVIEW_FACTS,
          plan,
          planSummary: plan.description,
        },
        {
          type: 'plan.approved',
          interactionId: 'plan-interaction',
          toolCallId: 'plan-1',
          ...CURRENT_TEST_PLAN_IDENTITY,
          executionMode: 'auto',
        },
        {
          type: 'interaction_mode.changed',
          mode: 'accept_edits',
          source: 'user',
          changedAt: '2026-08-14T12:00:00.000Z',
        },
      ]),
    );

    expect(result.interactionMode).toBe('accept_edits');
  });

  test('recovers an interrupted auto_review without creating human approval UI', () => {
    const result = sessionDataToUI(
      data([
        {
          type: 'tool.queued',
          toolCallId: 'tool-2',
          name: 'shell_execute',
          args: { command: 'echo ok' },
        },
        {
          type: 'auto_review.requested',
          reviewId: 'review-1',
          toolCallId: 'tool-2',
          toolName: 'shell_execute',
          reason: 'automatic review',
          approval,
        },
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(cards(result)).toContainEqual(
      expect.objectContaining({
        callId: 'tool-2',
        status: 'cancelled',
        summary: TUI_REPLAY_CANCELLED_TEXT,
      }),
    );
  });

  test('conservatively recovers an unclassified legacy auto_review failure', () => {
    const result = sessionDataToUI(
      data([
        {
          type: 'tool.queued',
          toolCallId: 'tool-legacy-review',
          name: 'shell_execute',
          args: { command: 'echo ok' },
        },
        {
          type: 'auto_review.requested',
          reviewId: 'legacy-review',
          toolCallId: 'tool-legacy-review',
          toolName: 'shell_execute',
          reason: 'automatic review',
          approval,
        },
        {
          type: 'auto_review.completed',
          reviewId: 'legacy-review',
          toolCallId: 'tool-legacy-review',
          result: { ok: false, approved: false, reason: 'legacy provider failure' },
        } as unknown as RuntimeEvent,
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(result.recoveredPendingInteraction).toBe(true);
    expect(cards(result)).toContainEqual(
      expect.objectContaining({
        callId: 'tool-legacy-review',
        status: 'cancelled',
        summary: TUI_REPLAY_CANCELLED_TEXT,
      }),
    );
  });

  test('does not revive a durably approved or rejected approval', () => {
    const granted = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'approved-tool', name: 'shell_execute', args: {} },
        {
          type: 'approval.requested',
          interactionId: 'approval-granted',
          toolCallId: 'approved-tool',
          approval,
        },
        {
          type: 'approval.granted',
          interactionId: 'approval-granted',
          toolCallId: 'approved-tool',
          grant: 'approve_once',
        },
      ]),
    );
    const rejected = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'rejected-tool', name: 'shell_execute', args: {} },
        {
          type: 'approval.requested',
          interactionId: 'approval-rejected',
          toolCallId: 'rejected-tool',
          approval,
        },
        {
          type: 'approval.rejected',
          interactionId: 'approval-rejected',
          toolCallId: 'rejected-tool',
          reason: 'Tool approval cancelled by user.',
        },
      ]),
    );

    expect(granted.interrupt).toBeNull();
    expect(granted.recoveredPendingInteraction).toBe(false);
    expect(cards(granted).some((card) => card.summary === TUI_REPLAY_CANCELLED_TEXT)).toBe(false);
    expect(rejected.interrupt).toBeNull();
    expect(cards(rejected)).toContainEqual(
      expect.objectContaining({
        callId: 'rejected-tool',
        status: 'cancelled',
        summary: 'Tool approval cancelled by user.',
      }),
    );
  });

  test('does not fork a completed session when tool start clears a replay-only approval', () => {
    const result = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'started-tool', name: 'shell_execute', args: {} },
        {
          type: 'approval.requested',
          interactionId: 'approval-started',
          toolCallId: 'started-tool',
          approval,
        },
        { type: 'tool.started', toolCallId: 'started-tool' },
        {
          type: 'tool.finished',
          toolCallId: 'started-tool',
          name: 'shell_execute',
          result: { ok: true, command: 'echo done', exitCode: 0, stdout: 'done', stderr: '' },
        },
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(result.recoveredPendingInteraction).toBe(false);
    expect(cards(result).some((card) => card.summary === TUI_REPLAY_CANCELLED_TEXT)).toBe(false);
  });

  test('renders a later rejected approval after an earlier approval crossed the started boundary', () => {
    const result = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'started-tool', name: 'shell_execute', args: {} },
        {
          type: 'approval.requested',
          interactionId: 'stale-approval',
          toolCallId: 'started-tool',
          approval: { ...approval, callId: 'started-tool' },
        },
        { type: 'tool.started', toolCallId: 'started-tool' },
        { type: 'tool.queued', toolCallId: 'rejected-tool', name: 'shell_execute', args: {} },
        {
          type: 'approval.requested',
          interactionId: 'rejected-approval',
          toolCallId: 'rejected-tool',
          approval: { ...approval, callId: 'rejected-tool' },
        },
        {
          type: 'approval.rejected',
          interactionId: 'rejected-approval',
          toolCallId: 'rejected-tool',
          reason: 'Tool approval cancelled by user.',
        },
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(cards(result)).toContainEqual(
      expect.objectContaining({
        callId: 'rejected-tool',
        status: 'cancelled',
        summary: 'Tool approval cancelled by user.',
      }),
    );
  });

  test('renders a later rejected approval when an older journal jumps straight to tool completion', () => {
    const result = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'finished-tool', name: 'shell_execute', args: {} },
        {
          type: 'approval.requested',
          interactionId: 'stale-completed-approval',
          toolCallId: 'finished-tool',
          approval: { ...approval, callId: 'finished-tool' },
        },
        {
          type: 'tool.finished',
          toolCallId: 'finished-tool',
          name: 'shell_execute',
          result: { ok: true, command: 'echo done', exitCode: 0, stdout: 'done', stderr: '' },
        },
        { type: 'tool.queued', toolCallId: 'rejected-tool', name: 'shell_execute', args: {} },
        {
          type: 'approval.requested',
          interactionId: 'rejected-approval',
          toolCallId: 'rejected-tool',
          approval: { ...approval, callId: 'rejected-tool' },
        },
        {
          type: 'approval.rejected',
          interactionId: 'rejected-approval',
          toolCallId: 'rejected-tool',
          reason: 'Tool approval cancelled by user.',
        },
      ]),
    );

    expect(result.interrupt).toBeNull();
    expect(cards(result)).toContainEqual(
      expect.objectContaining({
        callId: 'rejected-tool',
        status: 'cancelled',
        summary: 'Tool approval cancelled by user.',
      }),
    );
  });

  test('does not render pending provider action or provider admission interactions', () => {
    const providerAction = sessionDataToUI(
      data([
        { type: 'tool.queued', toolCallId: 'mcp-1', name: 'mcp_publish', args: {} },
        {
          type: 'tool.failed',
          toolCallId: 'mcp-1',
          failure: classifyFailure('provider_unavailable', 'Authentication expired.'),
        },
        {
          type: 'provider.action_required',
          interactionId: 'provider-action-1',
          providerId: 'github',
          action: 'login',
          originatingToolCallId: 'mcp-1',
        },
      ]),
    );
    const providerAdmission = sessionDataToUI(
      data([
        {
          type: 'provider.admission_required',
          interactionId: 'provider-admission-1',
          providerId: 'github',
          source: 'user',
          providerStatus: 'failed',
          retryable: true,
        },
      ]),
    );

    expect(providerAction.interrupt).toBeNull();
    expect(providerAdmission.interrupt).toBeNull();
  });
});
