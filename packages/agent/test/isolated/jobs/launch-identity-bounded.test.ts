import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Each child owns its fs mocks; unrelated Shell tests never inherit instrumentation.
const scenarios = [
  'sizes-and-short-reads',
  'same-size-tail-change',
  'growth',
  'truncate',
  'replace',
  'mode-change',
  'read-failure',
] as const;
for (const scenario of scenarios)
  test(`launch identity bounded full-file verification: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-launch-hash-'));
    try {
      const script = join(root, 'probe.mjs');
      writeFileSync(
        script,
        `
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mock } from 'bun:test';
import * as fs from 'node:fs';
const actual = { ...fs };
const root = ${JSON.stringify(root)}, scenario = ${JSON.stringify(scenario)};
const path = root + '/binary';
const payload = Buffer.alloc(2 * 1024 * 1024 + 37, 97);
payload[payload.length - 1] = 121;
actual.writeFileSync(path, payload, { mode: 0o600 });
let tracking = false, mutated = false, wholeReads = 0, reads = [], allocations = [], buffers = new Set(), live = new Set();
const allocate = Buffer.alloc, unsafe = Buffer.allocUnsafe;
Buffer.alloc = function(size, ...args) { if (tracking) allocations.push(size); return allocate.call(Buffer, size, ...args); };
Buffer.allocUnsafe = function(size) { if (tracking) allocations.push(size); return unsafe.call(Buffer, size); };
mock.module('node:fs', () => ({ ...actual,
 openSync(...args) { const fd = actual.openSync(...args); if (tracking) live.add(fd); return fd; },
 closeSync(fd) { live.delete(fd); return actual.closeSync(fd); },
 readFileSync(...args) { if (tracking) wholeReads++; return actual.readFileSync(...args); },
 readSync(fd, buffer, offset, length, position) {
   if (!tracking) return actual.readSync(fd, buffer, offset, length, position);
   buffers.add(buffer);
   const observation = { allocation: buffer.byteLength, requested: length, count: null };
   reads.push(observation);
   if (scenario === 'read-failure' && reads.length === 2) throw Error('fixture_read_failed');
   const count = actual.readSync(fd, buffer, offset, Math.min(length, 17311), position);
   observation.count = count;
   if (!mutated && count > 0) {
     mutated = true;
     if (scenario === 'growth') actual.appendFileSync(path, 'grown');
     if (scenario === 'truncate') actual.truncateSync(path, 3);
     if (scenario === 'replace') { actual.renameSync(path, path + '.old'); actual.writeFileSync(path, payload, { mode: 0o600 }); }
     if (scenario === 'mode-change') actual.chmodSync(path, 0o400);
   }
   return count;
 }
}));
const { launchIdentity, verifyLaunchIdentities } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, '../../../src/jobs/launch-identity.ts')).href)});
function run(action) {
 tracking = true;
 try { return action(); } finally { tracking = false; assert.equal(live.size, 0, 'all opened descriptors close on success and failure'); }
}
if (scenario === 'sizes-and-short-reads') {
 for (const size of [0, 1, 65536, payload.length]) {
   actual.writeFileSync(path, payload.subarray(0, size), { mode: 0o600 });
   allocations = []; reads = []; buffers.clear(); wholeReads = 0; mutated = false;
   const identity = run(() => launchIdentity(path, true));
   assert.equal(identity.digest, createHash('sha256').update(payload.subarray(0, size)).digest('hex'));
   assert.equal(wholeReads, 0, 'hashing may not allocate a whole-file Buffer');
   assert.ok(reads.length >= 1, 'verification reaches an explicit EOF read even for empty input');
   assert.equal(reads.at(-1).count, 0, 'success requires actual EOF, not only the original size');
   assert.ok(allocations.length >= 1);
   assert.equal(buffers.size, 1, 'all short reads reuse the same call-local scratch');
   assert.ok(allocations.every(sizeAllocated => sizeAllocated <= Math.max(1, Math.min(size, 1024 * 1024))), 'scratch allocation is capped and proportional for small inputs');
   assert.ok(reads.every(read => read.allocation <= Math.max(1, Math.min(size, 1024 * 1024))));
   if (size > 1024 * 1024) assert.ok(reads.length > 3, 'short reads and nonempty last block are fully consumed');
 }
} else if (scenario === 'same-size-tail-change') {
 const original = run(() => launchIdentity(path, true));
 const fd = actual.openSync(path, 'r+');
 try { actual.writeSync(fd, Buffer.from('z'), 0, 1, payload.length - 1); } finally { actual.closeSync(fd); }
 assert.throws(() => run(() => verifyLaunchIdentities([original])), /confined_launch_changed/);
 const fresh = run(() => launchIdentity(path, true));
 assert.notEqual(fresh.digest, original.digest, 'no metadata or original digest cache may conceal the last byte');
} else {
 assert.throws(() => run(() => launchIdentity(path, true)), scenario === 'read-failure' ? /fixture_read_failed/ : /confined_launch_changed/);
}
`,
      );
      const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(stderr).toBe('');
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
