import { describe, expect, test } from 'bun:test';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import {
  createRuntimeHostStateInitialState,
  type StateRuntimeSession,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  createRuntimeStoredCommandReceipt,
  type RuntimeCommandCommitEvidence,
} from '@kite-ai/runtime-host/storage';
import { commitClearSessionCommandGrantsCommand } from '../../src/bootstrap/runtime/command-control-decision';
import type { RuntimeEvent, RuntimeState } from '../../src/bootstrap/runtime/state-runtime';

function evidence(): RuntimeCommandCommitEvidence {
  return {
    scopeSessionId: 'clear-grants-session',
    commandId: 'clear-grants-command',
    requestDigest: 'a'.repeat(64),
    targetSessionId: 'clear-grants-session',
    committedAt: 1_700_000_000_000,
  };
}

function command(expectedRevision: number) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'clear-grants-command',
    type: 'clear_session_command_grants' as const,
    sessionId: 'clear-grants-session',
    expectedRevision,
  };
}

function state(withGrant: boolean): RuntimeState {
  const current = createRuntimeHostStateInitialState({
    threadId: 'clear-grants-session',
    userId: 'test-user',
    workspace: '/workspace',
    recoveryIdentityKey: 'b'.repeat(64),
  });
  if (withGrant) {
    (current as unknown as { sessionCommandGrants: Map<string, unknown> }).sessionCommandGrants =
      new Map([['fixture-grant', {}]]);
  }
  return current;
}

function sessionFixture(current: RuntimeState, fail = false) {
  const batches: RuntimeEvent[][] = [];
  let snapshots = 0;
  const receipt = (revision: number) => createRuntimeStoredCommandReceipt(evidence(), revision);
  const session = {
    getState: () => current,
    commitCommandBatch: (events: readonly RuntimeEvent[]) => {
      if (fail) throw new Error('injected clear-grants transaction failure');
      batches.push([...events]);
      return { receipt: receipt(current.revision + events.length), events };
    },
    commitCommandSnapshot: () => {
      if (fail) throw new Error('injected clear-grants transaction failure');
      snapshots++;
      return receipt(current.revision);
    },
  } as unknown as StateRuntimeSession;
  return { session, batches, snapshots: () => snapshots };
}

describe('clear Session command grants decision', () => {
  test('commits the clear event and scoped receipt through one State transaction', () => {
    const current = state(true);
    const fixture = sessionFixture(current);

    const committed = commitClearSessionCommandGrantsCommand(
      fixture.session,
      command(current.revision),
      evidence(),
    );

    expect(fixture.batches).toHaveLength(1);
    expect(fixture.batches[0]).toEqual([...committed.events]);
    expect(committed.events).toEqual([
      {
        type: 'approval.session_grants_cleared',
        sessionId: 'clear-grants-session',
        sessionRevision: current.revision,
        generation: current.approvalGeneration + 1,
        clearedAt: '2023-11-14T22:13:20.000Z',
      },
    ]);
    expect(committed.receipt.scopeSessionId).toBe('clear-grants-session');
    expect(fixture.snapshots()).toBe(0);
  });

  test('receipts an empty clear without inventing a generation event', () => {
    const current = state(false);
    const fixture = sessionFixture(current);

    const committed = commitClearSessionCommandGrantsCommand(
      fixture.session,
      command(current.revision),
      evidence(),
    );

    expect(committed.events).toEqual([]);
    expect(fixture.batches).toEqual([]);
    expect(fixture.snapshots()).toBe(1);
    expect(committed.receipt.committedRevision).toBe(current.revision);
  });

  test('rejects a stale revision and leaves a failed transaction retryable', () => {
    const current = state(true);
    const stale = sessionFixture(current);
    expect(() =>
      commitClearSessionCommandGrantsCommand(
        stale.session,
        command(current.revision + 1),
        evidence(),
      ),
    ).toThrow('session or revision does not match');
    expect(stale.batches).toEqual([]);

    const failed = sessionFixture(current, true);
    expect(() =>
      commitClearSessionCommandGrantsCommand(failed.session, command(current.revision), evidence()),
    ).toThrow('injected clear-grants transaction failure');
    expect(failed.batches).toEqual([]);
  });
});
