import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactStore } from '../../../src/artifacts';
import { openSqliteStore } from '../../../src/sqlite';

test('bounded Artifact streams publish and verify more than the old whole-blob limit without truncating or granting a foreign scope', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-artifact-stream-')));
  const profile = { dataRoot: root, profile: 'new' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: `file://${root}` });
    await store.createSession({
      expectedStoreId,
      sessionId: 's',
      commandId: 'create',
      workspaceId: 'w',
      title: 's',
      subjectId: 'owner',
    });
    const input = {
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session' as const, id: 's' },
      refId: 'large',
      mediaType: 'text/plain',
    };
    const chunk = Buffer.from('完整 body\n'.repeat(4096));
    const expected = createHash('sha256');
    let bytes = 0;
    async function* content() {
      for (let i = 0; i < 400; i++) {
        expected.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    }
    const reference = await artifacts.publishStream({ ...input, content: content() });
    expect(bytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(reference.size).toBe(String(bytes));
    expect(reference.hash).toBe(expected.digest('hex'));
    const actual = createHash('sha256');
    let readBytes = 0;
    let largestChunk = 0;
    for await (const part of artifacts.readStream(input)) {
      largestChunk = Math.max(largestChunk, part.byteLength);
      readBytes += part.byteLength;
      actual.update(part);
    }
    expect(readBytes).toBe(bytes);
    expect(largestChunk).toBeLessThanOrEqual(64 * 1024);
    expect(actual.digest('hex')).toBe(reference.hash);
    let error: unknown;
    try {
      for await (const _part of artifacts.readStream({ ...input, subjectId: 'intruder' })) {
        throw new Error('foreign bytes');
      }
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string })?.code).toBe('artifact_scope_denied');
    async function* broken() {
      yield Buffer.from('partial');
      throw new Error('source failed');
    }
    try {
      await artifacts.publishStream({ ...input, refId: 'broken', content: broken() });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe('source failed');
    expect(await store.getArtifactReference({ ...input, refId: 'broken' })).toBeNull();
    expect(
      readdirSync(join(root, 'new', 'blobs')).filter((name) => name.startsWith('.publish-')),
    ).toEqual([]);
  } finally {
    await artifacts.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
