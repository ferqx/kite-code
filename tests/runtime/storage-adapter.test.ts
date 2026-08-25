import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentState,
  assertAgentStateInvariants,
  createInitialAgentState,
  decodeCurrentRuntimeEventJson,
  type RuntimeEvent,
  reduceAgentState,
} from '@kite/agent-kernel';
import { createRuntimeHostStateStorageBinding } from '@kite/runtime-host';
import type { RuntimeSnapshotCodec } from '@kite/runtime-host/storage';
import {
  createStateStorageForTest,
  withTestStateProjectIdentity,
} from '../../scripts/support/runtime-storage';

const state = createRuntimeHostStateStorageBinding();
const codec = state.codec as RuntimeSnapshotCodec<RuntimeEvent, AgentState>;

function createAdapter(databasePath: string, sessionId: string) {
  return createStateStorageForTest<RuntimeEvent, AgentState>({
    databasePath,
    codec,
    sessionId,
  });
}

describe('SQLite RuntimeStorage adapter', () => {
  test('strictly reopens an existing current session without schema or marker drift', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-runtime-adapter-'));
    const databasePath = join(root, 'runtime.db');
    const sessionId = 'state-session';
    try {
      const initial = createInitialAgentState({
        threadId: sessionId,
        userId: 'user',
        workspace: '/workspace',
        turnId: 'turn-1',
        recoveryIdentityKey: 'a'.repeat(64),
      });
      const event = decodeCurrentRuntimeEventJson(
        JSON.stringify({
          type: 'user.message_appended',
          messageId: 'state-message',
          content: 'preserve me',
          createdAt: '2026-08-20T00:00:00.000Z',
        }),
      );
      const nextState = withTestStateProjectIdentity<AgentState>({
        ...reduceAgentState(initial, event),
        revision: 1,
      });
      assertAgentStateInvariants(initial);
      assertAgentStateInvariants(nextState);

      const first = createAdapter(databasePath, sessionId);
      first.transactions.commitDecision({
        sessionId,
        events: [event],
        snapshot: nextState,
        metadata: [{ eventId: 'state-event', revision: 1 }],
      });
      first.close();

      const adapter = createAdapter(databasePath, sessionId);
      expect(adapter.adapterId).toBe('sqlite');
      expect(adapter.stateSchemaVersion).toBe(27);
      expect(adapter.storeSchemaVersion).toBe(5);
      expect(adapter.formatEpoch).toBe('kite-runtime-saq-v1-2026-08-25');
      expect(adapter.sessions.loadEventsStrict(sessionId)).toHaveLength(1);
      expect(adapter.sessions.loadSnapshot<AgentState>(sessionId)?.revision).toBe(1);
      adapter.close();

      const database = new Database(databasePath);
      try {
        const markers = new Map(
          database
            .query<{ key: string; value: string }, []>(
              'select key, value from runtime_store_meta order by key',
            )
            .all()
            .map((entry) => [entry.key, entry.value]),
        );
        expect(markers).toEqual(
          new Map([
            ['format_version', '5'],
            ['runtime_format_epoch', 'kite-runtime-saq-v1-2026-08-25'],
          ]),
        );
        expect(
          database
            .query<{ count: number }, []>(
              "select count(*) as count from sqlite_master where type = 'table' and name not like 'sqlite_%'",
            )
            .get()?.count,
        ).toBe(7);
        expect(
          database
            .query<{ count: number }, []>(
              "select count(*) as count from sqlite_master where type = 'index' and sql is not null",
            )
            .get()?.count,
        ).toBe(2);
      } finally {
        database.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
