import { Database } from 'bun:sqlite';
import { collectProfileGarbage } from '../../../src/maintenance';
import { initializeSqliteEngine } from '../../../src/sqlite-engine';

initializeSqliteEngine(JSON.parse(process.env.KITE_MAINTENANCE_ENGINE!));
const profile = JSON.parse(process.env.KITE_MAINTENANCE_PROFILE!);
const originalClose = Database.prototype.close;
let retained: Database | undefined;
Database.prototype.close = function (strict?: boolean) {
  if (!retained && this.filename.includes('/.gc-') && this.filename.endsWith('/source.db')) {
    retained = this;
    throw Error('maintenance_fixture_close_unconfirmed');
  }
  return originalClose.call(this, strict);
};
let failure = '';
try {
  await collectProfileGarbage({ profile, expectedStoreId: process.env.KITE_MAINTENANCE_STORE! });
} catch (error) {
  failure = error instanceof Error ? error.message : 'unknown';
}
if (failure !== 'maintenance_fixture_close_unconfirmed' || !retained)
  throw Error(`maintenance_fixture_wrong_failure:${failure}`);
const metadata = retained.query('SELECT store_id FROM storage_meta WHERE singleton=1').get();
console.log(JSON.stringify({ failure, connectionAlive: !!metadata, path: retained.filename }));
// The real owning process exits after EOF; no fake close acknowledgement is sent.
for await (const _ of Bun.stdin.stream()) break;
process.exit(0);
