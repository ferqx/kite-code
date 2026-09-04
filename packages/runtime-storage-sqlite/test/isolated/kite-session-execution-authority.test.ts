import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import {
  assertKiteSessionStoreSchema,
  createKiteHomeWriteTransactionPort,
  createKiteSessionExecutionAuthority,
  KiteSessionExecutionAuthorityError,
  openKiteSessionStoreDatabase,
} from '../../src';

describe('Kite Session execution authority', () => {
  test('acquires, renews, detaches and cleanly hands off one monotonic generation', () => {
    const fixture = createStore(['session-1']);
    let now = 100;
    try {
      const authority = createKiteSessionExecutionAuthority({
        database: fixture.database,
        writer: createKiteHomeWriteTransactionPort(fixture.database, assertKiteSessionStoreSchema),
        nowMs: () => now,
      });
      expect(authority.read('session-1')).toEqual({
        sessionId: 'session-1',
        status: 'idle',
        controllerGeneration: 0,
        hostInstanceId: null,
        clientId: null,
        connectionGeneration: 0,
        interactionGeneration: 0,
        leaseUntilMs: null,
        cleanupConfirmed: true,
        updatedAt: 0,
        revision: 0,
      });
      const acquired = authority.acquire({
        sessionId: 'session-1',
        expectedRevision: 0,
        hostInstanceId: 'host-1',
        clientId: 'client-1',
        connectionGeneration: 4,
        leaseUntilMs: 200,
      });
      expect(acquired).toMatchObject({
        status: 'acquired',
        authority: { controllerGeneration: 1, revision: 1, cleanupConfirmed: false },
      });
      now = 110;
      const renewed = authority.renew({
        sessionId: 'session-1',
        expectedRevision: 1,
        controllerGeneration: 1,
        hostInstanceId: 'host-1',
        leaseUntilMs: 250,
      });
      expect(renewed).toMatchObject({
        status: 'acquired',
        authority: { controllerGeneration: 1, leaseUntilMs: 250, revision: 2 },
      });
      const detached = authority.detach({
        sessionId: 'session-1',
        expectedRevision: 2,
        controllerGeneration: 1,
        hostInstanceId: 'host-1',
      });
      expect(detached).toMatchObject({ status: 'detached', revision: 3 });
      const released = authority.release({
        sessionId: 'session-1',
        expectedRevision: 3,
        controllerGeneration: 1,
        hostInstanceId: 'host-1',
        cleanupConfirmed: true,
      });
      expect(released).toMatchObject({
        status: 'idle',
        controllerGeneration: 2,
        revision: 4,
        cleanupConfirmed: true,
      });
      expect(
        authority.acquire({
          sessionId: 'session-1',
          expectedRevision: 4,
          hostInstanceId: 'host-2',
          clientId: null,
          connectionGeneration: 1,
          leaseUntilMs: 300,
        }),
      ).toMatchObject({
        status: 'acquired',
        authority: { hostInstanceId: 'host-2', controllerGeneration: 3, revision: 5 },
      });
    } finally {
      fixture.close();
    }
  });

  test('fences stale writers and persists recovery_required until explicit cleanup reconciliation', () => {
    const fixture = createStore(['session-1']);
    let now = 100;
    try {
      const authority = createKiteSessionExecutionAuthority({
        database: fixture.database,
        writer: createKiteHomeWriteTransactionPort(fixture.database, assertKiteSessionStoreSchema),
        nowMs: () => now,
      });
      authority.acquire({
        sessionId: 'session-1',
        expectedRevision: 0,
        hostInstanceId: 'host-1',
        clientId: null,
        connectionGeneration: 1,
        leaseUntilMs: 200,
      });
      expect(() =>
        authority.release({
          sessionId: 'session-1',
          expectedRevision: 1,
          controllerGeneration: 2,
          hostInstanceId: 'host-1',
          cleanupConfirmed: true,
        }),
      ).toThrow(KiteSessionExecutionAuthorityError);

      now = 201;
      const takeover = authority.acquire({
        sessionId: 'session-1',
        expectedRevision: 1,
        hostInstanceId: 'host-2',
        clientId: null,
        connectionGeneration: 1,
        leaseUntilMs: 300,
      });
      expect(takeover).toMatchObject({
        status: 'recovery_required',
        authority: { controllerGeneration: 2, revision: 2, cleanupConfirmed: false },
      });
      expect(
        authority.acquire({
          sessionId: 'session-1',
          expectedRevision: 2,
          hostInstanceId: 'host-2',
          clientId: null,
          connectionGeneration: 1,
          leaseUntilMs: 300,
        }),
      ).toMatchObject({ status: 'recovery_required', authority: { revision: 2 } });
      const reconciled = authority.confirmRecoveryCleanup({
        sessionId: 'session-1',
        expectedRevision: 2,
      });
      expect(reconciled).toMatchObject({
        status: 'idle',
        controllerGeneration: 3,
        revision: 3,
        cleanupConfirmed: true,
      });
      expect(
        authority.acquire({
          sessionId: 'session-1',
          expectedRevision: 3,
          hostInstanceId: 'host-2',
          clientId: null,
          connectionGeneration: 1,
          leaseUntilMs: 300,
        }),
      ).toMatchObject({
        status: 'acquired',
        authority: { controllerGeneration: 4, revision: 4 },
      });
    } finally {
      fixture.close();
    }
  });

  test('allows one real-process writer per Session while different Sessions both acquire', async () => {
    const fixture = createStore(['session-1', 'session-2', 'session-3']);
    fixture.database.close(false);
    const executable = join(
      import.meta.dir,
      '..',
      'fixtures',
      'acquire-kite-session-authority-child.ts',
    );
    try {
      const sameSession = await runChildren(executable, fixture.path, [
        ['session-1', 'host-1'],
        ['session-1', 'host-2'],
      ]);
      expect(sameSession.map((value) => value.status).sort()).toEqual([
        'acquired',
        'revision_conflict',
      ]);

      const differentSessions = await runChildren(executable, fixture.path, [
        ['session-2', 'host-3'],
        ['session-3', 'host-4'],
      ]);
      expect(differentSessions.map((value) => value.status).sort()).toEqual([
        'acquired',
        'acquired',
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('creates the first generation atomically with new Session facts', () => {
    const fixture = createStore([]);
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
      const initial = writer.run(() => {
        insertSession(fixture.database, 'session-1');
        return authority.acquireInitialInTransaction({
          sessionId: 'session-1',
          hostInstanceId: 'host-1',
          clientId: 'client-1',
          connectionGeneration: 1,
          leaseUntilMs: 200,
        });
      });
      expect(initial).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
        revision: 1,
      });

      expect(() =>
        writer.run(() => {
          insertSession(fixture.database, 'session-2');
          authority.acquireInitialInTransaction({
            sessionId: 'session-2',
            hostInstanceId: 'host-1',
            clientId: null,
            connectionGeneration: 1,
            leaseUntilMs: 50,
          });
        }),
      ).toThrow();
      expect(
        fixture.database
          .query("SELECT 1 FROM runtime_sessions WHERE session_id = 'session-2'")
          .get(),
      ).toBeNull();
    } finally {
      fixture.close();
    }
  });
});

function createStore(sessionIds: readonly string[]) {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-session-authority-')),
  );
  const path = join(root, 'kite-session.sqlite');
  const database = openKiteSessionStoreDatabase(path);
  database
    .query(
      `INSERT INTO workspaces(
        workspace_id, canonical_path, workspace_identity_digest, project_id, workspace_digest,
        display_name, created_at, updated_at
      ) VALUES ('workspace-1', '/workspace', ?, 'project-1', 'digest-1', '', 1, 1)`,
    )
    .run(`sha256:${'1'.repeat(64)}`);
  for (const sessionId of sessionIds) insertSession(database, sessionId);
  return {
    root,
    path,
    database,
    close() {
      database.close(false);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function insertSession(database: Database, sessionId: string): void {
  database
    .query(
      `INSERT INTO runtime_sessions(
      session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
      revision, name, updated_at, run_index_from_revision
    ) VALUES (?, 'workspace-1', 'project-1', 'digest-1', 27,
      'kite-agent-server-api-v1-2026-08-29', 0, '', 1, 0)`,
    )
    .run(sessionId);
}

async function runChildren(
  executable: string,
  databasePath: string,
  identities: readonly (readonly [sessionId: string, hostId: string])[],
): Promise<Array<{ readonly status: string }>> {
  const startAt = Date.now() + 250;
  const children = identities.map(([sessionId, hostId]) =>
    Bun.spawn([process.execPath, executable, databasePath, sessionId, hostId, String(startAt)], {
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  const outputs = await Promise.all(children.map(readChild));
  return outputs.map((output) => JSON.parse(output) as { readonly status: string });
}

async function readChild(child: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  return stdout.trim();
}
