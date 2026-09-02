import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertKiteSessionStoreSchema,
  createKiteHomeWriteTransactionPort,
  createKiteSessionEffectPort,
  createKiteSessionExecutionAuthority,
  createKiteSessionMutationPort,
  openKiteSessionStoreDatabase,
} from '../src';

describe('Kite Session effect generation fence', () => {
  test('binds prepare, dispatch, renew and terminal evidence to one Session generation', () => {
    const fixture = createFixture();
    let now = 100;
    try {
      const context = createContext(fixture, () => now);
      const request = { ...context.mutationInput, effectId: 'effect-1', ownerId: 'owner-1' };
      const prepared = context.effects.prepare({ ...request, expiresAtMs: 160 });
      expect(prepared).toMatchObject({
        status: 'prepared',
        effect: {
          state: 'prepared',
          certainty: 'certain',
          leaseRevision: 1,
          controllerGeneration: 1,
        },
      });
      expect(context.effects.prepare({ ...request, expiresAtMs: 160 })).toMatchObject({
        status: 'existing',
        effect: { leaseRevision: 1 },
      });
      context.effects.assertDispatchable({
        ...context.binding,
        effectId: 'effect-1',
        ownerId: 'owner-1',
        expectedLeaseRevision: 1,
      });

      now = 110;
      const renewed = context.effects.renew({
        ...request,
        expectedLeaseRevision: 1,
        expiresAtMs: 180,
      });
      expect(renewed).toMatchObject({ leaseRevision: 2, expiresAtMs: 180 });
      const terminal = context.effects.commitTerminal({
        ...request,
        expectedLeaseRevision: 2,
        outcome: 'succeeded',
        terminalDigest: 'a'.repeat(64),
      });
      expect(terminal).toMatchObject({
        state: 'terminal',
        outcome: 'succeeded',
        terminalDigest: 'a'.repeat(64),
      });
      expect(() =>
        context.effects.assertDispatchable({
          ...context.binding,
          effectId: 'effect-1',
          ownerId: 'owner-1',
          expectedLeaseRevision: 2,
        }),
      ).toThrow();
    } finally {
      fixture.close();
    }
  });

  test('makes an unknown outcome durable and never dispatchable or preparable again', () => {
    const fixture = createFixture();
    try {
      const context = createContext(fixture, () => 100);
      const request = { ...context.mutationInput, effectId: 'effect-1', ownerId: 'owner-1' };
      context.effects.prepare({ ...request, expiresAtMs: 160 });
      const unknown = context.effects.markOutcomeUnknown({
        ...request,
        expectedLeaseRevision: 1,
      });
      expect(unknown).toMatchObject({
        effect: { state: 'unknown', outcome: 'unknown', certainty: 'uncertain' },
        authority: { status: 'recovery_required', controllerGeneration: 2 },
      });
      expect(() => context.effects.prepare({ ...request, expiresAtMs: 170 })).toThrow();
      expect(context.effects.inspect('session-1', 'effect-1')).toMatchObject({
        state: 'unknown',
        certainty: 'uncertain',
      });
      expect(() =>
        context.effects.assertDispatchable({
          ...context.binding,
          effectId: 'effect-1',
          ownerId: 'owner-1',
          expectedLeaseRevision: 1,
        }),
      ).toThrow();
      expect(() =>
        context.effects.commitTerminal({
          ...request,
          expectedLeaseRevision: 1,
          outcome: 'failed',
          terminalDigest: 'b'.repeat(64),
        }),
      ).toThrow();
    } finally {
      fixture.close();
    }
  });

  test('rejects late effect work after the Session lease or generation is stale', () => {
    const fixture = createFixture();
    let now = 100;
    try {
      const context = createContext(fixture, () => now);
      const request = { ...context.mutationInput, effectId: 'effect-1', ownerId: 'owner-1' };
      context.effects.prepare({ ...request, expiresAtMs: 190 });
      now = 201;
      expect(() =>
        context.effects.commitTerminal({
          ...request,
          expectedLeaseRevision: 1,
          outcome: 'failed',
          terminalDigest: 'c'.repeat(64),
        }),
      ).toThrow();
      expect(context.effects.inspect('session-1', 'effect-1')).toMatchObject({
        state: 'prepared',
        terminalDigest: null,
      });
    } finally {
      fixture.close();
    }
  });
});

function createContext(fixture: ReturnType<typeof createFixture>, nowMs: () => number) {
  const writer = createKiteHomeWriteTransactionPort(fixture.database, assertKiteSessionStoreSchema);
  const authority = createKiteSessionExecutionAuthority({
    database: fixture.database,
    writer,
    nowMs,
  });
  const acquired = authority.acquire({
    sessionId: 'session-1',
    expectedRevision: 0,
    hostInstanceId: 'host-1',
    clientId: 'client-1',
    connectionGeneration: 1,
    leaseUntilMs: 200,
  });
  if (acquired.status !== 'acquired') throw new Error('Expected an acquired authority.');
  const mutations = createKiteSessionMutationPort({
    database: fixture.database,
    writer,
    authority,
  });
  const binding = {
    sessionId: 'session-1',
    controllerGeneration: acquired.authority.controllerGeneration,
    hostInstanceId: 'host-1',
    clientId: 'client-1',
    connectionGeneration: 1,
    expectedAuthorityRevision: acquired.authority.revision,
  } as const;
  return {
    binding,
    mutationInput: { ...binding, expectedSessionRevision: 0 } as const,
    effects: createKiteSessionEffectPort({
      database: fixture.database,
      mutations,
      authority,
      nowMs,
    }),
  };
}

function createFixture() {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-session-effects-')),
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
