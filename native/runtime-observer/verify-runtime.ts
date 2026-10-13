import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Entry {
  resourceId: string;
  kind: 'PoolJob' | 'FilePoll' | 'Timer';
  state: string;
  live: boolean;
  refActive: boolean;
  pending: boolean;
  closing: boolean;
}
interface Snapshot {
  version: number;
  baseRevision: string;
  coverageComplete: boolean;
  generation: string;
  observationValid: boolean;
  unknown: boolean;
  reason: string | null;
  uncovered: string[];
  entries: Entry[];
  live: string;
  refActive: string;
  pending: string;
  closing: string;
}

const native = require('bun:jsc') as { getResourceCensus?: () => Snapshot };
assert.equal(typeof native.getResourceCensus, 'function', 'native_resource_source_missing');
const sample = (): Snapshot => {
  const value = native.getResourceCensus!();
  assert.equal(value.version, 1);
  assert.equal(value.baseRevision, '744846f844374847c902b5e7fd59b4342a51ef99');
  assert.equal(value.coverageComplete, false, 'partial_source_must_not_claim_complete');
  assert.equal(value.observationValid, true, 'native_resource_observation_invalid');
  assert.equal(value.unknown, false);
  assert.equal(value.reason, null);
  assert.ok(value.uncovered.length > 0);
  assert.equal(new Set(value.entries.map((entry) => entry.resourceId)).size, value.entries.length);
  for (const field of ['live', 'refActive', 'pending', 'closing'] as const) {
    assert.match(value[field], /^(0|[1-9][0-9]*)$/);
    assert.equal(
      BigInt(value[field]),
      BigInt(value.entries.filter((entry) => entry[field]).length),
    );
  }
  for (const entry of value.entries) assert.match(entry.resourceId, /^[1-9][0-9]*$/);
  return value;
};

const root = mkdtempSync(join(tmpdir(), 'kite-native-resource-lifecycle-'));
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const path = join(root, 'owned-input');
  writeFileSync(path, Buffer.alloc(1024 * 1024, 97));
  const before = sample();
  const reads = Array.from({ length: 8 }, () => readFile(path));
  const pending = sample();
  assert.ok(
    pending.entries.some((entry) => entry.kind === 'PoolJob'),
    'pool_job_not_observed',
  );
  const buffers = await Promise.all(reads);
  for (const buffer of buffers) assert.equal(buffer.length, 1024 * 1024);

  const spawned = Bun.spawn([process.execPath, '-e', 'setTimeout(() => process.exit(0), 50)'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child = spawned;
  const watching = sample();
  assert.ok(
    watching.entries.some((entry) => entry.kind === 'FilePoll'),
    'file_poll_not_observed',
  );
  const [exit, stdout, stderr] = await Promise.all([
    spawned.exited,
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
  ]);
  assert.equal(exit, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  const deadline = performance.now() + 1000;
  let after = sample();
  while (after.live !== before.live && performance.now() < deadline) {
    // A sleep would itself allocate a Timer in the observed process. Reuse
    // the already-tested owned file job to advance the loop without adding
    // GC-retained timer wrappers to the native-release assertion.
    await readFile(path);
    after = sample();
  }
  console.log(
    JSON.stringify({
      version: 1,
      runtime: process.execPath,
      bunVersion: Bun.version,
      pid: process.pid,
      before,
      pending,
      watching,
      after,
      released: after.live === before.live,
      assertions: [
        'actual_pool_jobs',
        'actual_file_polls',
        'native_release',
        'child_exit_and_both_eof',
      ],
      fullResourceQualified: false,
      completeProcessBirths: false,
    }),
  );
  assert.equal(after.live, before.live, 'native_resources_not_released');
  assert.ok(BigInt(after.generation) > BigInt(before.generation));
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await child.exited;
  }
  rmSync(root, { recursive: true, force: true });
}
