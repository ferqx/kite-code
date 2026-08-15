import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@/core/runtime/events';
import { assertRuntimeStateInvariants, RuntimeInvariantError } from '@/core/runtime/invariants';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import { decideNextEffect } from '@/core/runtime/scheduler';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

describe('Runtime stability invariants', () => {
  test('rejects duplicate tool references and terminal scheduled tools', () => {
    const state = createInitialRuntimeState({ threadId: 'invariant', userId: 'u', workspace: '/' });
    state.tools.calls.read = {
      toolCallId: 'read',
      modelMessageId: '',
      name: 'read_file',
      args: {},
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('read');

    expect(() => assertRuntimeStateInvariants(state)).toThrow(RuntimeInvariantError);
  });

  test('kernel applies the same event identity only once', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({ threadId: 'dedupe', userId: 'u', workspace: '/' }),
      interactionMode: 'accept_edits',
    });
    const event: RuntimeEvent = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'hello',
    };

    expect(kernel.processEvent(event).status).toBe('applied');
    expect(kernel.processEvent(event).status).toBe('duplicate');
    expect(kernel.getState().revision).toBe(1);
    const stored = store.loadEventsStrict('dedupe');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event_id).toBeTruthy();
    expect(stored[0]?.revision).toBe(1);
    expect(store.loadSnapshotRecord('dedupe')?.metadata.stateRevision).toBe(1);
    kernel.close();
  });

  test('rejects stale effect results after a newer event commits', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'stale-effect',
        userId: 'u',
        workspace: '/',
      }),
      interactionMode: 'accept_edits',
    });
    const lease = kernel.beginEffect({ type: 'call_model' });
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'newer-message',
      content: 'newer state wins',
    });

    expect(
      kernel.applyEffectResult(lease, [
        { type: 'model.responded', messageId: 'stale', text: 'stale response' },
      ]),
    ).toBe(false);
    expect(kernel.getState().transcript.final).toBeUndefined();
    kernel.close();
  });

  test('allows only one runner lease at a time', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'single-flight',
        userId: 'u',
        workspace: '/',
      }),
      interactionMode: 'accept_edits',
    });
    const first = kernel.acquireRunner();
    expect(first).toBeTruthy();
    expect(kernel.acquireRunner()).toBeNull();
    kernel.releaseRunner(first!);
    expect(kernel.acquireRunner()).toBeTruthy();
    kernel.close();
  });

  test('does not schedule a tool owned by a completed task', () => {
    const state = createInitialRuntimeState({
      threadId: 'terminal-task-tool',
      userId: 'u',
      workspace: '/',
    });
    state.tools.calls.old = {
      toolCallId: 'old',
      taskId: 'completed-task',
      modelMessageId: 'model',
      name: 'write_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('old');
    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
  });

  test('returns telemetry for a stale action without throwing a runtime error', () => {
    const initial = createInitialRuntimeState({
      threadId: 'stale-action',
      userId: 'u',
      workspace: '/',
    });
    initial.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {},
      status: 'awaiting_user_input',
      createdAtTurnId: initial.turn.turnId,
    };
    initial.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'active-interaction',
      toolCallId: 'ask',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: initial,
      interactionMode: 'accept_edits',
    });

    const result = kernel.applyAction({ type: 'cancel', interactionId: 'stale-interaction' });
    expect(result.status).toBe('stale');
    if (result.status !== 'applied') {
      expect(result.telemetry.type).toBe('runtime.action_ignored');
    }
    kernel.close();
  });

  test('replays durable events after the snapshot position during recovery', () => {
    const directory = mkdtempSync(join('/tmp', 'kite-runtime-tail-'));
    const storePath = join(directory, 'runtime.db');
    try {
      const first = createAgentKernel({
        threadId: 'tail-recovery',
        userId: 'u',
        workspace: '/',
        storePath,
      });
      first.processEvent({
        type: 'user.message_appended',
        messageId: 'before-snapshot',
        content: 'before',
      });
      first.close();

      const store = createRuntimeStore(storePath);
      store.appendEvents(
        'tail-recovery',
        [
          {
            type: 'user.message_appended',
            messageId: 'after-snapshot',
            content: 'after',
          },
        ],
        [
          {
            eventId: 'tail-event',
            revision: 2,
            occurredAt: new Date().toISOString(),
          },
        ],
      );
      store.close();

      const restored = createAgentKernel({
        threadId: 'tail-recovery',
        userId: 'u',
        workspace: '/',
        storePath,
      });
      expect(restored.getState().revision).toBe(2);
      expect(restored.getState().transcript.messages).toHaveLength(2);
      expect(restored.getState().recoveryState).toEqual({ kind: 'normal' });
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('isolates corrupted event logs and blocks execution', async () => {
    const directory = mkdtempSync(join('/tmp', 'kite-runtime-corrupt-event-'));
    const storePath = join(directory, 'runtime.db');
    try {
      const store = createRuntimeStore(storePath);
      store.appendEvents(
        'corrupt-event',
        [
          {
            type: 'user.message_appended',
            messageId: 'corrupt-me',
            content: 'hello',
          },
        ],
        [
          {
            eventId: 'corrupt-event-id',
            revision: 1,
            occurredAt: new Date().toISOString(),
          },
        ],
      );
      store.close();

      const database = new Database(storePath);
      database.run("UPDATE runtime_events SET event_json = '{' WHERE thread_id = 'corrupt-event'");
      database.close();

      const reopened = createRuntimeStore(storePath);
      expect(() => reopened.loadEventsStrict('corrupt-event')).toThrow();
      reopened.close();

      const kernel = createAgentKernel({
        threadId: 'corrupt-event',
        userId: 'u',
        workspace: '/',
        storePath,
      });
      expect(kernel.getState().recoveryState.kind).toBe('corrupted');
      await expect(kernel.run(async () => [])).resolves.toMatchObject({ type: 'recovery_blocked' });
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects a snapshot whose checksum no longer matches', () => {
    const directory = mkdtempSync(join('/tmp', 'kite-runtime-corrupt-snapshot-'));
    const storePath = join(directory, 'runtime.db');
    try {
      const kernel = createAgentKernel({
        threadId: 'corrupt-snapshot',
        userId: 'u',
        workspace: '/',
        storePath,
      });
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: 'snapshot-message',
        content: 'persisted',
      });
      const corruptedPayload = {
        ...structuredClone(kernel.getState()),
        transcript: { corrupted: true },
      };
      kernel.close();

      const database = new Database(storePath);
      database
        .query('UPDATE runtime_snapshots SET state_json = ? WHERE thread_id = ?')
        .run(JSON.stringify(corruptedPayload), 'corrupt-snapshot');
      database.close();

      const store = createRuntimeStore(storePath);
      expect(store.loadSnapshotRecord('corrupt-snapshot')).toBeNull();
      store.close();

      const restored = createAgentKernel({
        threadId: 'corrupt-snapshot',
        userId: 'u',
        workspace: '/',
        storePath,
      });
      expect(restored.getState().recoveryState.kind).toBe('corrupted');
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
