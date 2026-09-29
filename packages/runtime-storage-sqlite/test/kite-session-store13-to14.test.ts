import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import { createRuntimeHostStateStorageBinding } from '@kite-ai/runtime-host';
import {
  assertKiteSessionStore13Schema,
  assertKiteSessionStore14Schema,
  KITE_SESSION_STORE13_DDL,
} from '../src/kite-home-store';
import { validateKiteSessionStoreContinuity } from '../src/kite-session-continuity-validation';
import { convertKiteSessionStore13CandidateTo14 } from '../src/kite-session-store13-to14';
import { convertKiteSessionStore14CandidateTo15 } from '../src/kite-session-store14-to15';
import { createSqliteRuntimeLogQueryPortFromDatabase_ } from '../src/log-query';
import { checksum, SQLITE_RUNTIME_RUN_FORMAT_EPOCH } from '../src/preflight';

const workspacePath = '/workspace';
const workspaceHex = createHash('sha256').update(workspacePath).digest('hex');
const projectId = `project_${workspaceHex}`;
const workspaceDigest = `sha256:${workspaceHex}`;
const workspaceIdentityDigest = `sha256:${createHash('sha256')
  .update(
    `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath: workspacePath, projectId, workspaceDigest })}`,
  )
  .digest('hex')}`;
const workspaceId = `workspace_${workspaceIdentityDigest.slice(7)}`;

function candidate(path = ':memory:'): Database {
  const database = new Database(path, { strict: true });
  database.run('PRAGMA foreign_keys = ON');
  for (const statement of KITE_SESSION_STORE13_DDL) database.run(statement);
  database.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '13');
  database
    .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
    .run('format_epoch', 'kite-session-cross-followup-2026-09-25');
  database.run('PRAGMA user_version = 13');
  database
    .query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,
      project_id,workspace_digest,display_name,created_at,updated_at)
      VALUES (?,?,?,?,?,'Workspace',1,1)`)
    .run(workspaceId, workspacePath, workspaceIdentityDigest, projectId, workspaceDigest);
  database.run(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,
    state_schema,format_epoch,revision,name,updated_at,run_index_from_revision)
    VALUES ('parent','${workspaceId}','${projectId}','${workspaceDigest}',27,'kite-agent-server-api-v1-2026-08-29',1,'',1,0)`);
  database.run(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,
    state_schema,format_epoch,revision,name,updated_at,run_index_from_revision,parent_session_id)
    VALUES ('child','${workspaceId}','${projectId}','${workspaceDigest}',27,'kite-agent-server-api-v1-2026-08-29',1,'',1,0,'parent')`);
  database.run(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES ('child','event-1',1,27,'{"type":"one"}',1)`);
  assertKiteSessionStore13Schema(database);
  return database;
}

function authorityRecord(
  sessionId: string,
  status: 'active' | 'detached' | 'recovery_required',
  cleanupConfirmed = false,
) {
  const owned = status !== 'recovery_required';
  return {
    schema: 'kite.session-execution-authority.v1',
    sessionId,
    status,
    controllerGeneration: 3,
    hostInstanceId: owned ? 'retired-host' : null,
    clientId: owned ? 'retired-client' : null,
    connectionGeneration: owned ? 2 : 0,
    interactionGeneration: 4,
    leaseUntilMs: owned ? 1 : null,
    cleanupConfirmed,
    updatedAt: 1,
    revision: 5,
  };
}

function putAuthority(database: Database, record: ReturnType<typeof authorityRecord>): void {
  database
    .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
    .run(`session_execution/${record.sessionId}`, JSON.stringify(record));
}

function addContinuityFacts(database: Database): void {
  const codec = createRuntimeHostStateStorageBinding().codec;
  database.query('DELETE FROM runtime_events WHERE session_id=?').run('child');
  for (const sessionId of ['parent', 'child']) {
    const initial = createInitialAgentState({
      threadId: sessionId,
      userId: 'upgrade-user',
      workspace: workspacePath,
      turnId: `${sessionId}-turn`,
      recoveryIdentityKey: 'a'.repeat(64),
    });
    const stateJson = codec.encodeState({
      ...initial,
      revision: 1,
      session: { ...initial.session, projectId, canonicalWorkspaceDigest: workspaceDigest },
    });
    database
      .query(`INSERT INTO runtime_events
      (session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES (?,?,1,27,?,1)`)
      .run(
        sessionId,
        `${sessionId}-event`,
        JSON.stringify({
          type: 'user.message_appended',
          messageId: `${sessionId}-message`,
          content: `${sessionId} history`,
        }),
      );
    database
      .query(`INSERT INTO runtime_snapshots
      (session_id,schema_version,format_epoch,revision,state_json,event_position,state_checksum,created_at)
      VALUES (?,27,?,1,?,1,?,1)`)
      .run(sessionId, SQLITE_RUNTIME_RUN_FORMAT_EPOCH, stateJson, checksum(stateJson));
  }
}

function generation(database: Database, sessionId: string): number {
  return database
    .query<{ history_generation: number }, [string]>(
      'SELECT history_generation FROM runtime_sessions WHERE session_id = ?',
    )
    .get(sessionId)!.history_generation;
}

describe('private Store 13 to 14 candidate conversion', () => {
  test('preserves old events and advances a durable child content generation across same-sequence rewind and rewrite', () => {
    const database = candidate();
    try {
      convertKiteSessionStore13CandidateTo14({ database });
      assertKiteSessionStore14Schema(database);
      const reader = createSqliteRuntimeLogQueryPortFromDatabase_({
        database,
        currentEventTypes: ['one', 'two', 'three'],
        codec: {
          encodeEvent: JSON.stringify,
          decodeEvent: (json: string) => JSON.parse(json),
          encodeState: JSON.stringify,
          decodeState: JSON.parse,
          snapshotMetadata: () => ({ stateRevision: 0, schemaVersion: 27 }),
          rebindForkState: <State>(state: State) => state,
        },
        childScope: { parentSessionId: 'parent', childSessionId: 'child' },
      });
      expect(generation(database, 'child')).toBe(0);
      expect(reader.getSession?.('child')?.historyGeneration).toBe(0);
      expect(reader.getSession?.('parent')).toBeNull();
      expect(generation(database, 'parent')).toBe(0);
      database.run(`UPDATE runtime_events SET event_json='{"type":"two"}'
        WHERE session_id='child' AND event_id='event-1'`);
      expect(generation(database, 'child')).toBe(1);
      database.run("DELETE FROM runtime_events WHERE session_id='child'");
      expect(generation(database, 'child')).toBe(2);
      database.run(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','event-1',1,27,'{"type":"three"}',1)`);
      expect(generation(database, 'child')).toBe(3);
      expect(reader.getSession?.('child')?.historyGeneration).toBe(3);
      expect(generation(database, 'parent')).toBe(0);
      expect(
        database
          .query<{ sequence: number }, []>(
            "SELECT MAX(sequence) AS sequence FROM runtime_events WHERE session_id='child'",
          )
          .get()?.sequence,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  test('allows session deletion to cascade through event triggers', () => {
    const database = candidate();
    try {
      convertKiteSessionStore13CandidateTo14({ database });
      database.run("DELETE FROM runtime_sessions WHERE session_id='child'");
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM runtime_events WHERE session_id='child'",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .query<{ history_generation: number }, []>(
            "SELECT history_generation FROM runtime_sessions WHERE session_id='parent'",
          )
          .get()?.history_generation,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  test('rolls back the complete conversion on a fault', () => {
    const database = candidate();
    try {
      expect(() =>
        convertKiteSessionStore13CandidateTo14({
          database,
          faultBeforeCommit: () => {
            throw new Error('fault');
          },
        }),
      ).toThrow('fault');
      assertKiteSessionStore13Schema(database);
    } finally {
      database.close();
    }
  });

  test('fences active and detached owners only in the private candidate and preserves source bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-store13-fence-'));
    const sourcePath = join(root, 'source.sqlite');
    const candidatePath = join(root, 'candidate.sqlite');
    const source = candidate(sourcePath);
    putAuthority(source, authorityRecord('parent', 'active'));
    putAuthority(source, authorityRecord('child', 'detached'));
    source.close(false);
    const sourceBytes = readFileSync(sourcePath);
    copyFileSync(sourcePath, candidatePath);
    const converted = new Database(candidatePath, { strict: true });
    try {
      convertKiteSessionStore13CandidateTo14({ database: converted });
      for (const sessionId of ['parent', 'child']) {
        const row = converted
          .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=?')
          .get(`session_execution/${sessionId}`)!;
        expect(JSON.parse(row.value)).toMatchObject({
          status: 'recovery_required',
          controllerGeneration: 4,
          hostInstanceId: null,
          clientId: null,
          connectionGeneration: 0,
          interactionGeneration: 4,
          leaseUntilMs: null,
          cleanupConfirmed: false,
          revision: 6,
        });
      }
      expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    } finally {
      converted.close(false);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('accepts already clean recovery_required while rejecting live owners in continuity', () => {
    const database = candidate();
    try {
      addContinuityFacts(database);
      putAuthority(database, authorityRecord('parent', 'recovery_required', true));
      putAuthority(database, authorityRecord('child', 'active'));
      convertKiteSessionStore13CandidateTo14({ database });
      convertKiteSessionStore14CandidateTo15({ database });
      expect(
        database
          .query<{ value: string }, []>(
            "SELECT value FROM kite_meta WHERE key='session_execution/parent'",
          )
          .get()?.value,
      ).toBe(JSON.stringify(authorityRecord('parent', 'recovery_required', true)));
      expect(
        validateKiteSessionStoreContinuity({
          database,
          codec: createRuntimeHostStateStorageBinding().codec,
        }).recoveryRequired,
      ).toBe(2);
      database
        .query('UPDATE kite_meta SET value=? WHERE key=?')
        .run(JSON.stringify(authorityRecord('child', 'active')), 'session_execution/child');
      expect(() =>
        validateKiteSessionStoreContinuity({
          database,
          codec: createRuntimeHostStateStorageBinding().codec,
        }),
      ).toThrow('Session continuity has live execution authority.');
    } finally {
      database.close();
    }
  });

  test('rejects malformed authority without changing the retired candidate', () => {
    const database = candidate();
    try {
      const malformed = { ...authorityRecord('parent', 'active'), cleanupConfirmed: true };
      putAuthority(database, malformed);
      expect(() => convertKiteSessionStore13CandidateTo14({ database })).toThrow();
      assertKiteSessionStore13Schema(database);
      expect(
        database
          .query<{ value: string }, []>(
            "SELECT value FROM kite_meta WHERE key='session_execution/parent'",
          )
          .get()?.value,
      ).toBe(JSON.stringify(malformed));
    } finally {
      database.close();
    }
  });
});
