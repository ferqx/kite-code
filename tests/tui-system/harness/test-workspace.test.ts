import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openState25Store4ForTestV1,
  state25Store4PathForTestV1,
} from '../../../scripts/support/runtime-storage';
import {
  createTestWorkspace,
  observePersistedCommandSession,
  observePersistedSessionIds,
  observePersistedSessionSummaries,
  observePersistedTurnEvents,
  type TestWorkspace,
} from './test-workspace';

describe('TUI persisted Runtime observers', () => {
  let workspace: TestWorkspace | undefined;

  afterEach(() => {
    workspace?.cleanup();
    workspace = undefined;
  });

  test('reports an uninitialized isolated workspace as not yet persisted', () => {
    workspace = createTestWorkspace();

    expect(observePersistedSessionIds(workspace)).toMatchObject({ status: 'not_created' });
    expect(observePersistedSessionSummaries(workspace)).toMatchObject({
      status: 'not_created',
    });
    expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
      status: 'not_created',
    });
    expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
      status: 'not_created',
    });
  });

  test('fails fast when the Runtime database path is a directory', () => {
    workspace = createTestWorkspace();
    const runtimePath = state25Store4PathForTestV1(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    mkdirSync(runtimePath);

    expect(() => observePersistedSessionIds(workspace!)).toThrow(
      'Failed to observe isolated Runtime Store',
    );
  });

  test('treats an existing database without Runtime schema as not ready', () => {
    workspace = createTestWorkspace();
    const runtimePath = state25Store4PathForTestV1(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    new Database(runtimePath).close();

    expect(observePersistedSessionIds(workspace)).toMatchObject({ status: 'initializing' });
    expect(observePersistedSessionSummaries(workspace)).toMatchObject({ status: 'initializing' });
    expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
      status: 'initializing',
    });
    expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
      status: 'initializing',
    });
  });

  test('fails fast when the Runtime database is corrupt', () => {
    workspace = createTestWorkspace();
    const runtimePath = state25Store4PathForTestV1(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    writeFileSync(runtimePath, 'not a sqlite database');

    expect(() => observePersistedSessionSummaries(workspace!)).toThrow(
      'Failed to observe isolated Runtime Store',
    );
  });

  test('reads exact persistence evidence without competing with the child writer', () => {
    workspace = createTestWorkspace();
    const runtimePath = state25Store4PathForTestV1(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    const store = openState25Store4ForTestV1(runtimePath);
    store.appendEvents('thread-a', [
      {
        type: 'user.command_invoked',
        commandId: 'command-a',
        command: '/compact marker',
      },
      {
        type: 'user.message_appended',
        messageId: 'message-a',
        content: 'turn marker',
      },
      { type: 'turn.started', turnId: 'turn-a' },
      {
        type: 'completion.blocked',
        turnId: 'turn-a',
        guardVersion: 'completion_guard_v1',
        code: 'plan_draft_pending',
        nextAction: 'submit_plan',
        planning: 'planning_draft',
        correctionAttempt: 1,
      },
      { type: 'model.requested', requestId: 'correction-request-a' },
      {
        type: 'run.completed',
        turnId: 'turn-a',
        output: 'completed',
        completionGuardVersion: 'completion_guard_v1',
      },
      { type: 'turn.completed', turnId: 'turn-a' },
    ]);
    store.setSessionName('thread-a', 'Command session');
    store.close();

    // BEGIN IMMEDIATE holds the single writer slot. A harness observer that
    // reran RuntimeStore initialization would contend here; readonly queries
    // must remain available while the real child owns that slot.
    const writer = new Database(runtimePath);
    writer.run('PRAGMA journal_mode = WAL');
    writer.run('BEGIN IMMEDIATE');
    try {
      expect(observePersistedSessionIds(workspace)).toMatchObject({
        status: 'ready',
        value: ['thread-a'],
      });
      expect(observePersistedSessionSummaries(workspace)).toMatchObject({
        status: 'ready',
        value: [{ threadId: 'thread-a', name: 'Command session' }],
      });
      expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
        status: 'ready',
        value: { threadId: 'thread-a', name: 'Command session' },
      });
      expect(observePersistedCommandSession(workspace, '/compact other')).toMatchObject({
        status: 'ready',
        value: undefined,
      });
      expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
        status: 'ready',
        value: {
          threadId: 'thread-a',
          turnId: 'turn-a',
          events: [
            { type: 'turn.started', turnId: 'turn-a' },
            {
              type: 'completion.blocked',
              turnId: 'turn-a',
              code: 'plan_draft_pending',
              correctionAttempt: 1,
            },
            { type: 'model.requested', requestId: 'correction-request-a' },
            { type: 'run.completed', turnId: 'turn-a' },
            { type: 'turn.completed', turnId: 'turn-a' },
          ],
        },
      });
    } finally {
      writer.run('ROLLBACK');
      writer.close();
    }
  });

  test('matches RuntimeStore name fallback when the first user message is empty', () => {
    workspace = createTestWorkspace();
    const runtimePath = state25Store4PathForTestV1(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    const store = openState25Store4ForTestV1(runtimePath);
    store.appendEvents('thread-empty', [
      {
        type: 'user.message_appended',
        messageId: 'message-empty',
        content: '',
      },
      {
        type: 'user.command_invoked',
        commandId: 'command-empty',
        command: '/compact empty',
      },
    ]);
    try {
      expect(observePersistedSessionSummaries(workspace)).toMatchObject({
        status: 'ready',
        value: [{ threadId: 'thread-empty', name: 'thread-empty' }],
      });
      expect(observePersistedCommandSession(workspace, '/compact empty')).toMatchObject({
        status: 'ready',
        value: { threadId: 'thread-empty', name: 'thread-empty' },
      });
    } finally {
      store.close();
    }
  });
});
