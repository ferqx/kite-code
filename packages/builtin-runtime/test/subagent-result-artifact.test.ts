import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PrivateImmutableArtifactRef,
  PrivateImmutableArtifactStorageBackend,
} from '@kite-ai/builtin-runtime/model';
import { SubagentResultArtifactStore } from '@kite-ai/builtin-runtime/subagent';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Subagent terminal result Artifact', () => {
  test('persists one result for repeatable non-consuming reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-subagent-result-'));
    roots.push(root);
    const store = new SubagentResultArtifactStore({ root: join(root, 'subagent-tasks') });
    const ref = store.write({
      ownerKey: 'session-owner',
      taskId: 'child-1',
      result: { status: 'completed', summary: 'bounded report', toolCallCount: 2 },
    });
    expect(ref.kind).toBe('subagent_task');
    expect(store.read(ref, 'child-1')).toEqual({
      status: 'completed',
      summary: 'bounded report',
      toolCallCount: 2,
    });
    expect(store.read(ref, 'child-1')).toEqual(store.read(ref, 'child-1'));
    expect(() => store.read(ref, 'another-child')).toThrow();
  });

  test('looks up terminal results after store reconstruction without crossing owners', () => {
    type Ref = PrivateImmutableArtifactRef<'subagent_task'>;
    const rows = new Map<
      string,
      { ref: Ref; payload: Uint8Array; ownerKey: string; taskId: string }
    >();
    const backend: PrivateImmutableArtifactStorageBackend<'subagent_task'> = {
      write(ref, payload) {
        const value = JSON.parse(new TextDecoder().decode(payload)) as {
          ownerKey: string;
          taskId: string;
        };
        rows.set(ref.artifactId, { ref, payload, ownerKey: value.ownerKey, taskId: value.taskId });
      },
      read: (ref) => rows.get(ref.artifactId)!.payload,
      findByOwnerTask: (ownerKey, taskId) =>
        [...rows.values()].find((row) => row.ownerKey === ownerKey && row.taskId === taskId)?.ref,
      listByOwner: (ownerKey) =>
        [...rows.values()].filter((row) => row.ownerKey === ownerKey).map((row) => row.ref),
      collectGarbage: () => ({
        scannedEntries: rows.size,
        retainedArtifacts: rows.size,
        deletedArtifacts: 0,
        deletedTemporaryFiles: 0,
      }),
    };
    new SubagentResultArtifactStore({ backend }).write({
      ownerKey: 'session-a',
      taskId: 'child-a',
      result: { terminalStatus: 'completed', summary: 'durable' },
    });
    const rebuilt = new SubagentResultArtifactStore({ backend });
    expect(rebuilt.lookup('session-a', 'child-a')?.result).toMatchObject({ summary: 'durable' });
    expect(rebuilt.lookup('session-b', 'child-a')).toBeUndefined();
    expect(rebuilt.list('session-a').map((item) => item.taskId)).toEqual(['child-a']);
  });
});
