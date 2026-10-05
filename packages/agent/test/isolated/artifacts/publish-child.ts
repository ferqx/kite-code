import { createArtifactStore } from '../../../src/artifacts';
import { openSqliteStore } from '../../../src/sqlite';

const profile = { dataRoot: process.argv[2]!, profile: 'new' };
const store = await openSqliteStore(profile);
const artifact = createArtifactStore({ profile, store });
try {
  const ref = await artifact.publish({
    expectedStoreId: (await store.getMetadata()).storeId,
    refId: 'process-race',
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session', id: 's' },
    content: Buffer.from('two process immutable'),
    mediaType: 'text/plain',
  });
  console.log(JSON.stringify(ref));
} finally {
  await artifact.close();
  await store.close();
}
