import { openSqliteStore } from '../../../src/sqlite';

try {
  const store = await openSqliteStore({ dataRoot: process.env.TEST_DATA_ROOT!, profile: 'test' });
  const owner = process.env.TEST_SESSION
    ? await store.acquireSessionOwner(process.env.TEST_SESSION, 'child')
    : null;
  console.log(JSON.stringify({ metadata: await store.getMetadata(), owner }));
  await store.close();
} catch (error) {
  console.log(
    JSON.stringify({
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'error',
    }),
  );
  process.exitCode = 2;
}
