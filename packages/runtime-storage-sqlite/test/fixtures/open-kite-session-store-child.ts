import { openKiteSessionStoreDatabase } from '../../src';

const databasePath = process.argv[2];
const startAt = Number(process.argv[3]);
if (!databasePath || !Number.isSafeInteger(startAt)) {
  throw new Error('Expected a database path and synchronized start time.');
}

const waitMs = startAt - Date.now();
if (waitMs > 0) await Bun.sleep(waitMs);
const database = openKiteSessionStoreDatabase(databasePath);
database.close(false);
