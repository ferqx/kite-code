import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKiteHomeArtifactStore } from '../src/kite-home-artifacts';
import {
  assertKiteSessionStore14Schema,
  assertKiteSessionStore15Schema,
  KITE_SESSION_STORE14_DDL,
} from '../src/kite-home-store';
import { convertKiteSessionStore14CandidateTo15 } from '../src/kite-session-store14-to15';

function store14(): Database {
  const database = new Database(':memory:', { strict: true });
  database.run('PRAGMA foreign_keys = ON');
  for (const statement of KITE_SESSION_STORE14_DDL) database.run(statement);
  database.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '14');
  database
    .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
    .run('format_epoch', 'kite-session-history-generation-2026-09-28');
  database.run('PRAGMA user_version = 14');
  assertKiteSessionStore14Schema(database);
  return database;
}

function payload(bytes: number): {
  json: string;
  ref: {
    artifactId: string;
    integrityIdentifier: string;
    byteLength: number;
  };
} {
  const json = JSON.stringify({ text: 'x'.repeat(bytes - 11) });
  const hash = createHash('sha256').update(json).digest('hex');
  return {
    json,
    ref: {
      artifactId: `pa_${hash}`,
      integrityIdentifier: `sha256:${hash}`,
      byteLength: Buffer.byteLength(json),
    },
  };
}

test('Store 14 candidate upgrades without changing rows and accepts private artifacts over old limits', () => {
  const database = store14();
  try {
    const store = createKiteHomeArtifactStore(database);
    const original = payload(32);
    store.writeSubagentTask({
      ref: { ...original.ref, kind: 'subagent_task_request' },
      artifactFormatVersion: 1,
      canonicalJson: original.json,
      createdAt: 1,
    });
    convertKiteSessionStore14CandidateTo15({ database });
    assertKiteSessionStore15Schema(database);
    expect(
      store.readSubagentTask({ ...original.ref, kind: 'subagent_task_request' }).canonicalJson,
    ).toBe(original.json);

    const write = (
      size: number,
      kind:
        | 'model_surface'
        | 'subagent_task'
        | 'subagent_handle'
        | 'subagent_continuation'
        | 'subagent_checkpoint'
        | 'agent_followup_admission',
    ) => {
      const item = payload(size);
      const input = {
        ref: { ...item.ref, kind },
        artifactFormatVersion: 1,
        canonicalJson: item.json,
        createdAt: 2,
      };
      if (kind === 'model_surface') store.writeModel({ ...input, ref: { ...item.ref, kind } });
      if (kind === 'subagent_task')
        store.writeSubagentTask({ ...input, ref: { ...item.ref, kind } });
      if (kind === 'subagent_handle')
        store.writeSubagentLifecycle({ ...input, ref: { ...item.ref, kind } });
      if (kind === 'subagent_continuation')
        store.writeSubagentContinuation({ ...input, ref: { ...item.ref, kind } });
      if (kind === 'subagent_checkpoint')
        store.writeSubagentCheckpoint({ ...input, ref: { ...item.ref, kind } });
      if (kind === 'agent_followup_admission')
        store.writeAgentFollowupAdmission({ ...input, ref: { ...item.ref, kind } });
      return item;
    };
    const model = write(16 * 1024 * 1024 + 1, 'model_surface');
    const task = write(1024 * 1024 + 1, 'subagent_task');
    const lifecycle = write(64 * 1024 + 1, 'subagent_handle');
    const continuation = write(4 * 1024 * 1024 + 1, 'subagent_continuation');
    const checkpoint = write(16 * 1024 * 1024 + 1, 'subagent_checkpoint');
    const admission = write(16 * 1024 * 1024 + 1, 'agent_followup_admission');
    expect(store.readModel({ ...model.ref, kind: 'model_surface' }).canonicalJson).toBe(model.json);
    expect(store.readSubagentTask({ ...task.ref, kind: 'subagent_task' }).canonicalJson).toBe(
      task.json,
    );
    expect(
      store.readSubagentLifecycle({ ...lifecycle.ref, kind: 'subagent_handle' }).canonicalJson,
    ).toBe(lifecycle.json);
    expect(
      store.readSubagentContinuation({ ...continuation.ref, kind: 'subagent_continuation' })
        .canonicalJson,
    ).toBe(continuation.json);
    expect(
      store.readSubagentCheckpoint({ ...checkpoint.ref, kind: 'subagent_checkpoint' })
        .canonicalJson,
    ).toBe(checkpoint.json);
    expect(
      store.readAgentFollowupAdmission({ ...admission.ref, kind: 'agent_followup_admission' })
        .canonicalJson,
    ).toBe(admission.json);
    const grant = payload(16 * 1024 * 1024 + 1);
    database
      .query(`INSERT INTO agent_followup_grant_artifacts
        (artifact_id,integrity_identifier,artifact_format_version,canonical_json,byte_length,created_at)
        VALUES (?,?,1,?,?,2)`)
      .run(grant.ref.artifactId, grant.ref.integrityIdentifier, grant.json, grant.ref.byteLength);
    expect(
      database
        .query<{ byte_length: number }, []>(
          'SELECT byte_length FROM agent_followup_grant_artifacts',
        )
        .get()?.byte_length,
    ).toBe(grant.ref.byteLength);
    const identity = `sha256:${'a'.repeat(64)}`;
    database
      .query(`INSERT INTO workspaces
        (workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,created_at,updated_at)
        VALUES ('workspace','/workspace',?,'project','digest',1,1)`)
      .run(identity);
    database.run(`INSERT INTO runtime_sessions
      (session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,updated_at)
      VALUES ('session','workspace','project','digest',27,'state-epoch',0,1)`);
    const body = 'x'.repeat(4097);
    const bodyDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    database
      .query(`INSERT INTO agent_mail_bodies
        (session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
        VALUES ('session','body',?,?,?,1)`)
      .run(bodyDigest, Buffer.byteLength(body), body);
    expect(
      database
        .query<{ body_text: string }, []>(
          "SELECT body_text FROM agent_mail_bodies WHERE body_id='body'",
        )
        .get()?.body_text,
    ).toBe(body);
  } finally {
    database.close();
  }
});

test('Store 14 candidate conversion rolls back completely on failure', () => {
  const database = store14();
  try {
    expect(() =>
      convertKiteSessionStore14CandidateTo15({
        database,
        faultBeforeCommit: () => {
          throw new Error('injected');
        },
      }),
    ).toThrow('injected');
    assertKiteSessionStore14Schema(database);
  } finally {
    database.close();
  }
});
