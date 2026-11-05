import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { openSqliteStore } from '../../../src/sqlite';

test('large publication yields before physical publication, cancels without a ref and then publishes normally', async () => {
  const root = temporaryDirectory('kite-artifact-publish-yield-'),
    profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile),
    artifacts = createArtifactStore({ profile, store });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'test',
    });
    await store.createSession({
      expectedStoreId,
      sessionId: 's',
      commandId: 'create',
      workspaceId: 'w',
      title: 'test',
      subjectId: 'owner',
    });
    const input = {
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session' as const, id: 's' },
      refId: 'cancelled',
      mediaType: 'application/octet-stream',
    };
    const bytes = Buffer.alloc(8 * 1024 * 1024, 67),
      hash = createHash('sha256').update(bytes).digest('hex');
    const controller = new AbortController();
    let observed = false;
    async function* content() {
      setImmediate(() => {
        observed = true;
        controller.abort();
      });
      yield bytes;
    }
    let failure: unknown;
    try {
      await artifacts.publishStream({ ...input, content: content(), signal: controller.signal });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(observed).toBe(true);
    expect(await store.getArtifactReference(input)).toBeNull();
    expect(existsSync(artifactPath(join(root, 'test'), hash))).toBe(false);
    const first = await artifacts.publish({ ...input, refId: 'good', content: bytes });
    expect(first.hash).toBe(hash);
    const duplicate = await artifacts.publish({ ...input, refId: 'duplicate', content: bytes });
    expect(duplicate.hash).toBe(hash);
    expect(Buffer.from(await artifacts.read({ ...input, refId: 'duplicate' })).equals(bytes)).toBe(
      true,
    );
  } finally {
    await artifacts.close();
    await store.close();
    removeTemporaryDirectory(root);
  }
}, 30000);
