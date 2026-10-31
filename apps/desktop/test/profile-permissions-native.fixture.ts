import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WindowsProfilePermissionIssue } from '../electron/windows-access';

const [asset, root] = process.argv.slice(2) as [string, string];
const api = createRequire(import.meta.url)(asset) as {
  profilePermissions(root: string, profile: string): WindowsProfilePermissionIssue | undefined;
  profileShared(root: string, profile: string): { verify(): void; release(): void };
};
const system = join(process.env.SystemRoot!, 'System32');
const run = (name: string, args: string[]) => {
  const result = spawnSync(join(system, name), args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
const sid = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-1-(?:\d+-)*\d+/)![0];
const icacls = (...args: string[]) => run('icacls.exe', args);
const privateDirectory = (path: string) => {
  mkdirSync(path);
  icacls(path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`);
  return path;
};
const make = (name: string) => privateDirectory(join(root, name));
const extra = (path: string, rights = '(OI)(CI)(RX)') =>
  icacls(path, '/grant:r', `*S-1-1-0:${rights}`);
const inspect = (path: string) => {
  const issue = api.profilePermissions(path, 'default');
  assert.ok(issue);
  return issue;
};
const backups = (path: string) =>
  readdirSync(path).filter((name) => name.startsWith('permissions-backup-'));
const original = Buffer.from('original persisted history and draft bytes');

const absent = join(root, 'absent');
assert.equal(api.profilePermissions(absent, 'default'), undefined);
assert.equal(existsSync(absent), false);
const safe = make('safe');
assert.equal(api.profilePermissions(safe, 'default'), undefined);
assert.deepEqual(readdirSync(safe), []);

const repaired = make('repaired');
privateDirectory(join(repaired, 'default'));
writeFileSync(join(repaired, 'default/core.db'), original);
extra(repaired);
mkdirSync(join(repaired, 'unrelated-inherited'));
const childAcl = icacls(join(repaired, 'unrelated-inherited'));
const before = icacls(repaired);
const issue = inspect(repaired);
assert.equal(issue.path, repaired);
assert.equal(issue.repairable, true);
assert.equal(icacls(repaired), before);
assert.equal(backups(repaired).length, 0);
assert.throws(() => api.profileShared(repaired, 'default'), /windows_access_unavailable/);
assert.throws(() => (issue.repair as (...args: unknown[]) => void)(1), /repair_failed/);
issue.repair();
assert.equal(existsSync(issue.backupPath), true);
assert.match(readFileSync(issue.backupPath, 'utf8'), /;;;WD\)/);
assert.match(readFileSync(issue.backupPath, 'utf8'), /Owner\/Group\/DACL:/);
assert.equal(icacls(join(repaired, 'unrelated-inherited')), childAcl);
assert.deepEqual(readFileSync(join(repaired, 'default/core.db')), original);
assert.equal(api.profilePermissions(repaired, 'default'), undefined);
assert.throws(() => issue.repair(), /repair_failed/);
const admitted = api.profileShared(repaired, 'default');
admitted.verify();
assert.throws(() => issue.repair.call(admitted), /repair_failed/);
assert.throws(() => admitted.verify.call(issue), /windows_access_unavailable/);
admitted.release();

for (const kind of ['write', 'deny', 'unprotected'] as const) {
  const path = make(kind);
  extra(path, kind === 'write' ? '(OI)(CI)(M)' : '(OI)(CI)(RX)');
  if (kind === 'deny') icacls(path, '/deny', '*S-1-1-0:(WD)');
  if (kind === 'unprotected') icacls(path, '/inheritance:e');
  const acl = icacls(path),
    denied = inspect(path);
  assert.equal(denied.repairable, false, kind);
  assert.throws(() => denied.repair(), /repair_failed/);
  assert.equal(icacls(path), acl);
  assert.deepEqual(backups(path), []);
}
const drift = make('drift');
extra(drift);
const stale = inspect(drift);
icacls(drift, '/grant:r', '*S-1-5-11:(OI)(CI)(RX)');
const driftAcl = icacls(drift);
assert.throws(() => stale.repair(), /repair_failed/);
assert.equal(icacls(drift), driftAcl);
assert.deepEqual(backups(drift), []);

const replacement = make('replacement');
extra(replacement);
const replaced = inspect(replacement);
renameSync(replacement, `${replacement}-old`);
privateDirectory(replacement);
extra(replacement);
assert.throws(() => replaced.repair(), /repair_failed/);
assert.deepEqual(backups(replacement), []);

const ancestor = make('ancestor-replacement');
privateDirectory(join(ancestor, 'default'));
writeFileSync(join(ancestor, 'default/core.db'), original);
extra(join(ancestor, 'default/core.db'), '(RX)');
const oldRoot = inspect(ancestor);
renameSync(ancestor, `${ancestor}-old`);
privateDirectory(ancestor);
renameSync(join(`${ancestor}-old`, 'default'), join(ancestor, 'default'));
assert.throws(() => oldRoot.repair(), /repair_failed/);
assert.deepEqual(backups(ancestor), []);
assert.deepEqual(readFileSync(join(ancestor, 'default/core.db')), original);

const collision = make('collision');
extra(collision);
const conflict = inspect(collision),
  conflictAcl = icacls(collision);
writeFileSync(conflict.backupPath, 'existing backup is never overwritten');
assert.throws(() => conflict.repair(), /repair_failed/);
assert.equal(readFileSync(conflict.backupPath, 'utf8'), 'existing backup is never overwritten');
assert.equal(icacls(collision), conflictAcl);

const busy = make('busy'),
  lease = api.profileShared(busy, 'default');
extra(busy);
const blocked = inspect(busy),
  busyAcl = icacls(busy);
assert.throws(() => blocked.repair(), /owner_busy/);
assert.equal(icacls(busy), busyAcl);
assert.deepEqual(backups(busy), []);
lease.release();
inspect(busy).repair();
assert.equal(api.profilePermissions(busy, 'default'), undefined);

const file = make('file');
privateDirectory(join(file, 'default'));
const database = join(file, 'default/core.db');
writeFileSync(database, original);
extra(database, '(RX)');
const dbIssue = inspect(file);
assert.equal(dbIssue.path, database);
assert.equal(dbIssue.repairable, true);
dbIssue.repair();
assert.deepEqual(readFileSync(database), original);
assert.equal(api.profilePermissions(file, 'default'), undefined);
linkSync(database, join(file, 'hardlink'));
const linked = inspect(file);
assert.equal(linked.repairable, false);
assert.throws(() => linked.repair(), /repair_failed/);
console.log('PROFILE_PERMISSIONS_NATIVE_PASS');
