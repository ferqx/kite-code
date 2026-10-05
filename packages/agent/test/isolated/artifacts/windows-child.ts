import { createHash } from 'node:crypto';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createWindowsArtifactTemporary } from '../../../src/platform/windows-artifact-files';

const [root, mode, refId] = process.argv.slice(2);
if (!root || !mode || !refId) throw Error('owned_fixture_input_invalid');
const profile = { dataRoot: root, profile: 'owned' };
const store = await openSqliteStore({
  ...profile,
  ...(mode === 'cold' ? { mode: 'readonly' as const } : {}),
});
const artifacts = createArtifactStore({ profile, store });
const body = Buffer.concat([
  Buffer.from('\ufeffowned native media\r\n'),
  Buffer.alloc(200003, 0x61),
]);
const hash = createHash('sha256').update(body).digest('hex');
const input = {
  expectedStoreId: (await store.getMetadata()).storeId,
  sessionId: 's',
  subjectId: 'owner',
  scope: { kind: 'session' as const, id: 's' },
  refId,
  mediaType: 'text/plain',
};
const hold = async (stage: string) => {
  console.log(JSON.stringify({ stage, hash, size: String(body.length) }));
  const timer = setInterval(() => {}, 1000);
  try {
    await new Promise<void>(() => {});
  } finally {
    clearInterval(timer);
  }
};
try {
  if (mode === 'before_sql') {
    // Native publication boundary only: no fabricated Store registration or public success.
    const temporary = createWindowsArtifactTemporary(`${root}/owned`);
    try {
      for (let offset = 0; offset < body.length; offset += 65536)
        temporary.write(body.subarray(offset, offset + 65536));
      temporary.publish(hash, String(body.length));
    } finally {
      temporary.close();
    }
    await hold('published_before_sql');
  } else if (mode === 'before_publish') {
    async function* content() {
      yield body.subarray(0, 65536);
      await hold('temporary_before_publish');
      yield body.subarray(65536);
    }
    await artifacts.publishStream({ ...input, content: content() });
  } else if (mode === 'cold') {
    const before = await store.getMetadata();
    const bytes = await artifacts.read(input);
    const after = await store.getMetadata();
    console.log(
      JSON.stringify({
        hash: createHash('sha256').update(bytes).digest('hex'),
        size: String(bytes.length),
        sameMetadata: JSON.stringify(before) === JSON.stringify(after),
      }),
    );
  } else if (mode === 'publish') {
    const ref = await artifacts.publish({ ...input, content: body });
    console.log(JSON.stringify(ref));
  } else throw Error('owned_fixture_mode_invalid');
} finally {
  await artifacts.close();
  await store.close();
}
