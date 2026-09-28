import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertKiteSessionStoreSchema,
  createKiteHomeWriteTransactionPort,
  createKiteSessionExecutionAuthority,
  openKiteSessionStoreDatabase,
} from '../src';
import {
  KiteSessionStoreMergeConflict,
  mergeKiteSessionStores10,
} from '../src/kite-session-store-merge';

function store() {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-merge-')));
  const database = openKiteSessionStoreDatabase(join(root, 'kite-session.sqlite'));
  return {
    database,
    [Symbol.dispose]: () => {
      database.close(false);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function workspace(database: Database, created: number, updated: number) {
  database
    .query(
      `INSERT INTO workspaces(workspace_id, canonical_path, workspace_identity_digest,
      project_id, workspace_digest, display_name, created_at, updated_at)
      VALUES ('workspace-1', '/workspace', ?, 'project-1', 'digest-1', 'Workspace', ?, ?)`,
    )
    .run(`sha256:${'1'.repeat(64)}`, created, updated);
}

function session(database: Database, id: string, name = '') {
  database
    .query(
      `INSERT INTO runtime_sessions(session_id, workspace_id, project_id, workspace_digest,
      state_schema, format_epoch, revision, name, updated_at, run_index_from_revision)
      VALUES (?, 'workspace-1', 'project-1', 'digest-1', 27,
        'kite-agent-server-api-v1-2026-08-29', 0, ?, 1, 0)`,
    )
    .run(id, name);
  const authority = createKiteSessionExecutionAuthority({
    database,
    writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
    nowMs: () => 10,
  });
  const acquired = authority.acquire({
    sessionId: id,
    expectedRevision: 0,
    hostInstanceId: 'host-1',
    clientId: 'client-1',
    connectionGeneration: 1,
    leaseUntilMs: 100,
  });
  if (acquired.status !== 'acquired') throw new Error('fixture acquire failed');
  authority.release({
    sessionId: id,
    expectedRevision: acquired.authority.revision,
    controllerGeneration: acquired.authority.controllerGeneration,
    hostInstanceId: 'host-1',
    cleanupConfirmed: true,
  });
}

function modelArtifact(database: Database, seed: string, json = '{}') {
  database
    .query(
      `INSERT INTO model_artifacts(artifact_id, kind, integrity_identifier,
      artifact_format_version, canonical_json, byte_length, created_at)
      VALUES (?, 'model_surface', ?, 1, ?, ?, 1)`,
    )
    .run(`pa_${seed.repeat(64)}`, `sha256:${seed.repeat(64)}`, json, Buffer.byteLength(json));
}

function recoveryRequired(database: Database, sessionId: string): void {
  let now = 20;
  const authority = createKiteSessionExecutionAuthority({
    database,
    writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
    nowMs: () => now,
  });
  const current = authority.read(sessionId);
  const acquired = authority.acquire({
    sessionId,
    expectedRevision: current.revision,
    hostInstanceId: 'host-2',
    clientId: 'client-2',
    connectionGeneration: 2,
    leaseUntilMs: 100,
  });
  if (acquired.status !== 'acquired') throw new Error('fixture acquire failed');
  now = 200;
  const recovery = authority.acquire({
    sessionId,
    expectedRevision: acquired.authority.revision,
    hostInstanceId: 'host-3',
    clientId: 'client-3',
    connectionGeneration: 3,
    leaseUntilMs: 300,
  });
  if (recovery.status !== 'recovery_required') throw new Error('fixture recovery failed');
}

function effect(database: Database, sessionId: string, state: 'unknown' | 'prepared') {
  database
    .query(
      `INSERT INTO runtime_effect_leases(
      session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms,
      controller_generation, host_instance_id, client_id, connection_generation,
      state, outcome, terminal_digest, updated_at
    ) VALUES (?, 'effect-1', 'owner-1', 1, ?, 100, 3, 'host-2', 'client-2', 2,
      ?, ?, NULL, 200)`,
    )
    .run(
      sessionId,
      state === 'unknown' ? 'uncertain' : 'certain',
      state,
      state === 'unknown' ? 'unknown' : null,
    );
}

describe('strict Session Store 10 merge', () => {
  test('accepts identical Session events after one source rewrites and reverts content', () => {
    using target = store();
    using source = store();
    workspace(target.database, 1, 1);
    workspace(source.database, 1, 1);
    session(target.database, 'shared');
    session(source.database, 'shared');
    for (const database of [target.database, source.database])
      database.run(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('shared','event-1',1,27,'{"type":"original"}',1)`);
    source.database.run(`UPDATE runtime_events SET event_json='{"type":"temporary"}'
      WHERE session_id='shared' AND event_id='event-1'`);
    source.database.run(`UPDATE runtime_events SET event_json='{"type":"original"}'
      WHERE session_id='shared' AND event_id='event-1'`);
    expect(
      target.database
        .query<{ history_generation: number }, []>(
          "SELECT history_generation FROM runtime_sessions WHERE session_id='shared'",
        )
        .get()?.history_generation,
    ).toBe(1);
    mergeKiteSessionStores10({ target: target.database, source: source.database });
    expect(
      target.database
        .query<{ history_generation: number }, []>(
          "SELECT history_generation FROM runtime_sessions WHERE session_id='shared'",
        )
        .get()?.history_generation,
    ).toBe(3);
    target.database.run(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES ('shared','event-2',2,27,'{"type":"next"}',1)`);
    expect(
      target.database
        .query<{ history_generation: number }, []>(
          "SELECT history_generation FROM runtime_sessions WHERE session_id='shared'",
        )
        .get()?.history_generation,
    ).toBe(4);
  });
  test('preserves the source event generation while merging durable history', () => {
    using target = store();
    using source = store();
    workspace(source.database, 1, 1);
    session(source.database, 'history');
    source.database.run(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES ('history','event-1',1,27,'{"type":"one"}',1)`);
    source.database.run(`UPDATE runtime_events SET event_json='{"type":"two"}'
      WHERE session_id='history' AND event_id='event-1'`);
    const expected = source.database
      .query<{ history_generation: number }, []>(
        "SELECT history_generation FROM runtime_sessions WHERE session_id='history'",
      )
      .get()!.history_generation;
    expect(expected).toBe(2);
    mergeKiteSessionStores10({ target: target.database, source: source.database });
    expect(
      target.database
        .query<{ history_generation: number }, []>(
          "SELECT history_generation FROM runtime_sessions WHERE session_id='history'",
        )
        .get()!.history_generation,
    ).toBe(expected);
    target.database.run("DELETE FROM runtime_events WHERE session_id='history'");
    expect(
      target.database
        .query<{ history_generation: number }, []>(
          "SELECT history_generation FROM runtime_sessions WHERE session_id='history'",
        )
        .get()!.history_generation,
    ).toBe(expected + 1);
  });
  test('copies cross-Session outbox and inbox after both Session identities', () => {
    using target = store();
    using source = store();
    workspace(source.database, 1, 1);
    session(source.database, 'parent');
    session(source.database, 'child');
    source.database
      .query(
        "UPDATE runtime_sessions SET parent_session_id='parent',revision=1 WHERE session_id='child'",
      )
      .run();
    source.database.query("UPDATE runtime_sessions SET revision=1 WHERE session_id='parent'").run();
    const digest = createHash('sha256').update('hello').digest('hex');
    source.database
      .query(`INSERT INTO agent_mail_bodies(session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
      VALUES ('parent',?,?,5,'hello',3)`)
      .run(`pa_${digest}`, `sha256:${digest}`);
    source.database
      .query(`INSERT INTO agent_mail_outbox(source_session_id,message_id,target_session_id,command_id,
      request_digest,source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,
      source_effect_attempt_id,mode,body_id,source_sequence,source_revision,accepted_at_ms,delivered_target_revision)
      VALUES ('parent','mail-1','child','send-1',?,'run-1','turn-1','model-1','tool-1',
      'attempt-1','queue_only',?,1,1,3,1)`)
      .run(digest, `pa_${digest}`);
    source.database
      .query(`INSERT INTO agent_mail_inbox(target_session_id,message_id,source_session_id,
      sequence,target_revision,received_at_ms) VALUES ('child','mail-1','parent',1,1,4)`)
      .run();
    const result = mergeKiteSessionStores10({ target: target.database, source: source.database });
    expect(result.insertedRows).toMatchObject({ agent_mail_outbox: 1, agent_mail_inbox: 1 });
    expect(
      target.database
        .query<{ target_session_id: string }, []>(
          "SELECT target_session_id FROM agent_mail_inbox WHERE message_id='mail-1'",
        )
        .get()?.target_session_id,
    ).toBe('child');
  });

  test('copies Store11 Agent tree, private mail and checkpoint rows in parent-first order', () => {
    using target = store();
    using source = store();
    workspace(source.database, 1, 1);
    session(source.database, 'session-a');
    const body = 'hello';
    const hash = createHash('sha256').update(body).digest('hex');
    const bodyId = `pa_${hash}`;
    source.database
      .query(
        "INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms) VALUES ('session-a','session-a',NULL,NULL,'idle',0,1)",
      )
      .run();
    source.database
      .query(
        "INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms) VALUES ('session-a','child-a','session-a','child-a','active',1,2)",
      )
      .run();
    source.database
      .query(
        `INSERT INTO agent_mail_bodies(session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms) VALUES ('session-a',?, ?, 5, 'hello',3)`,
      )
      .run(bodyId, `sha256:${hash}`);
    source.database
      .query(`INSERT INTO agent_mail(session_id,message_id,sequence,sender_agent_id,target_agent_id,mode,source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,source_effect_attempt_id,request_digest,body_id,status,accepted_at_ms)
      VALUES ('session-a','mail-1',1,'session-a','child-a','queue_only','run-1','turn-1','model-1','tool-1','attempt-1',?,?,'queued',3)`)
      .run(hash, bodyId);
    const checkpoint = '{"artifactFormatVersion":1,"messages":[]}';
    source.database
      .query(`INSERT INTO subagent_checkpoint_artifacts(artifact_id,integrity_identifier,artifact_format_version,canonical_json,byte_length,created_at)
      VALUES ('pa_${'c'.repeat(64)}','sha256:${'c'.repeat(64)}',1,?,?,3)`)
      .run(checkpoint, Buffer.byteLength(checkpoint));
    const result = mergeKiteSessionStores10({ target: target.database, source: source.database });
    expect(result.insertedRows).toMatchObject({
      agent_nodes: 2,
      agent_mail_bodies: 1,
      agent_mail: 1,
      subagent_checkpoint_artifacts: 1,
    });
    expect(
      target.database
        .query<{ body_text: string }, []>(
          "SELECT body_text FROM agent_mail_bodies WHERE session_id='session-a'",
        )
        .get()?.body_text,
    ).toBe(body);
  });
  test('preserves independent Sessions, metadata and Artifact with shared Workspace identity', () => {
    using target = store();
    using source = store();
    workspace(target.database, 20, 30);
    workspace(source.database, 10, 40);
    session(target.database, 'session-a');
    session(source.database, 'session-b');
    modelArtifact(source.database, 'a');
    expect(
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toMatchObject({
      sharedWorkspaces: 1,
      insertedRows: { runtime_sessions: 1, model_artifacts: 1 },
    });
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count,
    ).toBe(2);
    expect(
      target.database
        .query<{ created_at: number; updated_at: number }, []>(
          'SELECT created_at, updated_at FROM workspaces',
        )
        .get(),
    ).toEqual({ created_at: 10, updated_at: 40 });
    expect(
      target.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM kite_meta WHERE key LIKE 'session_execution/%'",
        )
        .get()?.count,
    ).toBe(2);
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM model_artifacts')
        .get()?.count,
    ).toBe(1);
    expect(
      source.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count,
    ).toBe(1);
  });

  test('merges clean recovery owners accepted by single-source continuity', () => {
    using target = store();
    using source = store();
    workspace(target.database, 1, 1);
    workspace(source.database, 1, 1);
    session(target.database, 'target-recovery');
    session(source.database, 'source-recovery');
    for (const [database, sessionId] of [
      [target.database, 'target-recovery'],
      [source.database, 'source-recovery'],
    ] as const) {
      recoveryRequired(database, sessionId);
      const authority = createKiteSessionExecutionAuthority({
        database,
        writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
      });
      const current = authority.read(sessionId);
      expect(
        authority.confirmRecoveryCleanup({
          sessionId,
          expectedRevision: current.revision,
          retainRecoveryRequired: true,
        }),
      ).toMatchObject({ status: 'recovery_required', cleanupConfirmed: true });
    }

    expect(
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toMatchObject({ insertedRows: { runtime_sessions: 1 } });
    const merged = createKiteSessionExecutionAuthority({
      database: target.database,
      writer: createKiteHomeWriteTransactionPort(target.database, assertKiteSessionStoreSchema),
    });
    expect(merged.read('target-recovery')).toMatchObject({
      status: 'recovery_required',
      cleanupConfirmed: true,
    });
    expect(merged.read('source-recovery')).toMatchObject({
      status: 'recovery_required',
      cleanupConfirmed: true,
    });
  });

  test('merges older Sessions without a materialized idle authority record', () => {
    using target = store();
    using source = store();
    workspace(target.database, 1, 1);
    workspace(source.database, 1, 1);
    session(target.database, 'target-legacy');
    session(source.database, 'source-legacy');
    target.database
      .query('DELETE FROM kite_meta WHERE key=?')
      .run('session_execution/target-legacy');
    source.database
      .query('DELETE FROM kite_meta WHERE key=?')
      .run('session_execution/source-legacy');

    expect(
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toMatchObject({ insertedRows: { runtime_sessions: 1 } });
    const merged = createKiteSessionExecutionAuthority({
      database: target.database,
      writer: createKiteHomeWriteTransactionPort(target.database, assertKiteSessionStoreSchema),
    });
    for (const sessionId of ['target-legacy', 'source-legacy']) {
      expect(merged.read(sessionId)).toMatchObject({ status: 'idle', cleanupConfirmed: true });
      expect(
        target.database
          .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=?')
          .get(`session_execution/${sessionId}`),
      ).toBeNull();
    }
  });

  test('same Session ID with divergent content rolls back earlier copied rows', () => {
    using target = store();
    using source = store();
    workspace(target.database, 20, 20);
    workspace(source.database, 10, 30);
    session(target.database, 'session-z', 'first');
    session(source.database, 'session-a');
    session(source.database, 'session-z', 'forked');
    expect(() =>
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toThrow(KiteSessionStoreMergeConflict);
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count,
    ).toBe(1);
    expect(
      target.database
        .query<{ created_at: number; updated_at: number }, []>(
          'SELECT created_at, updated_at FROM workspaces',
        )
        .get(),
    ).toEqual({ created_at: 20, updated_at: 20 });
    expect(
      target.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM kite_meta WHERE key LIKE 'session_execution/%'",
        )
        .get()?.count,
    ).toBe(1);
  });

  test('same Artifact ID with different bytes fails without inserting the source Session', () => {
    using target = store();
    using source = store();
    workspace(target.database, 1, 1);
    workspace(source.database, 1, 1);
    session(target.database, 'session-a');
    session(source.database, 'session-b');
    modelArtifact(target.database, 'a', '{}');
    modelArtifact(source.database, 'a', '{"x":1}');
    expect(() =>
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toThrow(KiteSessionStoreMergeConflict);
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count,
    ).toBe(1);
    expect(
      target.database
        .query<{ canonical_json: string }, []>('SELECT canonical_json FROM model_artifacts')
        .get()?.canonical_json,
    ).toBe('{}');
  });

  test('live source authority is rejected and cannot gain a target execution lease', () => {
    using target = store();
    using source = store();
    workspace(target.database, 1, 1);
    workspace(source.database, 1, 1);
    session(source.database, 'session-b');
    const authority = createKiteSessionExecutionAuthority({
      database: source.database,
      writer: createKiteHomeWriteTransactionPort(source.database, assertKiteSessionStoreSchema),
      nowMs: () => 20,
    });
    const current = authority.read('session-b');
    authority.acquire({
      sessionId: 'session-b',
      expectedRevision: current.revision,
      hostInstanceId: 'host-2',
      clientId: 'client-2',
      connectionGeneration: 2,
      leaseUntilMs: 100,
    });
    expect(() =>
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toThrow(KiteSessionStoreMergeConflict);
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count,
    ).toBe(0);
  });

  test('a tombstone cannot merge across a live Session with the same ID', () => {
    using target = store();
    using source = store();
    workspace(target.database, 1, 1);
    workspace(source.database, 1, 1);
    session(target.database, 'session-a');
    source.database
      .query(
        `INSERT INTO runtime_session_tombstones(
        session_id, workspace_id, project_id, workspace_digest, deleted_revision, deleted_at
      ) VALUES ('session-a', 'workspace-1', 'project-1', 'digest-1', 1, 20)`,
      )
      .run();
    expect(() =>
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toThrow(KiteSessionStoreMergeConflict);
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_session_tombstones')
        .get()?.count,
    ).toBe(0);
  });

  test('unknown metadata is refused rather than imported without an owner', () => {
    using target = store();
    using source = store();
    source.database
      .query('INSERT INTO kite_meta(key, value) VALUES (?, ?)')
      .run('unknown/fact', 'opaque');
    expect(() =>
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toThrow(KiteSessionStoreMergeConflict);
    expect(
      target.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM kite_meta').get()
        ?.count,
    ).toBe(2);
  });

  test('unknown effect stays unknown under recovery_required authority after merge', () => {
    using target = store();
    using source = store();
    workspace(source.database, 1, 1);
    session(source.database, 'session-a');
    recoveryRequired(source.database, 'session-a');
    effect(source.database, 'session-a', 'unknown');
    const original = source.database
      .query<Record<string, unknown>, []>('SELECT * FROM runtime_effect_leases')
      .get();
    expect(
      mergeKiteSessionStores10({ target: target.database, source: source.database }).insertedRows
        .runtime_effect_leases,
    ).toBe(1);
    expect(
      target.database
        .query<Record<string, unknown>, []>('SELECT * FROM runtime_effect_leases')
        .get(),
    ).toEqual(original);
    const authority = createKiteSessionExecutionAuthority({
      database: target.database,
      writer: createKiteHomeWriteTransactionPort(target.database, assertKiteSessionStoreSchema),
      nowMs: () => 500,
    });
    const current = authority.read('session-a');
    expect(current).toMatchObject({ status: 'recovery_required', cleanupConfirmed: false });
    expect(
      authority.acquire({
        sessionId: 'session-a',
        expectedRevision: current.revision,
        hostInstanceId: 'host-new',
        clientId: 'client-new',
        connectionGeneration: 4,
        leaseUntilMs: 600,
      }).status,
    ).toBe('recovery_required');
  });

  test('prepared effect remains unsupported even under recovery_required authority', () => {
    using target = store();
    using source = store();
    workspace(source.database, 1, 1);
    session(source.database, 'session-a');
    recoveryRequired(source.database, 'session-a');
    effect(source.database, 'session-a', 'prepared');
    expect(() =>
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toThrow(KiteSessionStoreMergeConflict);
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count,
    ).toBe(0);
  });

  test('unknown effect with idle authority is rejected', () => {
    using target = store();
    using source = store();
    workspace(source.database, 1, 1);
    session(source.database, 'session-a');
    effect(source.database, 'session-a', 'unknown');
    expect(() =>
      mergeKiteSessionStores10({ target: target.database, source: source.database }),
    ).toThrow(KiteSessionStoreMergeConflict);
    expect(
      target.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_effect_leases')
        .get()?.count,
    ).toBe(0);
  });
});
