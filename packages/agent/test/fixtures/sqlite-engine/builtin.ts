import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';

const root = process.argv[2];
assert(root);
const db = new Database(':memory:');
const identity = db
  .query<{ version: string; sourceId: string }, []>(
    'SELECT sqlite_version() version, sqlite_source_id() sourceId',
  )
  .get();
assert(identity);
db.close(true);
const bytes = Buffer.from(
  JSON.stringify({
    version: 1,
    driver: 'bun:sqlite',
    target: { platform: process.platform, arch: process.arch },
    linkage: 'builtin',
    sqlite: identity,
  }),
);
writeFileSync(join(root, 'engine-manifest.json'), bytes, { mode: 0o600 });
const selection = { root, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
const result = initializeSqliteEngine(selection);
assert.equal(result.linkage, 'builtin');
assert.equal(result.version, identity.version);
assert.equal(result.sourceId, identity.sourceId);
assert.equal(initializeSqliteEngine(selection), result);
console.log(JSON.stringify({ linkage: result.linkage, identity, releaseQualified: false }));
