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

describe('runtime schema v23 migration boundary', () => {
  test('migrates a schema-v22 snapshot once and persists the v23 writer version', () => {
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
      expect(second.getState().schemaVersion).toBe(23);
      expect(second.getState().recoveryState).toEqual({ kind: 'normal' });
      second.close();

      const verifier = createRuntimeStore(storePath);
      expect(verifier.loadSnapshotRecord(threadId)?.metadata.schemaVersion).toBe(23);
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
      expect(kernel.getState().schemaVersion).toBe(23);
      expect(kernel.getState().context.activeCheckpoint?.version).toBe(1);
      expect(kernel.getState().recoveryState).toEqual({ kind: 'normal' });
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed for an unknown newer schema instead of downgrading it', () => {
    const { directory, storePath } = temporaryStore('newer');
    const threadId = 'schema-v24';
    try {
      const state = {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 24,
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const kernel = createAgentKernel({ threadId, userId: 'u', workspace: '/', storePath });
      expect(kernel.getState().recoveryState).toEqual({
        kind: 'incompatible',
        schemaVersion: 24,
      });
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
