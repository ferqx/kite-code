import {
  assertKiteSessionStoreSchema,
  createKiteHomeWriteTransactionPort,
  createKiteSessionExecutionAuthority,
  KiteSessionExecutionAuthorityError,
  openKiteSessionStoreDatabase,
} from '../../src';

const databasePath = process.argv[2];
const sessionId = process.argv[3];
const hostInstanceId = process.argv[4];
const startAt = Number(process.argv[5]);
if (!databasePath || !sessionId || !hostInstanceId || !Number.isSafeInteger(startAt)) {
  throw new Error('Expected database, Session, Host and synchronized start time.');
}

const waitMs = startAt - Date.now();
if (waitMs > 0) await Bun.sleep(waitMs);
const database = openKiteSessionStoreDatabase(databasePath);
try {
  const authority = createKiteSessionExecutionAuthority({
    database,
    writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
  });
  const result = authority.acquire({
    sessionId,
    expectedRevision: 0,
    hostInstanceId,
    clientId: hostInstanceId,
    connectionGeneration: 1,
    leaseUntilMs: Date.now() + 60_000,
  });
  console.log(JSON.stringify({ status: result.status }));
} catch (error) {
  if (error instanceof KiteSessionExecutionAuthorityError) {
    console.log(JSON.stringify({ status: error.code }));
  } else {
    throw error;
  }
} finally {
  database.close(false);
}
