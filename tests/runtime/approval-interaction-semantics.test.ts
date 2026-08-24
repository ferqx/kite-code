import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCurrentRuntimeEvent, type RuntimeEvent } from '@kite/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
  type RuntimeState,
} from '@kite/runtime-host/kernel-adapter';
import { projectRuntimeSessionLiveMode } from '#app/bootstrap/runtime/RuntimeSessionCoordinator';
import {
  eventsForRunCancellation,
  eventsForRuntimeAction,
  type RuntimeUserAction,
} from '#app/bootstrap/runtime/state-actions';
import { loadAgentConfig, saveInteractionMode } from '#app/config/index';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

function initialState(): RuntimeState {
  return createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'saq-semantics-test',
    userId: 'test-user',
    workspace: '/tmp/saq-semantics-test',
  });
}

function approval(command = 'printf saq') {
  return {
    scope: 'once' as const,
    cwd: '/tmp/saq-semantics-test',
    threadId: 'saq-semantics-test',
    tool: 'shell_execute',
    command,
    risk: 'execute_code' as const,
    approvalHash: `sha256:${command}`,
    summary: `Run ${command}`,
    reason: 'SAQ approval fixture',
    expectedEffects: [],
    grantOptions: ['approve_once', 'same_command'] as const,
    recommendedGrant: 'approve_once' as const,
  };
}

function addTool(state: RuntimeState, toolCallId: string): RuntimeState {
  return reduceRuntimeState(state, {
    type: 'tool.queued',
    toolCallId,
    name: 'shell_execute',
    args: { command: `printf ${toolCallId}` },
  });
}

function withStatuses(
  state: RuntimeState,
  statuses: readonly [string, RuntimeState['tools']['calls'][string]['status']][],
): RuntimeState {
  const calls = { ...state.tools.calls };
  for (const [toolCallId, status] of statuses) {
    const call = calls[toolCallId];
    if (!call) throw new Error(`missing tool fixture ${toolCallId}`);
    calls[toolCallId] = { ...call, status };
  }
  return { ...state, tools: { ...state.tools, calls } };
}

describe('SAQ-16/17 — approval interaction semantics', () => {
  test('never accepts full_access as an approval grant', () => {
    const state: RuntimeState = {
      ...addTool(initialState(), 'shell-a'),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-a',
        toolCallId: 'shell-a',
        approval: approval(),
      },
    };

    const legacyGrant = {
      type: 'approval.granted',
      interactionId: 'approval-a',
      toolCallId: 'shell-a',
      grant: 'full_access',
      receiptId: 'legacy-full-access',
      generation: 0,
    } as const;
    expect(() => assertCurrentRuntimeEvent(legacyGrant)).toThrow();

    const events = eventsForRuntimeAction(
      state,
      {
        type: 'approve',
        interactionId: 'approval-a',
        generation: 0,
        grant: 'full_access',
      } as unknown as RuntimeUserAction,
      { sandboxAvailable: true },
    );
    expect(events.some((event) => event.type === 'approval.granted')).toBe(false);
    expect(events.some((event) => event.type === 'approval.batch_released')).toBe(false);
  });

  test('Esc rejects only the focused approval; input and plan cancellation stay distinct', () => {
    let state = addTool(initialState(), 'shell-a');
    state = addTool(state, 'shell-b');
    state = {
      ...withStatuses(state, [
        ['shell-a', 'awaiting_approval'],
        ['shell-b', 'awaiting_approval'],
      ]),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-a',
        toolCallId: 'shell-a',
        approval: approval(),
      },
    };

    const approvalEsc = eventsForRuntimeAction(state, {
      type: 'reject',
      interactionId: 'approval-a',
      generation: 0,
      reason: 'focused Esc',
    });
    expect(approvalEsc.filter((event) => event.type === 'approval.rejected')).toHaveLength(1);
    expect(approvalEsc.some((event) => event.type === 'turn.aborted')).toBe(false);
    expect(
      approvalEsc.some(
        (event) => event.type === 'tool.cancelled' && event.toolCallId === 'shell-b',
      ),
    ).toBe(false);

    const inputState: RuntimeState = {
      ...state,
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'input-1',
        toolCallId: 'shell-a',
        request: { question: 'Continue?', options: [], allow_free_text: true },
      },
    };
    const inputEsc = eventsForRuntimeAction(inputState, {
      type: 'cancel',
      interactionId: 'input-1',
      reason: 'Esc input',
    });
    expect(inputEsc.map((event) => event.type)).toEqual(['user_input.cancelled', 'tool.finished']);
  });
});

describe('SAQ-18 — whole-turn Ctrl+C cancellation', () => {
  test('cancels queued, awaiting, authorized, and running children atomically', () => {
    let state = initialState();
    for (const toolCallId of ['queued', 'awaiting', 'authorized', 'running']) {
      state = addTool(state, toolCallId);
    }
    state = withStatuses(state, [
      ['queued', 'queued'],
      ['awaiting', 'awaiting_approval'],
      ['authorized', 'approved'],
      ['running', 'running'],
    ]);
    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-awaiting',
      toolCallId: 'awaiting',
      approval: approval('printf awaiting'),
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-authorized',
      toolCallId: 'authorized',
      approval: approval('printf authorized'),
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
    });
    const awaitingPending = state.pendingApprovals.get('approval-awaiting');
    const authorizedPending = state.pendingApprovals.get('approval-authorized');
    if (!awaitingPending || !authorizedPending)
      throw new Error('approval queue fixture incomplete');
    state = {
      ...state,
      activeApprovalId: 'approval-awaiting',
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-awaiting',
        toolCallId: 'awaiting',
        approval: awaitingPending.approval,
      },
      pendingApprovals: new Map([
        ['approval-awaiting', awaitingPending],
        [
          'approval-authorized',
          { ...authorizedPending, status: 'authorized_queued', state: 'authorized_queued' },
        ],
      ]),
    };

    const persisted = eventsForRunCancellation(state, 'Ctrl+C', 'user');
    const cancelledIds = new Set(
      persisted
        .filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool.cancelled' }> =>
            event.type === 'tool.cancelled',
        )
        .map((event) => event.toolCallId),
    );
    expect(cancelledIds).toEqual(new Set(['queued', 'authorized', 'running']));
    expect(persisted.some((event) => event.type === 'approval.rejected')).toBe(true);
    expect(persisted.some((event) => event.type === 'turn.aborted')).toBe(true);

    const settled = persisted.reduce(
      (current, event) =>
        reduceRuntimeState(
          current,
          normalizeCurrentToolOutcomeEvent(event, current, '2026-08-25T00:00:01.000Z'),
        ),
      state,
    );
    expect(
      (settled as RuntimeState & { pendingApprovals?: Map<unknown, unknown> }).pendingApprovals,
    ).toEqual(new Map());

    const late = reduceRuntimeState(settled, {
      type: 'approval.granted',
      interactionId: 'approval-awaiting',
      toolCallId: 'awaiting',
      grant: 'approve_once',
      receiptId: 'late-receipt',
      generation: 0,
    });
    expect(late).toEqual(settled);
  });
});

describe('SAQ-19 — permissions persistence, mode orthogonality, and identity revision', () => {
  test('persists /permissions mode without making Full a grant', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-saq-permissions-'));
    const configPath = join(directory, 'kite-code.jsonc');
    try {
      expect(saveInteractionMode('full', configPath)).toBe(true);
      expect(readFileSync(configPath, 'utf8')).toContain('"interactionMode": "full"');
      expect(
        loadAgentConfig({ configPath, providerName: 'ollama', modelName: 'fixture' })
          .interactionMode,
      ).toBe('full');

      const state = reduceRuntimeState(initialState(), {
        type: 'interaction_mode.changed',
        mode: 'full',
        source: 'user',
        changedAt: '2026-08-25T00:00:00.000Z',
      });
      expect(state.mode).toBe('full');
      expect(state).not.toHaveProperty('authorization');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('models live interaction mode as a revision, not immutable session identity', () => {
    const before = initialState();
    expect(projectRuntimeSessionLiveMode(before)).toEqual({
      interactionMode: 'accept_edits',
      interactionModeRevision: 0,
    });
    const after = reduceRuntimeState(before, {
      type: 'interaction_mode.changed',
      mode: 'full',
      source: 'user',
      changedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(projectRuntimeSessionLiveMode(after)).toEqual({
      interactionMode: 'full',
      interactionModeRevision: 1,
    });
  });
});
