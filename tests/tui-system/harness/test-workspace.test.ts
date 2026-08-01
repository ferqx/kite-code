import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeStore, runtimeStorePathFor } from '@/core/runtime/store';
import {
  createTestWorkspace,
  persistedCommandSession,
  persistedSessionIds,
  persistedSessionSummaries,
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

    expect(persistedSessionIds(workspace)).toEqual([]);
    expect(persistedSessionSummaries(workspace)).toEqual([]);
    expect(persistedCommandSession(workspace, '/compact marker')).toBeUndefined();
  });

  test('treats a temporarily unopenable Runtime path as not ready for bounded polling', () => {
    workspace = createTestWorkspace();
    const runtimePath = runtimeStorePathFor(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    mkdirSync(runtimePath);

    expect(persistedSessionIds(workspace)).toEqual([]);
    expect(persistedSessionSummaries(workspace)).toEqual([]);
    expect(persistedCommandSession(workspace, '/compact marker')).toBeUndefined();
  });

  test('reads exact persistence evidence without competing with the child writer', () => {
    workspace = createTestWorkspace();
    const runtimePath = runtimeStorePathFor(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    const store = createRuntimeStore(runtimePath);
    store.appendEvents('thread-a', [
      {
        type: 'user.command_invoked',
        commandId: 'command-a',
        command: '/compact marker',
      },
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
      expect(persistedSessionIds(workspace)).toEqual(['thread-a']);
      expect(persistedSessionSummaries(workspace)).toEqual([
        { threadId: 'thread-a', name: 'Command session' },
      ]);
      expect(persistedCommandSession(workspace, '/compact marker')).toEqual({
        threadId: 'thread-a',
        name: 'Command session',
      });
      expect(persistedCommandSession(workspace, '/compact other')).toBeUndefined();
    } finally {
      writer.run('ROLLBACK');
      writer.close();
    }
  });

  test('matches RuntimeStore name fallback when the first user message is empty', () => {
    workspace = createTestWorkspace();
    const runtimePath = runtimeStorePathFor(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    const store = createRuntimeStore(runtimePath);
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
      expect(persistedSessionSummaries(workspace)).toEqual([
        { threadId: 'thread-empty', name: 'thread-empty' },
      ]);
      expect(persistedCommandSession(workspace, '/compact empty')).toEqual({
        threadId: 'thread-empty',
        name: 'thread-empty',
      });
    } finally {
      store.close();
    }
  });
});
