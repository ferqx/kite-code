import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentKernel } from '@/core/runtime/kernel';
import { createInitialRuntimeState, RUNTIME_STATE_SCHEMA_VERSION } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

function temporaryStore(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `openpx-schema-v23-${label}-`));
  return { directory, storePath: join(directory, 'runtime.db') };
}

describe('runtime schema v24 migration boundary', () => {
  test('migrates a schema-v22 snapshot once and persists the v24 writer version', () => {
    const { directory, storePath } = temporaryStore('v22');
    const threadId = 'schema-v22-to-v23';
    try {
      const state = {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 22,
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const first = createAgentKernel({ threadId, userId: 'u', workspace: '/', storePath });
      expect(first.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(first.getState().recoveryState).toEqual({ kind: 'normal' });
      first.close();

      const second = createAgentKernel({ threadId, userId: 'u', workspace: '/', storePath });
      expect(second.getState().schemaVersion).toBe(24);
      expect(second.getState().recoveryState).toEqual({ kind: 'normal' });
      second.close();

      const verifier = createRuntimeStore(storePath);
      expect(verifier.loadSnapshotRecord(threadId)?.metadata.schemaVersion).toBe(24);
      verifier.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('preserves checkpoint v1 as legacy instead of relabeling it verified v2', () => {
    const { directory, storePath } = temporaryStore('checkpoint-v1');
    const threadId = 'schema-v23-checkpoint-v1';
    try {
      const initial = createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' });
      initial.transcript.messages.push({
        kind: 'user',
        messageId: 'legacy-source',
        turnId: 'legacy-turn',
        ordinal: 0,
        createdAt: '2026-08-10T00:00:00.000Z',
        content: 'legacy source',
      });
      const legacy = {
        ...initial,
        schemaVersion: 22,
        context: {
          ...initial.context,
          activeCheckpoint: {
            compactionId: 'legacy-v1',
            version: 1 as const,
            sourceRevision: 0,
            sourceDigest: 'legacy-digest',
            coveredThroughMessageId: 'legacy-source',
            coveredThroughTurnId: 'legacy-turn',
            summary: 'Legacy summary.',
            inputTokensBefore: 2_000,
            inputTokensAfter: 500,
            reason: 'manual' as const,
            createdAt: '2026-08-10T00:00:01.000Z',
          },
        },
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, legacy);
      store.close();

      const kernel = createAgentKernel({ threadId, userId: 'u', workspace: '/', storePath });
      expect(kernel.getState().schemaVersion).toBe(24);
      expect(kernel.getState().context.activeCheckpoint?.version).toBe(1);
      expect(kernel.getState().recoveryState).toEqual({ kind: 'normal' });
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed for an unknown newer schema instead of downgrading it', () => {
    const { directory, storePath } = temporaryStore('newer');
    const threadId = 'schema-v25';
    try {
      const state = {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 25,
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const kernel = createAgentKernel({ threadId, userId: 'u', workspace: '/', storePath });
      expect(kernel.getState().recoveryState).toEqual({
        kind: 'incompatible',
        schemaVersion: 25,
      });
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('persists bounded migration progress and resumes it after connection restart', () => {
    const { directory, storePath } = temporaryStore('resume');
    const threadId = 'schema-v23-resume';
    try {
      const seed = createRuntimeStore(storePath);
      seed.saveSnapshot(threadId, {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 22,
      });
      seed.appendEvents(
        threadId,
        [
          { type: 'user.message_appended', messageId: 'one', content: 'one' },
          { type: 'user.message_appended', messageId: 'two', content: 'two' },
          { type: 'user.message_appended', messageId: 'three', content: 'three' },
        ],
        [
          { eventId: 'legacy-one', revision: 1, occurredAt: '2026-08-11T00:00:01.000Z' },
          { eventId: 'legacy-two', revision: 2, occurredAt: '2026-08-11T00:00:02.000Z' },
          { eventId: 'legacy-three', revision: 3, occurredAt: '2026-08-11T00:00:03.000Z' },
        ],
      );
      seed.saveNamedSnapshot(threadId, 'during-build', {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 22,
      });
      const identity = seed.loadPersistenceIdentity(threadId);
      if (!identity.sourceSnapshot) throw new Error('legacy snapshot identity expected');
      const first = seed.advanceRuntimeV24MigrationBuildV1(
        threadId,
        { ...identity, sourceSnapshot: identity.sourceSnapshot },
        1,
      );
      expect(first).toEqual({ status: 'in_progress', processedRows: 1, totalRows: 4 });
      expect(seed.restoreNamedSnapshot(threadId, 'during-build')).toBe(false);
      expect(seed.forkSession(threadId, 'during-build', 'migration-build-target')).toBe(false);
      expect(seed.loadSnapshot('migration-build-target')).toBeNull();
      seed.close();

      const resumed = createRuntimeStore(storePath);
      let result = resumed.advanceRuntimeV24MigrationBuildV1(
        threadId,
        { ...identity, sourceSnapshot: identity.sourceSnapshot },
        1,
      );
      expect(result.status).toBe('in_progress');
      result = resumed.advanceRuntimeV24MigrationBuildV1(
        threadId,
        { ...identity, sourceSnapshot: identity.sourceSnapshot },
        1,
      );
      expect(result.status).toBe('in_progress');
      result = resumed.advanceRuntimeV24MigrationBuildV1(
        threadId,
        { ...identity, sourceSnapshot: identity.sourceSnapshot },
        1,
      );
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') throw new Error('completed build expected');
      expect(result.evidence).toMatchObject({ sourceEventCount: 3 });
      resumed.close();

      const kernel = createAgentKernel({ threadId, userId: 'u', workspace: '/', storePath });
      expect(kernel.getState().schemaVersion).toBe(24);
      expect(kernel.getState().recoveryState).toEqual({ kind: 'normal' });
      const database = new Database(storePath, { readonly: true });
      expect(
        database
          .query<{ count: number }, []>(
            `SELECT
               (SELECT COUNT(*) FROM runtime_v24_migration_builds WHERE thread_id = 'schema-v23-resume') +
               (SELECT COUNT(*) FROM runtime_event_ledgers WHERE thread_id = 'schema-v23-resume') AS count`,
          )
          .get()?.count,
      ).toBe(1);
      expect(
        database
          .query<{ classification: string }, []>(
            "SELECT classification FROM runtime_legacy_named_cut_proofs WHERE thread_id = 'schema-v23-resume' AND name = 'during-build'",
          )
          .get()?.classification,
      ).toBe('legacy_unverified');
      database.close();
      kernel.close();
      const strictStore = createRuntimeStore(storePath);
      expect(
        strictStore.forkSessionV1(threadId, 'during-build', 'schema-v23-unverified-named-target'),
      ).toEqual({ status: 'transcript_invariant_error' });
      expect(strictStore.loadSnapshot('schema-v23-unverified-named-target')).toBeNull();
      strictStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('binds distinct legacy raw event chains to distinct migrated ledger bases', () => {
    const fixtures = ['alpha', 'beta'].map((content) => {
      const fixture = temporaryStore(`raw-${content}`);
      const threadId = `schema-v23-raw-${content}`;
      const store = createRuntimeStore(fixture.storePath);
      store.saveSnapshot(threadId, {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 22,
      });
      store.appendEvents(
        threadId,
        [{ type: 'user.message_appended', messageId: 'same-id', content }],
        [
          {
            eventId: `legacy-${content}`,
            revision: 1,
            occurredAt: '2026-08-11T00:00:00.000Z',
          },
        ],
      );
      store.close();
      const kernel = createAgentKernel({
        threadId,
        userId: 'u',
        workspace: '/',
        storePath: fixture.storePath,
      });
      expect(kernel.getState().recoveryState).toEqual({ kind: 'normal' });
      const baseId = kernel.getState().storageFormat.ledgerBase.baseId;
      kernel.close();
      return { ...fixture, baseId };
    });
    try {
      expect(fixtures[0]!.baseId).not.toBe(fixtures[1]!.baseId);
    } finally {
      for (const fixture of fixtures) rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
