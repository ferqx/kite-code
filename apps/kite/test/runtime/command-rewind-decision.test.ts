import { describe, expect, test } from 'bun:test';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { StateRuntimeSession } from '@kite-ai/runtime-host/kernel-adapter';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeCommandCommitEvidence } from '@kite-ai/runtime-host/storage';
import {
  assertPrecommittedRewind,
  commitRewindCommand,
  planRewindCommand,
} from '#app/bootstrap/runtime/command-rewind-decision';
import type { RuntimeEvent, RuntimeState } from '#app/bootstrap/runtime/state-runtime';

const sourceSessionId = 'rewind-source';

function command(scope: 'conversation_only' | 'conversation_and_workspace' | 'code_only') {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    type: 'rewind_session' as const,
    commandId: 'rewind-command-1',
    sessionId: sourceSessionId,
    expectedRevision: 0,
    checkpointId: 'checkpoint-1',
    scope,
  };
}

function evidence(): RuntimeCommandCommitEvidence {
  return {
    scopeSessionId: sourceSessionId,
    commandId: 'rewind-command-1',
    requestDigest: 'a'.repeat(64),
    targetSessionId: sourceSessionId,
    committedAt: 1,
  };
}

function initialState(): RuntimeState {
  return createRuntimeHostStateInitialState({
    threadId: sourceSessionId,
    userId: 'user',
    workspace: '/workspace',
    recoveryIdentityKey: '0'.repeat(64),
  }) as RuntimeState;
}

describe('rewind command decision', () => {
  test('plans a deterministic intent without a write or effect', () => {
    const state = initialState();
    const first = planRewindCommand(state, command('conversation_and_workspace'));
    const second = planRewindCommand(state, command('conversation_and_workspace'));

    expect(first).toEqual(second);
    expect(first.events).toEqual([
      expect.objectContaining({
        type: 'session.rewind_requested',
        sourceSessionId,
        checkpointId: 'checkpoint-1',
        scope: 'conversation_and_workspace',
      }),
    ]);
    expect(first.descriptor.targetSessionId).not.toBe(sourceSessionId);
    expect(first.descriptor.targetSessionId).toMatch(/^rewind_session_[a-f0-9]{32}$/u);
  });

  test('keeps code-only target and receipt on the source session', () => {
    const state = initialState();
    const writes: RuntimeEvent[][] = [];
    const session = {
      sessionId: sourceSessionId,
      getState: () => state,
      commitCommandBatch: (events: readonly RuntimeEvent[]) => {
        writes.push([...events]);
        return {
          receipt: {
            ...evidence(),
            originalReceiptJson: '{}',
            committedRevision: 1,
          },
          events,
        };
      },
    } as unknown as StateRuntimeSession;

    const committed = commitRewindCommand(session, command('code_only'), evidence());

    expect(writes).toHaveLength(1);
    expect(committed.receipt.targetSessionId).toBe(sourceSessionId);
    expect(committed.events[0]).toMatchObject({ targetSessionId: sourceSessionId });
    expect(assertPrecommittedRewind({ ...state, revision: 1 }, committed.descriptor)).toEqual(
      committed.events[0],
    );
  });

  test('rejects a receipt that tries to bind the fork target instead of its source', () => {
    const state = initialState();
    const session = { sessionId: sourceSessionId, getState: () => state } as StateRuntimeSession;
    expect(() =>
      commitRewindCommand(session, command('conversation_only'), {
        ...evidence(),
        targetSessionId: 'rewind_session_wrong',
      }),
    ).toThrow('receipt target must remain the source session');
  });
});
