import { PrivateImmutableArtifactStorageV1 } from '@kite/builtin-runtime/model';

const root = process.env.KITE_PRIVATE_ARTIFACT_TEST_ROOT;
const payload = process.env.KITE_PRIVATE_ARTIFACT_TEST_PAYLOAD;
if (!root || payload === undefined) process.exit(2);

const store = new PrivateImmutableArtifactStorageV1({
  root,
  namespace: 'private-store',
  partitions: [{ kind: 'surface', directory: 'surfaces', extension: '.json' }],
  maxArtifactBytes: 1024,
});

const ref = store.write('surface', Buffer.from(payload, 'utf8'));
process.stdout.write(JSON.stringify(ref));
