import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  encodeRuntimeRunTerminal,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import type { Subprocess } from 'bun';
import {
  KITE_SESSION_STORE_FORMAT_EPOCH,
  KiteSessionRuntimeStorageError,
  openKiteSessionRuntimeStorage,
  openKiteSessionStoreDatabase,
} from '../../src';
import { KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA } from '../../src/kite-session-execution-authority';
import { acquireKiteSessionStoreMaintenance } from '../../src/kite-session-maintenance';
import { checksum } from '../../src/preflight';

type Event = { readonly type: string; readonly [key: string]: unknown };
type State = {
  readonly revision: number;
  readonly recoveryIdentity: string;
  readonly session: {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const STATE_EPOCH = 'test-session-state-v1';
const WORKSPACE_PATH = '/workspace';
const WORKSPACE_PATH_DIGEST = createHash('sha256').update(WORKSPACE_PATH).digest('hex');
const PROJECT_ID = `project_${WORKSPACE_PATH_DIGEST}`;
const WORKSPACE_DIGEST = `sha256:${WORKSPACE_PATH_DIGEST}` as const;
const WORKSPACE_IDENTITY_DIGEST = `sha256:${createHash('sha256')
  .update(
    `kite.workspace-identity.v1\0${JSON.stringify({
      canonicalPath: WORKSPACE_PATH,
      projectId: PROJECT_ID,
      workspaceDigest: WORKSPACE_DIGEST,
    })}`,
  )
  .digest('hex')}` as const;
const WORKSPACE_ID = `workspace_${WORKSPACE_IDENTITY_DIGEST.slice('sha256:'.length)}`;

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <Loaded>(json: string) => JSON.parse(json) as Loaded,
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 1 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  recoveryIdentity: (state: State) => state.recoveryIdentity,
  rebindForkState: (state: State, _sessionId: string, recoveryIdentity: string) => ({
    ...state,
    recoveryIdentity,
  }),
  isCurrentPendingInteractionRequest: () => false,
};

describe('multi-connection Kite Session Runtime storage', () => {
  test('deletes a root without children using a retained receipt', () => {
    const fixture = createFixture(['parent']);
    const owner = openOwner(fixture.path);
    try {
      const parent = owner.bindExecution(acquire(owner, 'parent', 'delete-owner'));
      const receipt = createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'parent',
          commandId: 'delete-root',
          requestDigest: 'f'.repeat(64),
          targetSessionId: 'parent',
          committedAt: Date.now(),
        },
        0,
      );
      owner.runWithExecution(parent, () =>
        owner.storage.sessions.deleteSession('parent', {
          expectedRevision: 0,
          commandReceipt: receipt,
        }),
      );
      expect(
        owner.storage.commandReceipts.lookup({
          scopeSessionId: 'parent',
          commandId: 'delete-root',
          requestDigest: 'f'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt });
    } finally {
      owner.close();
      fixture.remove();
    }
  });
  test('data deletion fences a live foreign child and rejects late writes', () => {
    const fixture = createFixture(['parent', 'child']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    seed
      .query("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'")
      .run();
    seed.close(false);
    const owner = openOwner(fixture.path);
    try {
      const acquired = owner.authority.acquire({
        sessionId: 'child',
        expectedRevision: 0,
        hostInstanceId: 'foreign-host',
        clientId: 'foreign-client',
        connectionGeneration: 1,
        leaseUntilMs: Date.now() + 120_000,
      });
      if (acquired.status !== 'acquired') throw new Error('Foreign lease was not acquired.');
      const lateHandle = owner.bindExecution(acquired.authority);
      const receipt = owner.deleteSessionDataTree('parent', (revision) =>
        createRuntimeStoredCommandReceipt(
          {
            scopeSessionId: 'parent',
            commandId: 'delete-live-child',
            requestDigest: 'a'.repeat(64),
            targetSessionId: 'parent',
            committedAt: Date.now(),
          },
          revision,
        ),
      );
      expect(receipt?.committedRevision).toBe(0);
      expect(owner.storage.sessions.loadSnapshot('parent')).toBeNull();
      expect(owner.storage.sessions.loadSnapshot('child')).toBeNull();
      expect(owner.storage.commandReceipts.lookup(receipt!).status).toBe('replay');
      expect(() =>
        owner.runWithExecution(lateHandle, () =>
          owner.storage.sessions.setSessionName('child', 'late write'),
        ),
      ).toThrow();
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(
          read.query('SELECT session_id FROM runtime_session_tombstones ORDER BY session_id').all(),
        ).toEqual([{ session_id: 'child' }, { session_id: 'parent' }]);
        expect(
          read.query("SELECT key FROM kite_meta WHERE key='session_execution/child'").all(),
        ).toEqual([]);
        expect(read.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        read.close(false);
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('data deletion admission reads active and tombstone identity without decoding corrupt State', () => {
    const fixture = createFixture(['parent']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed.run('PRAGMA ignore_check_constraints=ON');
      seed
        .query(
          "UPDATE runtime_snapshots SET state_json='malformed State' WHERE session_id='parent'",
        )
        .run();
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      const active = owner.readSessionDataDeletionIdentity('parent');
      if (!active) throw new Error('Active Session identity was not found.');
      expect(active).toEqual({
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        workspaceDigest: WORKSPACE_DIGEST,
        canonicalPath: WORKSPACE_PATH,
        deleted: false,
      });
      const receipt = owner.deleteSessionDataTree('parent', (revision) =>
        createRuntimeStoredCommandReceipt(
          {
            scopeSessionId: 'parent',
            commandId: 'delete-corrupt-state',
            requestDigest: 'b'.repeat(64),
            targetSessionId: 'parent',
            committedAt: Date.now(),
          },
          revision,
        ),
      );
      expect(receipt?.committedRevision).toBe(0);
      expect(owner.readSessionDataDeletionIdentity('parent')).toEqual({
        ...active,
        deleted: true,
      });
      expect(owner.readSessionDataDeletionIdentity('missing')).toBeNull();
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('receipt callback cannot mutate general Store state and rolls back on failure', () => {
    const fixture = createFixture(['parent']);
    const owner = openOwner(fixture.path);
    try {
      expect(() =>
        owner.deleteSessionDataTree('parent', () => {
          owner.storage.sessions.setSessionName('parent', 'unauthorized');
          throw new Error('unreachable');
        }),
      ).toThrow();
      expect(() =>
        owner.deleteSessionDataTree('parent', () => {
          throw new Error('receipt failed');
        }),
      ).toThrow();
      expect(owner.storage.sessions.loadSnapshot('parent')).not.toBeNull();
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(read.query('SELECT session_id FROM runtime_session_tombstones').all()).toEqual([]);
      } finally {
        read.close(false);
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('data deletion preserves the cross-tree dependency guard', () => {
    const fixture = createFixture(['parent', 'child', 'other']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'")
        .run();
      seed
        .query(`INSERT INTO agent_mail_inbox
        (target_session_id,message_id,source_session_id,sequence,target_revision,received_at_ms)
        VALUES ('other','cross-mail','child',1,1,1)`)
        .run();
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      expect(() =>
        owner.deleteSessionDataTree('parent', (revision) =>
          createRuntimeStoredCommandReceipt(
            {
              scopeSessionId: 'parent',
              commandId: 'cross-tree',
              requestDigest: 'c'.repeat(64),
              targetSessionId: 'parent',
              committedAt: Date.now(),
            },
            revision,
          ),
        ),
      ).toThrow();
      expect(owner.storage.sessions.loadSnapshot('parent')).not.toBeNull();
      expect(owner.storage.sessions.loadSnapshot('child')).not.toBeNull();
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(read.query('SELECT session_id FROM runtime_session_tombstones').all()).toEqual([]);
        expect(read.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        read.close(false);
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('workspace data deletion removes all roots once while preserving another Workspace', () => {
    const fixture = createFixture(['root-a', 'child-a', 'root-b']);
    const otherWorkspaceId = `workspace_${'b'.repeat(64)}`;
    const otherIdentityDigest = `sha256:${'b'.repeat(64)}`;
    const otherWorkspaceDigest = `sha256:${'c'.repeat(64)}`;
    const targetArtifact = `pa_${'1'.repeat(64)}`;
    const sharedArtifact = `pa_${'2'.repeat(64)}`;
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query("UPDATE runtime_sessions SET parent_session_id='root-a' WHERE session_id='child-a'")
        .run();
      seed
        .query(`INSERT INTO workspaces(
          workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,
          display_name,created_at,updated_at
        ) VALUES (?, '/other', ?, 'project-other', ?, 'Other', 1, 1)`)
        .run(otherWorkspaceId, otherIdentityDigest, otherWorkspaceDigest);
      seed
        .query(`INSERT INTO runtime_sessions(
          session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,
          revision,name,updated_at,run_index_from_revision
        ) VALUES ('external',?,'project-other',?,1,?,0,'',1,0)`)
        .run(otherWorkspaceId, otherWorkspaceDigest, STATE_EPOCH);
      const externalJson = JSON.stringify(state(0, 'external-recovery'));
      seed
        .query(`INSERT INTO runtime_snapshots(
          session_id,schema_version,format_epoch,revision,state_json,event_position,
          state_checksum,created_at
        ) VALUES ('external',1,?,0,?,0,?,1)`)
        .run(STATE_EPOCH, externalJson, checksum(externalJson));
      for (const [artifactId, digit] of [
        [targetArtifact, '1'],
        [sharedArtifact, '2'],
      ] as const) {
        seed
          .query(`INSERT INTO model_artifacts(
            artifact_id,kind,integrity_identifier,artifact_format_version,
            canonical_json,byte_length,created_at
          ) VALUES (?,'model_surface',?,1,'{}',2,1)`)
          .run(artifactId, `sha256:${digit.repeat(64)}`);
      }
      for (const [sessionId, artifactId] of [
        ['root-a', targetArtifact],
        ['root-b', sharedArtifact],
        ['external', sharedArtifact],
      ] as const) {
        const json = JSON.stringify({ ...state(0, 'test-recovery'), refs: [{ artifactId }] });
        seed
          .query('UPDATE runtime_snapshots SET state_json=?,state_checksum=? WHERE session_id=?')
          .run(json, checksum(json), sessionId);
      }
      seed
        .query(`INSERT INTO runtime_runs(
          session_id,run_id,start_command_id,phase,status,created_revision,last_revision,
          created_at_ms,started_at_ms
        ) VALUES ('root-b','stale-run','stale-start','building','running',0,0,1,1)`)
        .run();
      seed
        .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
        .run(`workspace_deletion:${WORKSPACE_ID}`, 'malformed stale fence');
      seed.run('PRAGMA ignore_check_constraints=ON');
      seed
        .query(
          "UPDATE runtime_snapshots SET state_json='broken-history' WHERE session_id='child-a'",
        )
        .run();
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      expect(owner.listWorkspaceSessionIds(WORKSPACE_ID)).toEqual(['child-a', 'root-a', 'root-b']);
      acquire(owner, 'root-b', 'foreign-live-owner');
      const result = owner.deleteWorkspaceSessionData(WORKSPACE_ID);
      expect(result).toEqual({
        rootSessionIds: ['root-a', 'root-b'],
        sessionIds: ['child-a', 'root-a', 'root-b'],
      });
      expect(owner.listWorkspaceSessionIds(WORKSPACE_ID)).toEqual([]);
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(
          read.query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions').all(),
        ).toEqual([{ session_id: 'external' }]);
        expect(
          read.query('SELECT session_id FROM runtime_session_tombstones ORDER BY session_id').all(),
        ).toEqual([{ session_id: 'child-a' }, { session_id: 'root-a' }, { session_id: 'root-b' }]);
        expect(read.query('SELECT artifact_id FROM model_artifacts').all()).toEqual([
          { artifact_id: sharedArtifact },
        ]);
        expect(
          read
            .query('SELECT value FROM kite_meta WHERE key=?')
            .all(`workspace_deletion:${WORKSPACE_ID}`),
        ).toEqual([]);
        expect(read.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        read.close(false);
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('workspace data deletion scales across many roots with one shared artifact pass', () => {
    const sessionIds = Array.from({ length: 100 }, (_, index) => `root-${index}`);
    const fixture = createFixture(sessionIds);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    const largeArtifactId = `pa_${'f'.repeat(64)}`;
    try {
      const insertArtifact = seed.query(`INSERT INTO model_artifacts(
        artifact_id,kind,integrity_identifier,artifact_format_version,
        canonical_json,byte_length,created_at
      ) VALUES (?,'model_surface',?,1,?,?,1)`);
      const updateSnapshot = seed.query(
        'UPDATE runtime_snapshots SET state_json=?,state_checksum=? WHERE session_id=?',
      );
      for (const [index, sessionId] of sessionIds.entries()) {
        const hex = index.toString(16).padStart(64, '0');
        const artifactId = `pa_${hex}`;
        insertArtifact.run(artifactId, `sha256:${hex}`, '{}', 2);
        const json = JSON.stringify({ ...state(0, `recovery-${index}`), refs: [{ artifactId }] });
        updateSnapshot.run(json, checksum(json), sessionId);
      }
      const largeJson = JSON.stringify({ text: 'x'.repeat(8_000_000) });
      insertArtifact.run(
        largeArtifactId,
        `sha256:${'f'.repeat(64)}`,
        largeJson,
        Buffer.byteLength(largeJson),
      );
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      const started = performance.now();
      const result = owner.deleteWorkspaceSessionData(WORKSPACE_ID);
      const elapsedMs = performance.now() - started;
      expect(result.rootSessionIds).toHaveLength(100);
      expect(result.sessionIds).toHaveLength(100);
      expect(elapsedMs).toBeLessThan(5_000);
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(read.query('SELECT artifact_id FROM model_artifacts').all()).toEqual([
          { artifact_id: largeArtifactId },
        ]);
      } finally {
        read.close(false);
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  }, 20_000);

  test('empty Workspace data deletion clears only its stale metadata', () => {
    const fixture = createFixture([]);
    const otherWorkspaceId = `workspace_${'b'.repeat(64)}`;
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      const insert = seed.query('INSERT INTO kite_meta(key,value) VALUES (?,?)');
      insert.run(`workspace_authority/${WORKSPACE_ID}/orphaned`, 'stale');
      insert.run(`workspace_deletion:${WORKSPACE_ID}`, 'stale');
      insert.run(`workspace_authority/${otherWorkspaceId}/preserved`, 'other');
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      expect(owner.deleteWorkspaceSessionData(WORKSPACE_ID)).toEqual({
        rootSessionIds: [],
        sessionIds: [],
      });
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(
          read
            .query<{ key: string }, []>(
              "SELECT key FROM kite_meta WHERE key LIKE 'workspace_authority/%' OR key LIKE 'workspace_deletion:%'",
            )
            .all(),
        ).toEqual([{ key: `workspace_authority/${otherWorkspaceId}/preserved` }]);
      } finally {
        read.close(false);
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('workspace data deletion rolls back authority when a tombstone insert fails', () => {
    const fixture = createFixture(['root-a', 'root-b']);
    const owner = openOwner(fixture.path);
    try {
      acquire(owner, 'root-a', 'active-owner');
      const seed = openKiteSessionStoreDatabase(fixture.path);
      try {
        seed
          .query(`INSERT INTO runtime_session_tombstones(
            session_id,workspace_id,project_id,workspace_digest,deleted_revision,deleted_at
          ) VALUES ('root-b',?,?,?,?,1)`)
          .run(WORKSPACE_ID, PROJECT_ID, WORKSPACE_DIGEST, 0);
      } finally {
        seed.close(false);
      }
      expect(() => owner.deleteWorkspaceSessionData(WORKSPACE_ID)).toThrow();
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(
          read.query('SELECT session_id FROM runtime_sessions ORDER BY session_id').all(),
        ).toEqual([{ session_id: 'root-a' }, { session_id: 'root-b' }]);
        expect(read.query('SELECT session_id FROM runtime_session_tombstones').all()).toEqual([
          { session_id: 'root-b' },
        ]);
        expect(
          read.query('SELECT key FROM kite_meta WHERE key=?').all('session_execution/root-a'),
        ).toEqual([{ key: 'session_execution/root-a' }]);
      } finally {
        read.close(false);
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('atomically deletes a settled child tree with its root receipt', () => {
    const fixture = createFixture(['parent', 'child', 'grandchild', 'other']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'")
        .run();
      seed
        .query(
          "UPDATE runtime_sessions SET parent_session_id='child' WHERE session_id='grandchild'",
        )
        .run();
      const artifacts = [
        ['1', 'parent'],
        ['2', 'child'],
        ['3', 'shared'],
        ['4', 'orphan'],
      ] as const;
      for (const [digit] of artifacts) {
        seed
          .query(`INSERT INTO model_artifacts(artifact_id,kind,integrity_identifier,
          artifact_format_version,canonical_json,byte_length,created_at)
          VALUES (?,'model_surface',?,1,'{}',2,1)`)
          .run(`pa_${digit.repeat(64)}`, `sha256:${digit.repeat(64)}`);
      }
      for (const [sessionId, digits] of [
        ['parent', ['1', '3']],
        ['child', ['2']],
        ['other', ['3']],
      ] as const) {
        const json = JSON.stringify({
          ...state(0, `recovery-${sessionId === 'parent' ? 0 : sessionId === 'child' ? 1 : 3}`),
          refs: digits.map((digit) => ({ artifactId: `pa_${digit.repeat(64)}` })),
        });
        seed
          .query('UPDATE runtime_snapshots SET state_json=?, state_checksum=? WHERE session_id=?')
          .run(json, checksum(json), sessionId);
      }
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      const parent = owner.bindExecution(acquire(owner, 'parent', 'delete-owner'));
      const receipt = createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'parent',
          commandId: 'delete-tree',
          requestDigest: 'd'.repeat(64),
          targetSessionId: 'parent',
          committedAt: Date.now(),
        },
        0,
      );
      owner.runWithExecution(parent, () =>
        owner.storage.sessions.deleteSession('parent', {
          expectedRevision: 0,
          commandReceipt: receipt,
        }),
      );
      const read = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(
          read
            .query<{ session_id: string }, []>(
              'SELECT session_id FROM runtime_sessions ORDER BY session_id',
            )
            .all(),
        ).toEqual([{ session_id: 'other' }]);
        expect(
          read
            .query<{ artifact_id: string }, []>(
              'SELECT artifact_id FROM model_artifacts ORDER BY artifact_id',
            )
            .all()
            .map((row) => row.artifact_id),
        ).toEqual([`pa_${'3'.repeat(64)}`, `pa_${'4'.repeat(64)}`]);
        expect(read.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        read.close(false);
      }
      expect(
        owner.storage.commandReceipts.lookup({
          scopeSessionId: 'parent',
          commandId: 'delete-tree',
          requestDigest: 'd'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt });
    } finally {
      owner.close();
      fixture.remove();
    }
  });
  test('rejects an active child and a cross-tree reference without deleting any Session', () => {
    const fixture = createFixture(['parent', 'child', 'other']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'")
        .run();
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    const receipt = createRuntimeStoredCommandReceipt(
      {
        scopeSessionId: 'parent',
        commandId: 'delete-blocked',
        requestDigest: 'e'.repeat(64),
        targetSessionId: 'parent',
        committedAt: Date.now(),
      },
      0,
    );
    try {
      const parent = owner.bindExecution(acquire(owner, 'parent', 'delete-owner'));
      const child = acquire(owner, 'child', 'child-owner');
      const remove = () =>
        owner.runWithExecution(parent, () =>
          owner.storage.sessions.deleteSession('parent', {
            expectedRevision: 0,
            commandReceipt: receipt,
          }),
        );
      expect(remove).toThrow();
      expect(owner.storage.sessions.loadSnapshot('child')).not.toBeNull();
      owner.authority.release({
        sessionId: 'child',
        expectedRevision: child.revision,
        controllerGeneration: child.controllerGeneration,
        hostInstanceId: 'child-owner',
        cleanupConfirmed: true,
      });
      const links = openKiteSessionStoreDatabase(fixture.path);
      try {
        links
          .query(`INSERT INTO agent_mail_inbox
          (target_session_id,message_id,source_session_id,sequence,target_revision,received_at_ms)
          VALUES ('other','cross-mail','child',1,1,1)`)
          .run();
      } finally {
        links.close(false);
      }
      expect(remove).toThrow();
      expect(owner.storage.sessions.loadSnapshot('parent')).not.toBeNull();
      expect(owner.storage.sessions.loadSnapshot('child')).not.toBeNull();
      expect(
        owner.storage.commandReceipts.lookup({
          scopeSessionId: 'parent',
          commandId: 'delete-blocked',
          requestDigest: 'e'.repeat(64),
        }).status,
      ).toBe('missing');
    } finally {
      owner.close();
      fixture.remove();
    }
  });
  test('fences cross-Session QueueOnly acceptance, target receipt and source confirmation', () => {
    const fixture = createFixture(['parent', 'child']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'")
        .run();
      const node =
        seed.query(`INSERT INTO agent_nodes(session_id,agent_id,current_task_id,status,turn_ordinal,created_at_ms)
        VALUES (?,?,?,?,1,1)`);
      node.run('parent', 'parent', 'source-run', 'active');
      node.run('child', 'child', 'child-run', 'active');
      seed
        .query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('parent','source-run','start','building','running',0,0,1,1)`)
        .run();
      seed
        .query(`INSERT INTO runtime_runs(session_id,run_id,origin_session_id,origin_run_id,
        start_command_id,phase,status,created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('child','child-run','parent','source-run','child-start','building','running',0,0,1,1)`)
        .run();
      seed
        .query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,
        artifact_format_version,canonical_json,byte_length,created_at)
        VALUES (?,'subagent_task',?,1,'{}',2,1)`)
        .run(`pa_${'1'.repeat(64)}`, `sha256:${'1'.repeat(64)}`);
      seed
        .query(`INSERT INTO child_session_intents(
        child_thread_id,parent_session_id,parent_invocation_id,origin_run_id,origin_turn_id,
        origin_tool_call_id,attempt,child_invocation_id,grant_digest,sealed_grant_json,
        sealed_grant_byte_length,sealed_grant_digest,task_artifact_digest,task_text_digest,
        task_artifact_id,task_artifact_byte_length,disposition,role,tool_event_id,
        tool_event_revision,funding_run_id,delegated_reservation_id,
        delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at,
        child_budget_activated_run_id,child_budget_activated_event_id,
        child_budget_activated_revision,dispatch_ack_event_id,dispatch_ack_revision)
        VALUES ('child','parent','parent-invocation','source-run','source-turn',
        'spawn-tool',1,'child-invocation','grant','{}',2,'sealed','task-digest','text-digest',
        ?,2,'required','code','tool-event',1,'source-run','reservation',
        'budget-digest','{}','2099-01-01T00:00:00.000Z',
        'child-run','activation-event',1,'dispatch-ack',1)`)
        .run(`pa_${'1'.repeat(64)}`);
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      const parent = owner.bindExecution(acquire(owner, 'parent', 'source-owner'));
      const child = owner.bindExecution(acquire(owner, 'child', 'target-owner'));
      const bodyText = 'hello child';
      const bodyDigest = `sha256:${createHash('sha256').update(bodyText).digest('hex')}`;
      const source = {
        runId: 'source-run',
        turnId: 'source-turn',
        modelInvocationId: 'source-model',
        toolCallId: 'source-tool',
        effectAttemptId: 'source-attempt',
        sourceTaskId: 'source-task',
      };
      const event = {
        type: 'agent.mail_accepted',
        messageId: 'mail-1',
        senderAgentId: 'parent',
        targetAgentId: 'child',
        mode: 'queue_only',
        source,
        bodyRef: {
          artifactId: `pa_${bodyDigest.slice(7)}`,
          kind: 'agent_mail',
          integrityIdentifier: bodyDigest,
          byteLength: Buffer.byteLength(bodyText),
        },
        bodyDigest,
        sequence: 1,
      };
      owner.runWithExecution(parent, () => {
        expect(owner.crossSessionQueueMail.nextSourceSequence('parent')).toBe(1);
        expect(() => owner.crossSessionQueueMail.listQueuedInbox('child', 'child-run', 8)).toThrow(
          KiteSessionRuntimeStorageError,
        );
        expect(
          owner.storage.effects.tryAcquireEffectLease(
            'parent',
            'tool-effect',
            'source-owner',
            Date.now() + 60_000,
          ),
        ).toBe(true);
        owner.storage.transactions.commitReceiptEvidence({
          sessionId: 'parent',
          events: [event],
          metadata: [{ eventId: 'source-mail-event', revision: 1 }],
          snapshot: state(1, 'recovery-0'),
          commandReceipt: createRuntimeStoredCommandReceipt(
            {
              scopeSessionId: 'parent',
              commandId: 'send-command',
              requestDigest: 'a'.repeat(64),
              targetSessionId: 'parent',
              committedAt: 10,
            },
            1,
          ),
          requiredEffectLease: {
            effectId: 'tool-effect',
            ownerId: 'source-owner',
            observedAtMs: Date.now(),
          },
          crossSessionAgentMailMutation: {
            kind: 'accept_queue',
            messageId: 'mail-1',
            targetSessionId: 'child',
            commandId: 'send-command',
            requestDigest: 'a'.repeat(64),
            sourceRunId: source.runId,
            sourceTurnId: source.turnId,
            sourceModelInvocationId: source.modelInvocationId,
            sourceToolCallId: source.toolCallId,
            sourceEffectAttemptId: source.effectAttemptId,
            sourceTaskId: source.sourceTaskId,
            sourceSequence: 1,
            bodyText,
            acceptedAtMs: 10,
          },
        });
        expect(owner.crossSessionQueueMail.listPendingOutbox('parent', 8)).toHaveLength(1);
      });
      owner.runWithExecution(child, () => {
        expect(owner.crossSessionQueueMail.nextTargetSequence('child')).toBe(1);
        expect(() =>
          owner.storage.transactions.commitDecision({
            sessionId: 'child',
            events: [{ ...event, source: { ...source, toolCallId: 'wrong-tool' } }],
            metadata: [{ eventId: 'target-mail-event', revision: 1 }],
            snapshot: state(1, 'recovery-1'),
            crossSessionAgentMailMutation: {
              kind: 'receive_queue',
              sourceSessionId: 'parent',
              messageId: 'mail-1',
              receivedAtMs: 11,
            },
          }),
        ).toThrow();
        expect(owner.crossSessionQueueMail.nextTargetSequence('child')).toBe(1);
        owner.storage.transactions.commitDecision({
          sessionId: 'child',
          events: [event],
          metadata: [{ eventId: 'target-mail-event', revision: 1 }],
          snapshot: state(1, 'recovery-1'),
          crossSessionAgentMailMutation: {
            kind: 'receive_queue',
            sourceSessionId: 'parent',
            messageId: 'mail-1',
            receivedAtMs: 11,
          },
        });
        expect(owner.crossSessionQueueMail.readInboxReceipt('child', 'mail-1')).toMatchObject({
          sourceSessionId: 'parent',
          sequence: 1,
          targetRevision: 1,
        });
        expect(owner.crossSessionQueueMail.listQueuedInbox('child', 'child-run', 8)).toEqual([
          expect.objectContaining({ messageId: 'mail-1', bodyText, sourceTaskId: 'source-task' }),
        ]);
        owner.storage.transactions.commitDecision({
          sessionId: 'child',
          events: [
            {
              type: 'model.invocation_prepared',
              invocationId: 'child-model',
              budget: { kind: 'no_budget' },
            },
            {
              type: 'agent.mail_input_prepared',
              targetAgentId: 'child',
              invocationId: 'child-model',
              modelAdmissionId: 'child-model',
              fromSequence: 0,
              throughSequence: 1,
              messageIds: ['mail-1'],
            },
          ],
          metadata: [
            { eventId: 'child-model-prepared', revision: 2 },
            { eventId: 'child-mail-prepared', revision: 3 },
          ],
          snapshot: {
            ...state(3, 'recovery-1'),
            resourceBudget: { status: 'unconfigured' },
          } as State,
          crossSessionAgentMailMutation: {
            kind: 'prepare_queue_input',
            modelInvocationId: 'child-model',
            modelAdmissionId: 'child-model',
            currentRunId: 'child-run',
            fromSequence: 0,
            throughSequence: 1,
            messageIds: ['mail-1'],
          },
        });
        expect(owner.crossSessionQueueMail.listQueuedInbox('child', 'child-run', 8)).toEqual([]);
      });
      owner.runWithExecution(parent, () => {
        expect(
          owner.crossSessionQueueMail.confirmDelivered('parent', 'mail-1').deliveredTargetRevision,
        ).toBe(1);
        expect(owner.crossSessionQueueMail.listPendingOutbox('parent', 8)).toEqual([]);
      });
    } finally {
      owner.close();
      fixture.remove();
    }
  });
  test('scopes child State and History reads to the exact parent with bounded stable pages', () => {
    const fixture = createFixture([
      'parent',
      'other-parent',
      'child-a',
      'child-b',
      'child-c',
      'root',
    ]);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query(
          "UPDATE runtime_sessions SET parent_session_id='parent',updated_at=10 WHERE session_id IN ('child-a','child-b')",
        )
        .run();
      seed
        .query(
          "UPDATE runtime_sessions SET parent_session_id='parent',updated_at=9 WHERE session_id='child-c'",
        )
        .run();
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      const first = owner.listChildSessions('parent', 1);
      expect(first.entries.map((row) => row.sessionId)).toEqual(['child-c']);
      expect(first.entries[0]).toMatchObject({
        parentSessionId: 'parent',
        updatedAt: 9,
        revision: 0,
      });
      const second = owner.listChildSessions('parent', 1, first.nextCursor);
      expect(second.entries.map((row) => row.sessionId)).toEqual(['child-b']);
      const third = owner.listChildSessions('parent', 1, second.nextCursor);
      expect(third.entries.map((row) => row.sessionId)).toEqual(['child-a']);
      expect(third.nextCursor).toBeUndefined();
      expect(owner.listChildSessions('other-parent', 10).entries).toEqual([]);
      expect(owner.listChildSessions('missing', 10).entries).toEqual([]);
      expect(() => owner.listChildSessions('parent', 101)).toThrow('page request');
      expect(owner.readChildSession('parent', 'child-b')).toMatchObject({
        sessionId: 'child-b',
        state: { recoveryIdentity: 'recovery-3' },
      });
      expect(owner.readChildSession('other-parent', 'child-b')).toBeNull();
      expect(owner.readChildSession('parent', 'root')).toBeNull();
      expect(owner.readChildSession('parent', 'missing')).toBeNull();
      const events = openKiteSessionStoreDatabase(fixture.path);
      try {
        events
          .query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
            VALUES ('child-b','child-event',1,27,'{"type":"child.test"}',1)`)
          .run();
      } finally {
        events.close(false);
      }
      const history = owner.openChildSessionHistoryLogs('parent', 'child-b', ['child.test']);
      expect(history.getSession?.('child-b')?.sessionId).toBe('child-b');
      expect(history.getSession?.('root')).toBeNull();
      expect(
        history.listEvents({ sessionId: 'child-b', direction: 'forward', limit: 10 }).entries,
      ).toMatchObject([{ sessionId: 'child-b', event: { type: 'child.test' } }]);
      expect(() =>
        history.listEvents({ sessionId: 'root', direction: 'forward', limit: 10 }),
      ).toThrow('not found');
      const foreign = owner.openChildSessionHistoryLogs('other-parent', 'child-b', ['child.test']);
      expect(foreign.getSession?.('child-b')).toBeNull();
      expect(() =>
        foreign.listEvents({ sessionId: 'child-b', direction: 'forward', limit: 10 }),
      ).toThrow('not found');
      foreign.close();
      const changed = openKiteSessionStoreDatabase(fixture.path);
      try {
        changed
          .query(
            "UPDATE runtime_sessions SET parent_session_id='other-parent' WHERE session_id='child-b'",
          )
          .run();
      } finally {
        changed.close(false);
      }
      expect(history.getSession?.('child-b')).toBeNull();
      expect(() =>
        history.listEvents({ sessionId: 'child-b', direction: 'forward', limit: 10 }),
      ).toThrow('not found');
      history.close();
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('keeps unread children on later pages when their updated_at advances', () => {
    const fixture = createFixture(['parent', 'child-a', 'child-b', 'child-c']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id!='parent'")
        .run();
      seed.query("UPDATE runtime_sessions SET updated_at=10 WHERE session_id='child-c'").run();
      seed.query("UPDATE runtime_sessions SET updated_at=9 WHERE session_id='child-b'").run();
      seed.query("UPDATE runtime_sessions SET updated_at=8 WHERE session_id='child-a'").run();
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    const writer = openKiteSessionStoreDatabase(fixture.path);
    try {
      const first = owner.listChildSessions('parent', 1);
      expect(first.entries.map((row) => row.sessionId)).toEqual(['child-c']);
      writer.query("UPDATE runtime_sessions SET updated_at=11 WHERE session_id='child-b'").run();
      const second = owner.listChildSessions('parent', 1, first.nextCursor);
      expect(second.entries.map((row) => row.sessionId)).toEqual(['child-b']);
      expect(second.entries[0]?.updatedAt).toBe(11);
      writer.query("UPDATE runtime_sessions SET updated_at=12 WHERE session_id='child-a'").run();
      const third = owner.listChildSessions('parent', 1, second.nextCursor);
      expect(third.entries.map((row) => row.sessionId)).toEqual(['child-a']);
      expect(third.entries[0]?.updatedAt).toBe(12);
      expect(third.nextCursor).toBeUndefined();
    } finally {
      writer.close(false);
      owner.close();
      fixture.remove();
    }
  });

  test('binds child turn generation to the active Store execution handle', () => {
    const fixture = createFixture(['session-1']);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query(
          "INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms) VALUES ('session-1','session-1',NULL,NULL,'idle',0,1)",
        )
        .run();
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      const handle = owner.bindExecution(acquire(owner, 'session-1', 'child-owner'));
      owner.runWithExecution(handle, () => {
        const generation = owner.storage.currentExecutionGeneration('session-1');
        expect(generation).toBe('1');
        owner.storage.transactions.commitDecision({
          sessionId: 'session-1',
          events: [
            {
              type: 'agent.created',
              agentId: 'child-1',
              parentAgentId: 'session-1',
              initialTaskId: 'child-1',
            },
            {
              type: 'agent.turn_started',
              agentId: 'child-1',
              taskId: 'child-1',
              turnOrdinal: 1,
              ownerGeneration: generation,
              grantDigest: `sha256:${'a'.repeat(64)}`,
            },
          ],
          metadata: [
            { eventId: 'child-created', revision: 1 },
            { eventId: 'child-turn-started', revision: 2 },
          ],
          snapshot: state(2, 'recovery-0'),
          agentMailboxMutations: [
            {
              kind: 'create_agent',
              agentId: 'child-1',
              parentAgentId: 'session-1',
              initialTaskId: 'child-1',
              createdAtMs: 2,
            },
            { kind: 'turn_started', agentId: 'child-1', taskId: 'child-1', turnOrdinal: 1 },
          ],
        });
        expect(owner.agentMailbox.readAgent('session-1', 'session-1', 'child-1')).toMatchObject({
          status: 'active',
          turnOrdinal: 1,
          currentTaskId: 'child-1',
        });
        expect(
          owner.storage.agentMailbox.readActiveTaskProof(
            'session-1',
            'session-1',
            'child-1',
            'child-1',
          ),
        ).toEqual({
          ownerGeneration: '1',
          grantDigest: `sha256:${'a'.repeat(64)}`,
        });
        expect(
          owner.agentMailbox.readActiveTaskProof('session-1', 'session-1', 'child-1', 'other-task'),
        ).toBeNull();
      });
      expect(() =>
        owner.agentMailbox.readActiveTaskProof('session-1', 'session-1', 'child-1', 'child-1'),
      ).toThrow('active execution scope');
    } finally {
      owner.close();
      fixture.remove();
    }
  });
  test('legacy Session gets one root row on first Run and advances across a second Run after reopen', () => {
    const fixture = createFixture(['session-1']);
    const owner = openOwner(fixture.path);
    try {
      const handle = owner.bindExecution(acquire(owner, 'session-1', 'legacy-root-owner'));
      owner.runWithExecution(handle, () => {
        const insertRootMail = (
          messageId: string,
          sequence: number,
          text: string,
          recipientRunId: string | null,
        ): void => {
          const database = openKiteSessionStoreDatabase(fixture.path);
          try {
            const digest = createHash('sha256').update(text).digest('hex');
            const bodyId = `pa_${digest}`;
            database
              .query(`INSERT INTO agent_mail_bodies(session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
              VALUES ('session-1',?,?,?,?,1)`)
              .run(bodyId, `sha256:${digest}`, Buffer.byteLength(text), text);
            database
              .query(`INSERT INTO agent_mail(session_id,message_id,sequence,sender_agent_id,target_agent_id,recipient_run_id,mode,
              source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,source_effect_attempt_id,
              request_digest,body_id,status,accepted_at_ms)
              VALUES ('session-1',?,?,'session-1','session-1',?,'queue_only','run-1','run-1','model-1',?,?,?,?,'queued',1)`)
              .run(
                messageId,
                sequence,
                recipientRunId,
                `tool-${sequence}`,
                `attempt-${sequence}`,
                digest,
                bodyId,
              );
          } finally {
            database.close(false);
          }
        };
        const start = (runId: string, revision: number): RuntimeStoredRun => {
          const run: RuntimeStoredRun = {
            sessionId: 'session-1',
            runId,
            startCommandId: `start-${runId}`,
            phase: 'building',
            status: 'queued',
            createdRevision: revision,
            lastRevision: revision,
            createdAtMs: revision,
          };
          owner.storage.transactions.commitDecision({
            sessionId: 'session-1',
            events: [{ type: 'turn.started', turnId: runId }],
            metadata: [{ eventId: `event-${runId}`, revision }],
            snapshot: state(revision, 'recovery-0'),
            commandReceipt: createRuntimeStoredCommandReceipt(
              {
                scopeSessionId: 'session-1',
                targetSessionId: 'session-1',
                commandId: run.startCommandId,
                requestDigest: 'a'.repeat(64),
                committedAt: revision,
                resourceResult: createRuntimeRunStartResourceResult(run),
              },
              revision,
            ),
            runMutation: { type: 'insert', run },
          });
          return run;
        };
        const first = start('run-1', 1);
        expect(owner.agentMailbox.readAgent('session-1', 'session-1', 'session-1')).toMatchObject({
          status: 'active',
          currentTaskId: 'run-1',
          turnOrdinal: 1,
        });
        insertRootMail('mail-run-1', 1, 'same run', 'run-1');
        expect(
          owner.agentMailInput
            .readPendingMailForActiveTask({
              sessionId: 'session-1',
              targetAgentId: 'session-1',
              currentTaskId: 'run-1',
              modelInvocationId: 'model-run-1',
              fromSequence: 0,
            })
            .map((mail) => mail.bodyText),
        ).toEqual(['same run']);
        owner.storage.transactions.commitAttemptStart({
          sessionId: 'session-1',
          events: [],
          snapshot: state(1, 'recovery-0'),
          runMutation: {
            type: 'transition',
            transition: {
              sessionId: 'session-1',
              runId: 'run-1',
              expectedLastRevision: 1,
              next: { ...first, status: 'running', startedAtMs: 1 },
            },
          },
        });
        owner.storage.transactions.commitDecision({
          sessionId: 'session-1',
          events: [{ type: 'run.completed', turnId: 'run-1', output: '' }],
          metadata: [{ eventId: 'terminal-run-1', revision: 2 }],
          snapshot: state(2, 'recovery-0'),
          runMutation: {
            type: 'transition',
            transition: {
              sessionId: 'session-1',
              runId: 'run-1',
              expectedLastRevision: 1,
              next: {
                ...first,
                status: 'completed',
                lastRevision: 2,
                startedAtMs: 1,
                finishedAtMs: 2,
              },
            },
          },
        });
        expect(owner.agentMailbox.readAgent('session-1', 'session-1', 'session-1')).toMatchObject({
          status: 'idle',
          currentTaskId: null,
          turnOrdinal: 1,
        });
        insertRootMail('mail-after-run-1', 2, 'idle report', null);
        start('run-2', 3);
        expect(
          owner.agentMailInput.readPendingMailForActiveTask({
            sessionId: 'session-1',
            targetAgentId: 'session-1',
            currentTaskId: 'run-2',
            modelInvocationId: 'model-run-2',
            fromSequence: 0,
          }),
        ).toEqual([]);
        expect(owner.agentMailbox.readAgent('session-1', 'session-1', 'session-1')).toMatchObject({
          unreadCount: 2,
        });
      });
    } finally {
      owner.close();
    }
    const reopened = openOwner(fixture.path);
    try {
      expect(reopened.agentMailbox.readAgent('session-1', 'session-1', 'session-1')).toMatchObject({
        status: 'active',
        currentTaskId: 'run-2',
        turnOrdinal: 2,
      });
    } finally {
      reopened.close();
      fixture.remove();
    }
  });
  test('reads private Agent mail only for an exact active task and prepared invocation after reopen', () => {
    const fixture = createFixture(['session-1']);
    const database = openKiteSessionStoreDatabase(fixture.path);
    const rows = [
      {
        id: 'mail-1',
        sequence: 1,
        text: 'hello',
        status: 'prepared',
        invocation: 'model-old',
        admission: 'reserve-old',
      },
      {
        id: 'mail-2',
        sequence: 2,
        text: 'world',
        status: 'queued',
        invocation: null,
        admission: null,
      },
    ] as const;
    try {
      database
        .query(
          "INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms) VALUES ('session-1','session-1',NULL,NULL,'idle',0,1)",
        )
        .run();
      database
        .query(
          "INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,prepared_through_sequence,created_at_ms) VALUES ('session-1','child-1','session-1','child-1','active',1,1,2)",
        )
        .run();
      for (const row of rows) {
        const digest = createHash('sha256').update(row.text).digest('hex');
        const bodyId = `pa_${digest}`;
        database
          .query(
            'INSERT INTO agent_mail_bodies(session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms) VALUES (?,?,?,?,?,1)',
          )
          .run('session-1', bodyId, `sha256:${digest}`, Buffer.byteLength(row.text), row.text);
        database
          .query(`INSERT INTO agent_mail(session_id,message_id,sequence,sender_agent_id,target_agent_id,mode,source_run_id,source_turn_id,
          source_model_invocation_id,source_tool_call_id,source_effect_attempt_id,request_digest,body_id,status,prepared_invocation_id,model_admission_id,accepted_at_ms)
          VALUES ('session-1',?,?,'session-1','child-1','queue_only','run-1','turn-1','model-1',?, ?, ?, ?, ?, ?, ?, 1)`)
          .run(
            row.id,
            row.sequence,
            `tool-${row.sequence}`,
            `attempt-${row.sequence}`,
            digest,
            bodyId,
            row.status,
            row.invocation,
            row.admission,
          );
      }
    } finally {
      database.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      const request = {
        sessionId: 'session-1',
        targetAgentId: 'child-1',
        currentTaskId: 'child-1',
        modelInvocationId: 'model-new',
        fromSequence: 1,
      };
      expect(() => owner.agentMailInput.readPendingMailForActiveTask(request)).toThrow(
        'active execution scope',
      );
      expect(() => owner.currentExecutionGeneration('session-1')).toThrow('active execution scope');
      const handle = owner.bindExecution(acquire(owner, 'session-1', 'mail-owner'));
      owner.runWithExecution(handle, () => {
        expect(owner.storage.currentExecutionGeneration('session-1')).toBe('1');
        expect(() =>
          owner.agentMailInput.readPendingMailForActiveTask({ ...request, currentTaskId: 'other' }),
        ).toThrow('not active');
        expect(
          owner.agentMailInput.readPendingMailForActiveTask(request).map((mail) => mail.bodyText),
        ).toEqual(['world']);
      });
    } finally {
      owner.close();
    }
    const reopened = openOwner(fixture.path);
    try {
      const handle = reopened.bindExecution(reopened.authority.read('session-1'));
      reopened.runWithExecution(handle, () => {
        expect(
          reopened.agentMailInput
            .readPreparedMailForModel({
              sessionId: 'session-1',
              targetAgentId: 'child-1',
              currentTaskId: 'child-1',
              modelInvocationId: 'model-old',
              modelAdmissionId: 'reserve-old',
            })
            .map((mail) => mail.bodyText),
        ).toEqual(['hello']);
        expect(
          reopened.agentMailInput.readPreparedMailForModel({
            sessionId: 'session-1',
            targetAgentId: 'child-1',
            currentTaskId: 'child-1',
            modelInvocationId: 'model-old',
            modelAdmissionId: 'wrong',
          }),
        ).toEqual([]);
      });
    } finally {
      reopened.close();
      fixture.remove();
    }
  });
  test('fences unowned decisions atomically and leaves authority and effects unchanged', () => {
    const fixture = createFixture(['session-1']);
    const first = openOwner(fixture.path);
    const second = openOwner(fixture.path);
    const transaction = (revision: number) => ({
      sessionId: 'session-1',
      events: [{ type: 'policy.changed' }],
      metadata: [{ eventId: `policy-${revision}`, revision }],
      snapshot: state(revision, 'recovery-0'),
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'session-1',
          targetSessionId: 'session-1',
          commandId: `policy-${revision}`,
          requestDigest: 'a'.repeat(64),
          committedAt: Date.now(),
        },
        revision,
      ),
    });
    try {
      const idle = first.recovery.inspect('session-1');
      first.commitUnownedDecision(transaction(1), 0);
      expect(first.recovery.inspect('session-1')).toEqual(idle);
      expect(() => second.commitUnownedDecision(transaction(2), 0)).toThrow();
      expect(second.storage.sessions.loadSnapshot<State>('session-1')?.revision).toBe(1);
      const authority = acquire(first, 'session-1', 'execution-owner');
      const handle = first.bindExecution(authority);
      first.runWithExecution(handle, () => {
        expect(
          first.storage.effects.tryAcquireEffectLease(
            'session-1',
            'pending-effect',
            'effect-owner',
            Date.now() + 10000,
          ),
        ).toBe(true);
      });
      expect(() => second.commitUnownedDecision(transaction(2), 1)).toThrow();
      const active = first.authority.read('session-1');
      first.authority.release({
        sessionId: 'session-1',
        expectedRevision: active.revision,
        controllerGeneration: active.controllerGeneration,
        hostInstanceId: 'execution-owner',
        cleanupConfirmed: false,
      });
      const recovery = first.recovery.inspect('session-1');
      expect(recovery.authority.status).toBe('recovery_required');
      second.commitUnownedDecision(transaction(2), 1);
      expect(second.recovery.inspect('session-1')).toEqual(recovery);
      expect(() =>
        first.runWithExecution(handle, () =>
          first.storage.sessions.setSessionName('session-1', 'stale'),
        ),
      ).toThrow();
      expect(() =>
        first.commitUnownedDecision(
          {
            ...transaction(3),
            requiredEffectLease: {
              effectId: 'pending-effect',
              ownerId: 'effect-owner',
              observedAtMs: Date.now(),
            },
          },
          2,
        ),
      ).toThrow();
      expect(() =>
        first.commitUnownedDecision({ ...transaction(3), commandReceipt: undefined }, 2),
      ).toThrow();
      // A persistence failure rolls the event, State and receipt back and leaves no bypass scope.
      const fault = openKiteSessionStoreDatabase(fixture.path);
      fault.run(
        "CREATE TRIGGER policy_receipt_failure BEFORE INSERT ON runtime_command_receipts WHEN NEW.command_id = 'policy-3' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
      );
      try {
        expect(() => first.commitUnownedDecision(transaction(3), 2)).toThrow();
      } finally {
        fault.run('DROP TRIGGER policy_receipt_failure');
        fault.close(false);
      }
      expect(first.storage.sessions.loadSnapshot<State>('session-1')?.revision).toBe(2);
      expect(
        first.storage.commandReceipts.lookup({
          scopeSessionId: 'session-1',
          commandId: 'policy-3',
          requestDigest: 'a'.repeat(64),
        }).status,
      ).toBe('missing');
      expect(() => first.storage.sessions.setSessionName('session-1', 'unfenced')).toThrow();
      first.commitUnownedDecision(transaction(3), 2);
      expect(first.storage.sessions.loadSnapshot<State>('session-1')?.revision).toBe(3);
    } finally {
      first.close();
      second.close();
      fixture.remove();
    }
  });

  test('routes Session writes through an execution scope while reads remain lease-free', async () => {
    const fixture = createFixture(['session-1', 'session-2']);
    const first = openOwner(fixture.path);
    const second = openOwner(fixture.path);
    try {
      expect(first.directory.list()[0]?.sessions).toHaveLength(2);
      expect(() => first.storage.sessions.setSessionName('session-1', 'unfenced')).toThrow(
        KiteSessionRuntimeStorageError,
      );

      const firstAuthority = acquire(first, 'session-1', 'host-1');
      const secondAuthority = acquire(second, 'session-2', 'host-2');
      const firstHandle = first.bindExecution(firstAuthority);
      const secondHandle = second.bindExecution(secondAuthority);

      await Promise.all([
        first.runWithExecution(firstHandle, async () => {
          await Promise.resolve();
          first.storage.sessions.setSessionName('session-1', 'First');
          first.storage.sessions.setSessionModelRoute('session-1', {
            provider: 'provider-1',
            name: 'model-1',
          });
          first.storage.transactions.commitDecision({
            sessionId: 'session-1',
            events: [{ type: 'updated' }],
            metadata: [{ eventId: 'event-1', revision: 1 }],
            snapshot: state(1, 'recovery-1'),
          });
          expect(
            first.storage.recoveryIdentities.getOrCreate('session-1', () => 'a'.repeat(64)),
          ).toBe('a'.repeat(64));
          first.storage.checkpoints.saveNamedSnapshot(
            'session-1',
            'checkpoint-1',
            state(1, 'recovery-1'),
            1,
          );
        }),
        second.runWithExecution(secondHandle, async () => {
          await Promise.resolve();
          second.storage.sessions.setSessionName('session-2', 'Second');
        }),
      ]);

      expect(second.storage.sessions.listSessions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: 'session-1', name: 'First' }),
          expect.objectContaining({ threadId: 'session-2', name: 'Second' }),
        ]),
      );
      expect(firstHandle.snapshot().expectedSessionRevision).toBe(1);
      expect(first.storage.sessions.getSessionModelRoute('session-1')).toEqual({
        provider: 'provider-1',
        name: 'model-1',
      });
      expect(first.storage.checkpoints.listNamedSnapshots('session-1')).toHaveLength(1);
      expect(
        first.runWithExecution(firstHandle, () =>
          first.storage.checkpoints.forkCurrentSession(
            'session-1',
            'invalid-recovery-target',
            'b'.repeat(64),
          ),
        ),
      ).toBe(false);
      expect(() =>
        first.runWithExecution(firstHandle, () =>
          first.artifactStore.collectModelGarbage({
            complete: true,
            reachableArtifactIds: [],
            createdBeforeOrAt: Date.now(),
          }),
        ),
      ).toThrow(KiteSessionRuntimeStorageError);
    } finally {
      first.close();
      second.close();
      fixture.remove();
    }
  });

  test('fences an old connection after clean handoff and removes authority with Session delete', () => {
    const fixture = createFixture(['session-1']);
    const first = openOwner(fixture.path);
    const second = openOwner(fixture.path);
    try {
      const initial = acquire(first, 'session-1', 'host-1');
      const staleHandle = first.bindExecution(initial);
      const released = first.authority.release({
        sessionId: 'session-1',
        expectedRevision: initial.revision,
        controllerGeneration: initial.controllerGeneration,
        hostInstanceId: 'host-1',
        cleanupConfirmed: true,
      });
      const successor = second.authority.acquire({
        sessionId: 'session-1',
        expectedRevision: released.revision,
        hostInstanceId: 'host-2',
        clientId: 'client-host-2',
        connectionGeneration: 1,
        leaseUntilMs: Date.now() + 60_000,
      });
      if (successor.status !== 'acquired') throw new Error('Expected successor authority.');
      const successorHandle = second.bindExecution(successor.authority);

      expect(() =>
        first.runWithExecution(staleHandle, () =>
          first.storage.sessions.setSessionName('session-1', 'stale'),
        ),
      ).toThrow();
      second.runWithExecution(successorHandle, () => {
        second.storage.sessions.setSessionName('session-1', 'successor');
      });
      expect(first.storage.sessions.listSessions()[0]?.name).toBe('successor');
      expect(() => second.runWithExecution(staleHandle, () => undefined)).toThrow(
        KiteSessionRuntimeStorageError,
      );

      second.runWithExecution(successorHandle, () => {
        second.storage.sessions.deleteSession('session-1');
      });
      expect(second.storage.sessions.listSessions()).toEqual([]);
      expect(() => second.authority.read('session-1')).toThrow();
      expect(() => successorHandle.snapshot()).toThrow(KiteSessionRuntimeStorageError);
    } finally {
      first.close();
      second.close();
      fixture.remove();
    }
  });

  test('forks target facts and generation one in the fenced source transaction', () => {
    const fixture = createFixture(['session-1']);
    const owner = openOwner(fixture.path);
    try {
      const sourceAuthority = acquire(owner, 'session-1', 'host-fork');
      const sourceHandle = owner.bindExecution(sourceAuthority);
      owner.runWithExecution(sourceHandle, () => {
        owner.storage.transactions.commitDecision({
          sessionId: 'session-1',
          events: [{ type: 'fork.source' }],
          metadata: [{ eventId: 'fork-event-1', revision: 1 }],
          snapshot: state(1, 'a'.repeat(64)),
        });
        expect(
          owner.storage.recoveryIdentities.getOrCreate('session-1', () => 'a'.repeat(64)),
        ).toBe('a'.repeat(64));
        expect(
          owner.storage.checkpoints.forkCurrentSession('session-1', 'session-fork', 'b'.repeat(64)),
        ).toBe(true);
      });

      const targetAuthority = owner.authority.read('session-fork');
      expect(targetAuthority).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
        hostInstanceId: 'host-fork',
        clientId: 'client-host-fork',
        connectionGeneration: 1,
        leaseUntilMs: sourceAuthority.leaseUntilMs,
      });
      const targetHandle = owner.bindExecution(targetAuthority);
      owner.runWithExecution(targetHandle, () => {
        owner.storage.sessions.setSessionName('session-fork', 'Fork');
      });
      expect(owner.storage.sessions.listSessions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: 'session-fork', name: 'Fork' }),
        ]),
      );
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('rolls back a fork target and its authority when later copy work fails', () => {
    const fixture = createFixture(['session-1']);
    const owner = openOwner(fixture.path, { failHistoricalEncoding: true });
    try {
      const sourceAuthority = acquire(owner, 'session-1', 'host-fork-fault');
      const sourceHandle = owner.bindExecution(sourceAuthority);
      owner.runWithExecution(sourceHandle, () => {
        owner.storage.transactions.commitDecision({
          sessionId: 'session-1',
          events: [{ type: 'fork.source' }],
          metadata: [{ eventId: 'fork-event-fault', revision: 1 }],
          snapshot: state(1, 'c'.repeat(64)),
        });
        expect(
          owner.storage.recoveryIdentities.getOrCreate('session-1', () => 'c'.repeat(64)),
        ).toBe('c'.repeat(64));
        expect(() =>
          owner.storage.checkpoints.forkCurrentSession(
            'session-1',
            'session-fork-fault',
            'd'.repeat(64),
          ),
        ).toThrow();
      });
      expect(owner.storage.sessions.loadSnapshot('session-fork-fault')).toBeNull();
      expect(() => owner.authority.read('session-fork-fault')).toThrow();
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('allows real App Server processes to write different Sessions but only one to write the same Session', async () => {
    const different = createFixture(['session-1', 'session-2']);
    const child = join(import.meta.dir, '..', 'fixtures', 'mutate-kite-session-runtime-child.ts');
    try {
      const results = await runMutationChildren(child, different.path, [
        ['session-1', 'host-1', 'First'],
        ['session-2', 'host-2', 'Second'],
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['written', 'written']);
      const reader = openOwner(different.path);
      expect(reader.storage.sessions.listSessions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: 'session-1', name: 'First' }),
          expect.objectContaining({ threadId: 'session-2', name: 'Second' }),
        ]),
      );
      reader.close();
    } finally {
      different.remove();
    }

    const same = createFixture(['session-1']);
    try {
      const results = await runMutationChildren(child, same.path, [
        ['session-1', 'host-1', 'Winner 1'],
        ['session-1', 'host-2', 'Winner 2'],
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        'revision_conflict',
        'written',
      ]);
      const reader = openOwner(same.path);
      expect(reader.storage.sessions.listSessions()[0]?.name).toMatch(/^Winner [12]$/u);
      reader.close();
    } finally {
      same.remove();
    }
  });

  test('validates each Session read from one stable SQLite snapshot while another writer commits', () => {
    const fixture = createFixture(['session-1', 'session-2']);
    const writer = openOwner(fixture.path);
    try {
      const authority = acquire(writer, 'session-2', 'host-validation-writer');
      const handle = writer.bindExecution(authority);
      let mutated = false;
      const reader = openOwner(fixture.path, {
        onSessionIdentity: () => {
          if (mutated) return;
          mutated = true;
          writer.runWithExecution(handle, () => {
            writer.storage.transactions.commitDecision({
              sessionId: 'session-2',
              events: [{ type: 'validation.concurrent' }],
              metadata: [{ eventId: 'validation-event-1', revision: 1 }],
              snapshot: state(1, 'f'.repeat(64)),
            });
          });
        },
      });
      try {
        expect(mutated).toBe(false);
        expect(reader.storage.sessions.loadSnapshot<State>('session-2')?.revision).toBe(0);
        expect(mutated).toBe(true);
        expect(reader.storage.sessions.loadSnapshot<State>('session-2')?.revision).toBe(1);
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
      fixture.remove();
    }
  });

  test('settles effect receipt in the State transaction and fences release without a receipt as unknown', () => {
    const fixture = createFixture(['session-1']);
    const owner = openOwner(fixture.path);
    try {
      const authority = acquire(owner, 'session-1', 'host-1');
      const handle = owner.bindExecution(authority);
      owner.runWithExecution(handle, () => {
        expect(
          owner.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-settled',
            'owner-1',
            Date.now() + 60_000,
          ),
        ).toBe(true);
        owner.storage.transactions.commitReceiptEvidence({
          sessionId: 'session-1',
          events: [{ type: 'effect.settled' }],
          metadata: [{ eventId: 'effect-event-1', revision: 1 }],
          snapshot: state(1, 'recovery-1'),
          requiredEffectLease: {
            effectId: 'effect-settled',
            ownerId: 'owner-1',
            observedAtMs: Date.now(),
          },
        });
        owner.storage.effects.releaseEffectLease('session-1', 'effect-settled', 'owner-1');

        expect(
          owner.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-unknown',
            'owner-2',
            Date.now() + 60_000,
          ),
        ).toBe(true);
        expect(() =>
          owner.authority.release({
            sessionId: 'session-1',
            expectedRevision: authority.revision,
            controllerGeneration: authority.controllerGeneration,
            hostInstanceId: 'host-1',
            cleanupConfirmed: true,
          }),
        ).toThrow();
        expect(owner.authority.read('session-1').status).toBe('active');
        owner.storage.effects.releaseEffectLease('session-1', 'effect-unknown', 'owner-2');
      });
      expect(owner.authority.read('session-1')).toMatchObject({
        status: 'recovery_required',
        cleanupConfirmed: false,
      });
    } finally {
      owner.close();
    }

    const database = openKiteSessionStoreDatabase(fixture.path);
    try {
      expect(
        database
          .query<{ state: string; outcome: string }, [string]>(
            'SELECT state, outcome FROM runtime_effect_leases WHERE effect_id = ?',
          )
          .get('effect-settled'),
      ).toEqual({ state: 'terminal', outcome: 'settled' });
      expect(
        database
          .query<{ state: string; outcome: string }, [string]>(
            'SELECT state, outcome FROM runtime_effect_leases WHERE effect_id = ?',
          )
          .get('effect-unknown'),
      ).toEqual({ state: 'unknown', outcome: 'unknown' });
    } finally {
      database.close(false);
      fixture.remove();
    }
  });

  test('reconciles a crashed generation prepared effect as unknown before takeover', () => {
    const fixture = createFixture(['session-1']);
    let now = 100;
    const crashed = openOwner(fixture.path, { now: () => now });
    const initial = crashed.authority.acquire({
      sessionId: 'session-1',
      expectedRevision: 0,
      hostInstanceId: 'host-crashed',
      clientId: 'client-crashed',
      connectionGeneration: 1,
      leaseUntilMs: 200,
    });
    if (initial.status !== 'acquired') throw new Error('Expected initial crash authority.');
    const crashedHandle = crashed.bindExecution(initial.authority);
    crashed.runWithExecution(crashedHandle, () => {
      expect(
        crashed.storage.effects.tryAcquireEffectLease(
          'session-1',
          'effect-crashed',
          'owner-crashed',
          190,
        ),
      ).toBe(true);
    });
    crashed.close();

    now = 201;
    const successor = openOwner(fixture.path, { now: () => now });
    try {
      const blocked = successor.authority.acquire({
        sessionId: 'session-1',
        expectedRevision: initial.authority.revision,
        hostInstanceId: 'host-successor',
        clientId: 'client-successor',
        connectionGeneration: 1,
        leaseUntilMs: 300,
      });
      expect(blocked).toMatchObject({
        status: 'recovery_required',
        authority: { controllerGeneration: 2, revision: 2 },
      });
      if (blocked.status !== 'recovery_required') throw new Error('Expected recovery fence.');
      expect(successor.recovery.inspect('session-1').pendingEffects).toEqual([
        expect.objectContaining({ effectId: 'effect-crashed', state: 'prepared' }),
      ]);

      const reconciled = successor.recovery.reconcile({
        sessionId: 'session-1',
        expectedAuthorityRevision: blocked.authority.revision,
      });
      expect(reconciled).toMatchObject({
        authority: { status: 'idle', controllerGeneration: 3, revision: 3 },
        unknownEffects: [{ effectId: 'effect-crashed', state: 'unknown', outcome: 'unknown' }],
      });
      expect(successor.recovery.inspect('session-1').pendingEffects).toEqual([]);
      expect(
        successor.authority.acquire({
          sessionId: 'session-1',
          expectedRevision: reconciled.authority.revision,
          hostInstanceId: 'host-successor',
          clientId: 'client-successor',
          connectionGeneration: 1,
          leaseUntilMs: 300,
        }),
      ).toMatchObject({
        status: 'acquired',
        authority: { controllerGeneration: 4, revision: 4 },
      });
    } finally {
      successor.close();
      fixture.remove();
    }
  });

  test('leases a fenced recovery generation without replaying an old prepared effect', () => {
    const fixture = createFixture(['session-1']);
    let now = 100;
    const oldOwner = openOwner(fixture.path, { now: () => now });
    const first = oldOwner.authority.acquire({
      sessionId: 'session-1',
      expectedRevision: 0,
      hostInstanceId: 'host-old',
      clientId: 'client-old',
      connectionGeneration: 1,
      leaseUntilMs: 200,
    });
    if (first.status !== 'acquired') throw new Error('Expected first execution authority.');
    const oldHandle = oldOwner.bindExecution(first.authority);
    oldOwner.runWithExecution(oldHandle, () => {
      expect(
        oldOwner.storage.effects.tryAcquireEffectLease('session-1', 'effect-old', 'owner-old', 190),
      ).toBe(true);
    });
    const successor = openOwner(fixture.path, { now: () => now });
    const recoveryRequest = {
      sessionId: 'session-1',
      expectedAuthorityRevision: first.authority.revision,
      hostInstanceId: 'host-new',
      clientId: 'client-new',
      connectionGeneration: 1,
      leaseUntilMs: 300,
    };
    try {
      expect(() => successor.beginRecoveryExecution(recoveryRequest)).toThrow();
      expect(successor.authority.read('session-1')).toEqual(first.authority);
      now = 201;
      const fenced = successor.authority.acquire({
        sessionId: 'session-1',
        expectedRevision: first.authority.revision,
        hostInstanceId: 'host-new',
        clientId: 'client-new',
        connectionGeneration: 1,
        leaseUntilMs: 300,
      });
      if (fenced.status !== 'recovery_required') throw new Error('Expected expired fence.');
      const recovered = successor.beginRecoveryExecution({
        ...recoveryRequest,
        expectedAuthorityRevision: fenced.authority.revision,
      });
      expect(recovered).toMatchObject({
        status: 'active',
        controllerGeneration: fenced.authority.controllerGeneration + 1,
        cleanupConfirmed: false,
        hostInstanceId: 'host-new',
      });
      expect(successor.recovery.inspect('session-1')).toMatchObject({
        pendingEffects: [],
        unknownEffects: [{ effectId: 'effect-old', state: 'unknown', outcome: 'unknown' }],
      });
      expect(() =>
        successor.beginRecoveryExecution({
          ...recoveryRequest,
          expectedAuthorityRevision: fenced.authority.revision,
        }),
      ).toThrow();
      expect(successor.authority.read('session-1')).toEqual(recovered);
      expect(() =>
        oldOwner.runWithExecution(oldHandle, () =>
          oldOwner.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-late',
            'owner-old',
            250,
          ),
        ),
      ).toThrow();
      const recoveryHandle = successor.bindExecution(recovered);
      successor.runWithExecution(recoveryHandle, () => {
        expect(successor.storage.sessions.loadSnapshot<State>('session-1')).not.toBeNull();
        expect(() =>
          successor.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-forbidden',
            'owner-new',
            290,
          ),
        ).toThrow('Recovery execution cannot dispatch a new effect.');
        expect(() =>
          successor.storage.transactions.commitAttemptStart({
            sessionId: 'session-1',
            events: [],
            snapshot: state(0, 'recovery-0'),
          }),
        ).toThrow('Recovery execution cannot start a new attempt.');
      });
      expect(successor.recovery.inspect('session-1').pendingEffects).toEqual([]);
      const released = successor.authority.release({
        sessionId: 'session-1',
        expectedRevision: recovered.revision,
        controllerGeneration: recovered.controllerGeneration,
        hostInstanceId: 'host-new',
        cleanupConfirmed: false,
      });
      expect(released).toMatchObject({ status: 'recovery_required', cleanupConfirmed: false });
      expect(successor.recovery.inspect('session-1').unknownEffects).toHaveLength(1);
    } finally {
      successor.close();
      oldOwner.close();
      fixture.remove();
    }
  });

  test('a legacy recovery fence with no previous execution generation can be claimed', () => {
    const fixture = createFixture(['session-1']);
    const seed = openOwner(fixture.path);
    const initial = seed.authority.read('session-1');
    seed.close();
    const database = openKiteSessionStoreDatabase(fixture.path);
    database.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)').run(
      'session_execution/session-1',
      JSON.stringify({
        ...initial,
        schema: KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA,
        status: 'recovery_required',
        controllerGeneration: 1,
        cleanupConfirmed: false,
        revision: 1,
      }),
    );
    database.close(false);
    const owner = openOwner(fixture.path);
    try {
      const recovery = owner.beginRecoveryExecution({
        sessionId: 'session-1',
        expectedAuthorityRevision: 1,
        hostInstanceId: 'host-new',
        clientId: 'client-new',
        connectionGeneration: 1,
        leaseUntilMs: Date.now() + 30_000,
      });
      expect(recovery).toMatchObject({
        status: 'active',
        controllerGeneration: 2,
        cleanupConfirmed: false,
      });
      const recoveryHandle = owner.bindExecution(recovery);
      owner.runWithExecution(recoveryHandle, () => {
        expect(() =>
          owner.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-forbidden',
            'owner-new',
            Date.now() + 1_000,
          ),
        ).toThrow('Recovery execution cannot dispatch a new effect.');
      });
      const idle = owner.authority.release({
        sessionId: 'session-1',
        expectedRevision: recovery.revision,
        controllerGeneration: recovery.controllerGeneration,
        hostInstanceId: 'host-new',
        cleanupConfirmed: true,
      });
      const normal = owner.authority.acquire({
        sessionId: 'session-1',
        expectedRevision: idle.revision,
        hostInstanceId: 'host-normal',
        clientId: 'client-normal',
        connectionGeneration: 1,
        leaseUntilMs: Date.now() + 30_000,
      });
      if (normal.status !== 'acquired') throw new Error('Expected normal execution.');
      const normalHandle = owner.bindExecution(normal.authority);
      owner.runWithExecution(normalHandle, () => {
        expect(
          owner.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-normal',
            'owner-normal',
            Date.now() + 1_000,
          ),
        ).toBe(true);
      });
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('persists recovery_required and no-replay evidence after a real SIGKILL', async () => {
    const fixture = createFixture(['session-1']);
    const childPath = join(import.meta.dir, '..', 'fixtures', 'crash-kite-session-effect-child.ts');
    const child = Bun.spawn([process.execPath, childPath, fixture.path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const ready = await readFirstJsonLine<{ readonly leaseUntilMs: number }>(child.stdout);
      child.kill('SIGKILL');
      await child.exited;
      await Bun.sleep(Math.max(0, ready.leaseUntilMs - Date.now() + 20));

      const successor = openOwner(fixture.path);
      try {
        const blocked = successor.authority.acquire({
          sessionId: 'session-1',
          expectedRevision: 1,
          hostInstanceId: 'host-after-sigkill',
          clientId: 'client-after-sigkill',
          connectionGeneration: 1,
          leaseUntilMs: Date.now() + 60_000,
        });
        expect(blocked).toMatchObject({
          status: 'recovery_required',
          authority: { controllerGeneration: 2, revision: 2 },
        });
        if (blocked.status !== 'recovery_required') throw new Error('Expected recovery fence.');
        expect(successor.recovery.inspect('session-1').pendingEffects).toEqual([
          expect.objectContaining({ effectId: 'effect-sigkill', state: 'prepared' }),
        ]);
        successor.recovery.reconcile({
          sessionId: 'session-1',
          expectedAuthorityRevision: blocked.authority.revision,
        });
      } finally {
        successor.close();
      }

      const database = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(
          database
            .query<{ state: string; outcome: string }, [string]>(
              'SELECT state, outcome FROM runtime_effect_leases WHERE effect_id = ?',
            )
            .get('effect-sigkill'),
        ).toEqual({ state: 'unknown', outcome: 'unknown' });
      } finally {
        database.close(false);
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      fixture.remove();
    }
  });

  test('atomically creates Session facts, recovery identity, command receipt and generation one', () => {
    const fixture = createFixture([]);
    const owner = openOwner(fixture.path);
    try {
      const creation = owner.sessionCreationForWorkspace(WORKSPACE_ID);
      const input = creationInput('created-session', 'a', Date.now() + 60_000);
      expect(creation.create(input)).toMatchObject({
        status: 'applied',
        runtimeReceipt: { committedRevision: 0 },
        controller: {
          status: 'applied',
          lease: { sessionId: 'created-session', controllerGeneration: 1 },
        },
      });
      expect(creation.create(input)).toMatchObject({
        status: 'replay',
        controller: { status: 'replay' },
      });
      const authority = owner.authority.read('created-session');
      expect(authority).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
        hostInstanceId: 'host-create',
      });
      const handle = owner.bindExecution(authority);
      owner.runWithExecution(handle, () => {
        owner.storage.sessions.setSessionName('created-session', 'Created');
      });
      expect(owner.storage.recoveryIdentities.read('created-session')).toBe('e'.repeat(64));

      expect(() =>
        creation.create(creationInput('rollback-session', 'b', Date.now() - 1)),
      ).toThrow();
      expect(owner.storage.sessions.loadSnapshot('rollback-session')).toBeNull();
      expect(() => owner.authority.read('rollback-session')).toThrow();
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('durably fences new Session insertion during Workspace deletion and releases by token', () => {
    const fixture = createFixture([]);
    const deleting = openOwner(fixture.path);
    const creating = openOwner(fixture.path);
    try {
      expect(creating.getAdmittedWorkspace(WORKSPACE_ID)).toMatchObject({
        workspaceId: WORKSPACE_ID,
        canonicalPath: WORKSPACE_PATH,
      });
      expect(creating.getAdmittedWorkspace(`workspace_${'0'.repeat(64)}`)).toBeNull();
      expect(creating.getAdmittedWorkspaceByDigest(WORKSPACE_DIGEST)).toMatchObject({
        workspaceId: WORKSPACE_ID,
        canonicalPath: WORKSPACE_PATH,
      });
      expect(creating.getAdmittedWorkspaceByDigest(`sha256:${'0'.repeat(64)}`)).toBeNull();
      expect(deleting.workspaceDeletion.begin(WORKSPACE_ID, 'first-remove', 'first-claim')).toBe(
        'acquired',
      );
      expect(creating.workspaceDeletion.isActive(WORKSPACE_ID)).toBe(true);
      expect(creating.workspaceDeletion.owns(WORKSPACE_ID, 'first-claim')).toBe(true);
      expect(() =>
        creating
          .sessionCreationForWorkspace(WORKSPACE_ID)
          .create(creationInput('blocked-session', 'a', Date.now() + 60_000)),
      ).toThrow();
      expect(creating.storage.sessions.loadSnapshot('blocked-session')).toBeNull();
      expect(() =>
        creating.workspaceDeletion.begin(WORKSPACE_ID, 'retry-remove', 'retry-claim'),
      ).toThrow();
      expect(() =>
        creating.workspaceDeletion.begin(WORKSPACE_ID, 'first-remove', 'retry-claim'),
      ).toThrow();
      expect(() => deleting.workspaceDeletion.end(WORKSPACE_ID, 'first-remove')).toThrow();
      deleting.workspaceDeletion.complete(WORKSPACE_ID, 'first-claim');
      expect(deleting.workspaceDeletion.owns(WORKSPACE_ID, 'first-claim')).toBe(false);
      expect(creating.workspaceDeletion.begin(WORKSPACE_ID, 'retry-remove', 'retry-claim')).toBe(
        'completed',
      );
      expect(() => deleting.workspaceDeletion.end(WORKSPACE_ID, 'first-remove')).toThrow();
      creating.workspaceDeletion.end(WORKSPACE_ID, 'retry-remove');
      expect(deleting.workspaceDeletion.isActive(WORKSPACE_ID)).toBe(false);
      expect(deleting.workspaceDeletion.owns(WORKSPACE_ID, 'retry-remove')).toBe(false);
      expect(
        creating
          .sessionCreationForWorkspace(WORKSPACE_ID)
          .create(creationInput('created-session', 'b', Date.now() + 60_000)).status,
      ).toBe('applied');
    } finally {
      creating.close();
      deleting.close();
      fixture.remove();
    }
  });

  test('recovers a Workspace fence when its Store owner closed in the same process', () => {
    const fixture = createFixture([]);
    const oldOwner = openOwner(fixture.path);
    try {
      expect(oldOwner.workspaceDeletion.begin(WORKSPACE_ID, 'old-token', 'old-claim')).toBe(
        'acquired',
      );
    } finally {
      oldOwner.close();
    }
    const nextOwner = openOwner(fixture.path);
    try {
      expect(nextOwner.workspaceDeletion.begin(WORKSPACE_ID, 'new-token', 'new-claim')).toBe(
        'acquired',
      );
      expect(nextOwner.workspaceDeletion.owns(WORKSPACE_ID, 'new-claim')).toBe(true);
      nextOwner.workspaceDeletion.complete(WORKSPACE_ID, 'new-claim');
      nextOwner.workspaceDeletion.end(WORKSPACE_ID, 'new-token');
      expect(nextOwner.workspaceDeletion.isActive(WORKSPACE_ID)).toBe(false);
    } finally {
      nextOwner.close();
      fixture.remove();
    }
  });

  test('does not replace an invalid persisted Workspace deletion fence', () => {
    const fixture = createFixture([]);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
        .run(`workspace_deletion:${WORKSPACE_ID}`, '{invalid');
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      expect(owner.workspaceDeletion.isActive(WORKSPACE_ID)).toBe(true);
      expect(() => owner.workspaceDeletion.begin(WORKSPACE_ID, 'new-token', 'new-claim')).toThrow();
      expect(() => owner.workspaceDeletion.end(WORKSPACE_ID, 'new-token')).toThrow();
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('rejects ambiguous persisted Workspace digests', () => {
    const fixture = createFixture([]);
    const seed = openKiteSessionStoreDatabase(fixture.path);
    try {
      seed
        .query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,
        project_id,workspace_digest,display_name,created_at,updated_at)
        VALUES (?,?,?,?,?,'Other',1,1)`)
        .run(
          `workspace_${'9'.repeat(64)}`,
          '/other-workspace',
          `sha256:${'9'.repeat(64)}`,
          `project_${'9'.repeat(64)}`,
          WORKSPACE_DIGEST,
        );
    } finally {
      seed.close(false);
    }
    const owner = openOwner(fixture.path);
    try {
      expect(() => owner.getAdmittedWorkspaceByDigest(WORKSPACE_DIGEST)).toThrow(
        'Workspace digest is ambiguous.',
      );
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('creates the root Agent in the same first Session transaction', () => {
    const fixture = createFixture([]);
    const owner = openOwner(fixture.path);
    try {
      const input = creationInput('root-session', 'c', Date.now() + 60_000);
      expect(owner.sessionCreationForWorkspace(WORKSPACE_ID).create(input).status).toBe('applied');
      expect(owner.readChildSessionIntent('missing-child')).toBeNull();
      expect(owner.listPendingChildSessionIntents('root-session', 10)).toEqual({ entries: [] });
      expect(() => owner.readChildSealedGrant('missing-child')).toThrow('execution scope');
      const rootHandle = owner.bindExecution(owner.authority.read('root-session'));
      owner.runWithExecution(rootHandle, () => {
        expect(owner.readChildSealedGrant('missing-child')).toBeNull();
      });
      expect(
        owner.agentMailbox.readAgent('root-session', 'root-session', 'root-session'),
      ).toMatchObject({
        agentId: 'root-session',
        status: 'idle',
        mailRevision: 0,
      });
      const reopened = openOwner(fixture.path);
      try {
        expect(reopened.agentMailbox.nextSequence('root-session', 'root-session')).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      owner.close();
      fixture.remove();
    }
  });
});

function openOwner(
  path: string,
  options?: {
    readonly failHistoricalEncoding?: boolean;
    readonly now?: () => number;
    readonly onSessionIdentity?: () => void;
  },
) {
  const selectedCodec = {
    ...codec,
    ...(options?.failHistoricalEncoding
      ? {
          encodeHistoricalEvent: () => {
            throw new Error('injected historical encode fault');
          },
        }
      : {}),
    sessionIdentity: (value: State) => {
      options?.onSessionIdentity?.();
      return codec.sessionIdentity(value);
    },
  };
  return openKiteSessionRuntimeStorage<Event, State>({
    databasePath: path,
    codec: selectedCodec,
    stateSchemaVersion: 1,
    formatEpoch: STATE_EPOCH,
    ...(options?.now ? { now: options.now } : {}),
  });
}

function acquire(owner: ReturnType<typeof openOwner>, sessionId: string, hostInstanceId: string) {
  const result = owner.authority.acquire({
    sessionId,
    expectedRevision: 0,
    hostInstanceId,
    clientId: `client-${hostInstanceId}`,
    connectionGeneration: 1,
    leaseUntilMs: Date.now() + 60_000,
  });
  if (result.status !== 'acquired') throw new Error('Expected Session authority.');
  return result.authority;
}

function state(revision: number, recoveryIdentity: string): State {
  return {
    revision,
    recoveryIdentity,
    session: { projectId: PROJECT_ID, canonicalWorkspaceDigest: WORKSPACE_DIGEST },
  };
}

function creationInput(sessionId: string, digestSeed: string, executionLeaseUntilMs: number) {
  return {
    runtime: {
      sessionId,
      events: [],
      snapshot: state(0, 'e'.repeat(64)),
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: sessionId,
          commandId: `command-${digestSeed}`,
          requestDigest: digestSeed.repeat(64),
          targetSessionId: sessionId,
          committedAt: Date.now(),
        },
        0,
      ),
    },
    controller: {
      sessionId,
      requestId: `controller-${digestSeed}`,
      requestDigest: digestSeed.repeat(64),
      clientId: 'client-create',
      connectionGeneration: 1,
      workerInstanceId: 'host-create',
      resumeSecret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'),
      resumeExpiresAtMs: Date.now() + 60_000,
      executionLeaseUntilMs,
    },
    recoveryIdentity: 'e'.repeat(64),
  } as const;
}

function createFixture(sessionIds: readonly string[]) {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-session-runtime-storage-')),
  );
  const path = join(root, 'kite-session.sqlite');
  const database = openKiteSessionStoreDatabase(path);
  database
    .query(
      `INSERT INTO workspaces(
        workspace_id, canonical_path, workspace_identity_digest, project_id, workspace_digest,
        display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Workspace', 1, 1)`,
    )
    .run(WORKSPACE_ID, WORKSPACE_PATH, WORKSPACE_IDENTITY_DIGEST, PROJECT_ID, WORKSPACE_DIGEST);
  const insertSession = database.query(
    `INSERT INTO runtime_sessions(
      session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
      revision, name, updated_at, run_index_from_revision
    ) VALUES (?, ?, ?, ?, 1, ?, 0, '', 1, 0)`,
  );
  const insertSnapshot = database.query(
    `INSERT INTO runtime_snapshots(
      session_id, schema_version, format_epoch, revision, state_json, event_position,
      state_checksum, created_at
    ) VALUES (?, 1, ?, 0, ?, 0, ?, 1)`,
  );
  for (const [index, sessionId] of sessionIds.entries()) {
    insertSession.run(sessionId, WORKSPACE_ID, PROJECT_ID, WORKSPACE_DIGEST, STATE_EPOCH);
    const json = JSON.stringify(state(0, `recovery-${index}`));
    insertSnapshot.run(sessionId, STATE_EPOCH, json, checksum(json));
  }
  database.close(false);
  return {
    path,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function runMutationChildren(
  childPath: string,
  databasePath: string,
  inputs: readonly (readonly [sessionId: string, hostId: string, name: string])[],
): Promise<Array<{ readonly status: string }>> {
  const startAt = Date.now() + 250;
  const children = inputs.map(([sessionId, hostId, name]) =>
    Bun.spawn(
      [process.execPath, childPath, databasePath, sessionId, hostId, name, String(startAt)],
      { stdout: 'pipe', stderr: 'pipe' },
    ),
  );
  return Promise.all(children.map(readChild));
}

async function readChild(
  child: Subprocess<'ignore', 'pipe', 'pipe'>,
): Promise<{ readonly status: string }> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout) as { readonly status: string };
}

async function readFirstJsonLine<Result>(stream: ReadableStream<Uint8Array>): Promise<Result> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Child exited before readiness evidence.');
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf('\n');
      if (newline >= 0) return JSON.parse(buffered.slice(0, newline)) as Result;
    }
  } finally {
    reader.releaseLock();
  }
}

test('settled reconciliation checks authority, State, Runs, and effects in one writer transaction', () => {
  const fixture = createFixture(['session-1']);
  const seed = openOwner(fixture.path);
  const initial = seed.authority.read('session-1');
  seed.close();
  const database = openKiteSessionStoreDatabase(fixture.path);
  database.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)').run(
    'session_execution/session-1',
    JSON.stringify({
      ...initial,
      schema: KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA,
      status: 'recovery_required',
      controllerGeneration: 1,
      cleanupConfirmed: false,
      revision: 1,
    }),
  );
  const settledJson = JSON.stringify(state(1, 'recovery-0'));
  database.query('UPDATE runtime_sessions SET revision=1 WHERE session_id=?').run('session-1');
  database
    .query(
      'UPDATE runtime_snapshots SET revision=1, state_json=?, state_checksum=? WHERE session_id=?',
    )
    .run(settledJson, checksum(settledJson), 'session-1');
  database.close(false);
  const owner = openOwner(fixture.path);
  const request = {
    sessionId: 'session-1',
    expectedAuthorityRevision: 1,
    isSettledState: (snapshot: Readonly<State>) => snapshot.revision === 1,
  };
  const write = (sql: string, ...parameters: (string | number)[]) => {
    const connection = openKiteSessionStoreDatabase(fixture.path);
    try {
      connection.query(sql).run(...parameters);
    } finally {
      connection.close(false);
    }
  };
  try {
    const before = owner.recovery.inspect('session-1');
    expect(owner.reconcileSettledSession({ ...request, expectedAuthorityRevision: 0 })).toBe(false);
    expect(owner.reconcileSettledSession({ ...request, isSettledState: () => false })).toBe(false);
    expect(owner.recovery.inspect('session-1')).toEqual(before);

    write(
      `INSERT INTO runtime_runs(
        session_id, run_id, start_command_id, phase, status,
        created_revision, last_revision, created_at_ms
      ) VALUES (?, ?, ?, 'building', 'queued', 1, 1, 1)`,
      'session-1',
      'run-active',
      'start-active',
    );
    expect(owner.reconcileSettledSession(request)).toBe(false);
    write('DELETE FROM runtime_runs WHERE session_id=?', 'session-1');

    write(
      `INSERT INTO runtime_runs(
        session_id, run_id, start_command_id, phase, status,
        created_revision, last_revision, created_at_ms, started_at_ms,
        finished_at_ms, terminal_json
      ) VALUES (?, ?, ?, 'building', 'unknown', 1, 1, 1, 1, 2, ?)`,
      'session-1',
      'run-unknown',
      'start-unknown',
      encodeRuntimeRunTerminal({
        reasonCode: 'recovery_required',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      }),
    );
    expect(owner.reconcileSettledSession(request)).toBe(false);
    write('DELETE FROM runtime_runs WHERE session_id=?', 'session-1');

    write(
      `INSERT INTO runtime_effect_leases(
        session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms,
        controller_generation, host_instance_id, client_id, connection_generation,
        state, outcome, terminal_digest, updated_at
      ) VALUES (?, ?, ?, 1, 'certain', 100, 1, 'old-host', 'old-client', 1,
        'prepared', NULL, NULL, 1)`,
      'session-1',
      'effect-1',
      'old-owner',
    );
    expect(owner.reconcileSettledSession(request)).toBe(false);
    write(
      `UPDATE runtime_effect_leases SET state='unknown', outcome='unknown',
       certainty='uncertain' WHERE session_id=?`,
      'session-1',
    );
    expect(owner.reconcileSettledSession(request)).toBe(false);
    write('DELETE FROM runtime_effect_leases WHERE session_id=?', 'session-1');

    expect(owner.reconcileSettledSession(request)).toBe(true);
    expect(owner.recovery.inspect('session-1')).toMatchObject({
      authority: { status: 'idle', controllerGeneration: 2, cleanupConfirmed: true, revision: 2 },
      pendingEffects: [],
      unknownEffects: [],
    });
    expect(owner.storage.sessions.loadSnapshot<State>('session-1')).toEqual(state(1, 'recovery-0'));
    expect(owner.reconcileSettledSession(request)).toBe(false);
  } finally {
    owner.close();
    fixture.remove();
  }
});

test('recovery command is atomic with its receipt and requires real cleanup confirmation', () => {
  const fixture = createFixture(['session-1']);
  const owner = openOwner(fixture.path);
  try {
    const current = acquire(owner, 'session-1', 'old-owner');
    owner.authority.release({
      sessionId: 'session-1',
      expectedRevision: current.revision,
      controllerGeneration: current.controllerGeneration,
      hostInstanceId: 'old-owner',
      cleanupConfirmed: false,
    });
    const before = owner.recovery.inspect('session-1');
    const evidence = {
      scopeSessionId: 'session-1',
      targetSessionId: 'session-1',
      commandId: 'recover-command',
      requestDigest: 'b'.repeat(64),
      committedAt: Date.now(),
    };
    const transaction = {
      sessionId: 'session-1',
      snapshot: owner.storage.sessions.loadSnapshot<State>('session-1')!,
      events: [],
      commandReceipt: createRuntimeStoredCommandReceipt(evidence, 0),
    };
    expect(() => owner.commitRecoveryDecision(transaction, 0, before.authority.revision)).toThrow();
    expect(owner.recovery.inspect('session-1')).toEqual(before);
    owner.recovery.confirmCleanup({
      sessionId: 'session-1',
      expectedAuthorityRevision: before.authority.revision,
    });
    const confirmed = owner.recovery.inspect('session-1');
    expect(confirmed.authority.status).toBe('recovery_required');
    expect(confirmed.authority.controllerGeneration).toBe(before.authority.controllerGeneration);
    expect(() => owner.commitRecoveryDecision(transaction, 0, before.authority.revision)).toThrow();
    expect(() =>
      owner.commitRecoveryDecision(
        { ...transaction, commandReceipt: undefined },
        0,
        confirmed.authority.revision,
      ),
    ).toThrow();
    expect(owner.recovery.inspect('session-1')).toEqual(confirmed);
    owner.commitRecoveryDecision(transaction, 0, confirmed.authority.revision);
    expect(owner.recovery.inspect('session-1').authority.status).toBe('idle');
    expect(owner.storage.commandReceipts.lookup(evidence).status).toBe('replay');
    expect(owner.storage.sessions.loadSnapshot<State>('session-1')).toEqual(transaction.snapshot);
  } finally {
    owner.close();
    fixture.remove();
  }
});

test.skipIf(process.platform === 'win32')(
  'real Store owners hold maintenance admission until all connections close',
  () => {
    const fixture = createFixture([]);
    const open = () =>
      openKiteSessionRuntimeStorage({
        databasePath: fixture.path,
        codec,
        stateSchemaVersion: 1,
        formatEpoch: STATE_EPOCH,
      });
    try {
      const first = open();
      const second = open();
      expect(() => acquireKiteSessionStoreMaintenance(fixture.path, 'exclusive')).toThrow('busy');
      first.close();
      expect(() => acquireKiteSessionStoreMaintenance(fixture.path, 'exclusive')).toThrow('busy');
      second.close();
      const maintenance = acquireKiteSessionStoreMaintenance(fixture.path, 'exclusive');
      expect(open).toThrow('busy');
      maintenance.release();
      const reopened = open();
      reopened.close();
    } finally {
      fixture.remove();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'first-release session-only reset requires a stopped owner and preserves profile configuration',
  () => {
    const fixture = createFixture(['session-1']);
    const configPath = join(dirname(fixture.path), 'kite-code.jsonc');
    const config = '{"provider":"configured"}\n';
    writeFileSync(configPath, config, { mode: 0o600 });
    const open = () => openOwner(fixture.path);
    try {
      const liveOwner = open();
      expect(() => acquireKiteSessionStoreMaintenance(fixture.path, 'exclusive')).toThrow('busy');
      liveOwner.close();

      const maintenance = acquireKiteSessionStoreMaintenance(fixture.path, 'exclusive');
      try {
        for (const suffix of ['', '-wal', '-shm'])
          rmSync(`${fixture.path}${suffix}`, { force: true });
        expect(open).toThrow('busy');
      } finally {
        maintenance.release();
      }

      const freshOwner = open();
      try {
        const database = openKiteSessionStoreDatabase(fixture.path);
        try {
          expect(
            database
              .query<{ count: number }, []>('SELECT count(*) AS count FROM runtime_sessions')
              .get(),
          ).toEqual({ count: 0 });
          expect(
            database
              .query<{ value: string }, []>(
                "SELECT value FROM kite_meta WHERE key = 'format_epoch'",
              )
              .get(),
          ).toEqual({ value: KITE_SESSION_STORE_FORMAT_EPOCH });
        } finally {
          database.close(false);
        }
      } finally {
        freshOwner.close();
      }
      expect(readFileSync(configPath, 'utf8')).toBe(config);
      expect(existsSync(`${fixture.path}.maintenance.lock`)).toBe(true);
    } finally {
      fixture.remove();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'failed Store composition releases its shared maintenance admission',
  () => {
    const fixture = createFixture([]);
    try {
      expect(() =>
        openKiteSessionRuntimeStorage({
          databasePath: fixture.path,
          codec,
          stateSchemaVersion: -1,
          formatEpoch: STATE_EPOCH,
        }),
      ).toThrow();
      const maintenance = acquireKiteSessionStoreMaintenance(fixture.path, 'exclusive');
      maintenance.release();
    } finally {
      fixture.remove();
    }
  },
);
