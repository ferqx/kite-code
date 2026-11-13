import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getLoadedSqliteEngine,
  initializeSqliteEngine,
  verifySqliteEngineAsset,
} from '@kite-ai/agent/sqlite-engine';

const root = process.argv[2];
assert(root);
// Historical verifier input, recorded from the supported Bun 3.53.2 source.
const identity = {
  version: '3.53.2',
  sourceId: '2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24',
};
assert.equal(getLoadedSqliteEngine(), null);
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
const verified = verifySqliteEngineAsset(selection).manifest;
assert('linkage' in verified);
assert.equal(verified.linkage, 'builtin');
assert.deepEqual(verified.sqlite, identity);
assert.throws(() => initializeSqliteEngine(selection), /sqlite_engine_runtime_unsupported/);
console.log(JSON.stringify({ linkage: verified.linkage, identity, releaseQualified: false }));
