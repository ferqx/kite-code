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
import { createRuntimeHostState26StorageBindingV1 } from '@kite/runtime-host';
import type { RuntimeSnapshotCodecV1 } from '@kite/runtime-host/storage';
import {
  createState25CodecForTestV1,
  createState25Store4StorageForTestV1,
} from '../../scripts/support/runtime-storage';

const state26 = createRuntimeHostState26StorageBindingV1();
const codec = createState25CodecForTestV1(
  state26.codec as RuntimeSnapshotCodecV1<RuntimeEvent, AgentState>,
);

function createAdapter(databasePath: string, sessionId: string) {
  return createState25Store4StorageForTestV1<RuntimeEvent, AgentState>({
    databasePath,
    codec,
    sessionId,
    uniqueReceiptForEvent: state26.uniqueReceiptForEvent,
  });
}

describe('SQLite Store 4 RuntimeStorage adapter', () => {
  test('strictly reopens an existing Store 4 session without schema or marker drift', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-rmv1-v4-adapter-'));
    const databasePath = join(root, 'runtime.db');
    const sessionId = 'state26-session';
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
          messageId: 'state26-message',
          content: 'preserve me',
          createdAt: '2026-08-20T00:00:00.000Z',
        }),
      );
      const nextState: AgentState = {
        ...reduceAgentState(initial, event),
        revision: 1,
      };
      assertAgentStateInvariants(initial);
      assertAgentStateInvariants(nextState);

      const first = createAdapter(databasePath, sessionId);
      first.transactions.commitDecision({
        sessionId,
        events: [event],
        snapshot: nextState,
        metadata: [{ eventId: 'state26-event', revision: 1 }],
      });
      first.close();

      const adapter = createAdapter(databasePath, sessionId);
      expect(adapter.adapterId).toBe('sqlite');
      expect(adapter.stateSchemaVersion).toBe(25);
      expect(adapter.storeSchemaVersion).toBe(4);
      expect(adapter.compatibilityEpoch).toBe('kite-runtime-2026-08-18');
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
            ['format_version', '4'],
            ['runtime_format_epoch', 'kite-runtime-2026-08-18'],
          ]),
        );
        expect(
          database
            .query<{ count: number }, []>(
              "select count(*) as count from sqlite_master where type = 'table' and name not like 'sqlite_%'",
            )
            .get()?.count,
        ).toBe(8);
        expect(
          database
            .query<{ count: number }, []>(
              "select count(*) as count from sqlite_master where type = 'index' and sql is not null",
            )
            .get()?.count,
        ).toBe(3);
      } finally {
        database.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
