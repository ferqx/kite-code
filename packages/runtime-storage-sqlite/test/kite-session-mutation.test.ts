import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertKiteSessionStoreSchema,
  createKiteHomeWriteTransactionPort,
  createKiteSessionExecutionAuthority,
  createKiteSessionMutationPort,
  KiteSessionExecutionAuthorityError,
  KiteSessionMutationError,
  openKiteSessionStoreDatabase,
} from '../src';

describe('Kite Session mutation fence', () => {
  test('checks generation, binding and Session revision in the same writer transaction', () => {
    const fixture = createFixture();
    let now = 100;
    try {
      const writer = createKiteHomeWriteTransactionPort(
        fixture.database,
        assertKiteSessionStoreSchema,
      );
      const authority = createKiteSessionExecutionAuthority({
        database: fixture.database,
        writer,
        nowMs: () => now,
      });
      const acquired = authority.acquire({
        sessionId: 'session-1',
        expectedRevision: 0,
        hostInstanceId: 'host-1',
        clientId: 'client-1',
        connectionGeneration: 2,
        leaseUntilMs: 200,
      });
      if (acquired.status !== 'acquired') throw new Error('Expected an acquired authority.');
      const mutation = createKiteSessionMutationPort({
        database: fixture.database,
        writer,
        authority,
      });
      const binding = {
        sessionId: 'session-1',
        controllerGeneration: acquired.authority.controllerGeneration,
        hostInstanceId: 'host-1',
        clientId: 'client-1',
        connectionGeneration: 2,
        expectedAuthorityRevision: acquired.authority.revision,
      } as const;

      expect(
        mutation.run({ ...binding, expectedSessionRevision: 0 }, () => {
          fixture.database
            .query('UPDATE runtime_sessions SET name = ?, revision = 1 WHERE session_id = ?')
            .run('renamed', 'session-1');
          return 'committed';
        }),
      ).toBe('committed');
      expect(session(fixture).name).toBe('renamed');
      mutation.assertDispatchable(binding);

      expect(() =>
        mutation.run({ ...binding, expectedSessionRevision: 0 }, () => {
          throw new Error('must not run');
        }),
      ).toThrow(KiteSessionMutationError);
      expect(session(fixture).name).toBe('renamed');

      now = 201;
      expect(() => mutation.assertDispatchable(binding)).toThrow(
        KiteSessionExecutionAuthorityError,
      );
      expect(() =>
        mutation.run({ ...binding, expectedSessionRevision: 1 }, () => {
          fixture.database
            .query("UPDATE runtime_sessions SET name = 'late' WHERE session_id = 'session-1'")
            .run();
        }),
      ).toThrow(KiteSessionExecutionAuthorityError);
      expect(session(fixture).name).toBe('renamed');
    } finally {
      fixture.close();
    }
  });

  test('rolls back the entire operation when a fenced mutation fails', () => {
    const fixture = createFixture();
    try {
      const writer = createKiteHomeWriteTransactionPort(
        fixture.database,
        assertKiteSessionStoreSchema,
      );
      const authority = createKiteSessionExecutionAuthority({
        database: fixture.database,
        writer,
        nowMs: () => 100,
      });
      const acquired = authority.acquire({
        sessionId: 'session-1',
        expectedRevision: 0,
        hostInstanceId: 'host-1',
        clientId: null,
        connectionGeneration: 1,
        leaseUntilMs: 200,
      });
      if (acquired.status !== 'acquired') throw new Error('Expected an acquired authority.');
      const mutation = createKiteSessionMutationPort({
        database: fixture.database,
        writer,
        authority,
      });
      expect(() =>
        mutation.run(
          {
            sessionId: 'session-1',
            controllerGeneration: acquired.authority.controllerGeneration,
            hostInstanceId: 'host-1',
            clientId: null,
            connectionGeneration: 1,
            expectedAuthorityRevision: acquired.authority.revision,
            expectedSessionRevision: 0,
          },
          () => {
            fixture.database
              .query("UPDATE runtime_sessions SET name = 'partial' WHERE session_id = 'session-1'")
              .run();
            throw new Error('injected failure');
          },
        ),
      ).toThrow();
      expect(session(fixture).name).toBe('');
    } finally {
      fixture.close();
    }
  });
});

function createFixture() {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-session-mutation-')),
  );
  const database = openKiteSessionStoreDatabase(join(root, 'kite-session.sqlite'));
  database
    .query(
      `INSERT INTO workspaces(
        workspace_id, canonical_path, workspace_identity_digest, project_id, workspace_digest,
        display_name, created_at, updated_at
      ) VALUES ('workspace-1', '/workspace', ?, 'project-1', 'digest-1', '', 1, 1)`,
    )
    .run(`sha256:${'1'.repeat(64)}`);
  database.run(
    `INSERT INTO runtime_sessions(
      session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
      revision, name, updated_at, run_index_from_revision
    ) VALUES ('session-1', 'workspace-1', 'project-1', 'digest-1', 27,
      'kite-agent-server-api-v1-2026-08-29', 0, '', 1, 0)`,
  );
  return {
    root,
    database,
    close() {
      database.close(false);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function session(fixture: ReturnType<typeof createFixture>): { readonly name: string } {
  const row = fixture.database
    .query<{ name: string }, []>(
      "SELECT name FROM runtime_sessions WHERE session_id = 'session-1' LIMIT 1",
    )
    .get();
  if (!row) throw new Error('Session is missing.');
  return row;
}
