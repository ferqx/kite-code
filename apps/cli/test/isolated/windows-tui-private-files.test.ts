import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireProfileAccess,
  acquireProfileDataLock,
  type ProfileAccess,
} from '@kite-ai/agent/profile-access';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import {
  publishWindowsTuiPrivateFile,
  readWindowsTuiPrivateFile,
  type WindowsTuiPrivateFilename,
} from '../../host/windows-tui-private-files';

const windows = test.skipIf(process.platform !== 'win32');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = join(tmpdir(), `kite-windows-tui-private-${randomUUID()}`);
  let access: ProfileAccess | undefined;
  try {
    privateDirectory(root);
    access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
    privateDirectory(access.profilePath);
    return { root, access };
  } catch (error) {
    try {
      access?.lock.release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'windows_tui_fixture_close_unknown');
    }
    throw error;
  }
}
function withDataLock(
  access: ProfileAccess,
  work: (lock: ReturnType<typeof acquireProfileDataLock>) => void,
) {
  const lock = acquireProfileDataLock(access, 'tui_private');
  let failure: unknown;
  try {
    work(lock);
  } catch (error) {
    failure = error;
  }
  try {
    lock.release();
  } catch (cleanup) {
    throw failure === undefined
      ? cleanup
      : new AggregateError([failure, cleanup], 'windows_tui_data_close_failed');
  }
  if (failure !== undefined) throw failure;
}
function withFixture(work: (value: ReturnType<typeof fixture>, owners: ProfileAccess[]) => void) {
  const value = fixture(),
    owners = [value.access];
  let failure: unknown;
  try {
    work(value, owners);
  } catch (error) {
    failure = error;
  }
  let confirmed = true;
  for (const owner of owners.reverse()) {
    try {
      owner.lock.release();
    } catch (cleanup) {
      confirmed = false;
      failure =
        failure === undefined
          ? cleanup
          : new AggregateError([failure, cleanup], 'windows_tui_fixture_close_failed');
    }
  }
  if (confirmed) {
    try {
      rmSync(value.root, { recursive: true, force: true });
    } catch (cleanup) {
      failure =
        failure === undefined
          ? cleanup
          : new AggregateError([failure, cleanup], 'windows_tui_fixture_remove_failed');
    }
  }
  if (failure !== undefined) throw failure;
}
windows(
  'real Windows private records preserve complete 16MiB policy, CAS and original bytes',
  () => {
    withFixture(({ root, access }, owners) => {
      const names: WindowsTuiPrivateFilename[] = [
        'caller-intents.json',
        'recovery.json',
        'tui.json',
        'file-recovery-intents.json',
        'mcp-selection-intents.json',
        'mcp-connection-intents.json',
        'mcp-reconnection-intents.json',
        'mcp-source-approval-intents.json',
        'mcp-source-mutation-intents.json',
      ];
      const bytes = Buffer.from('\ufeff原记录\r\n全字段 Unicode 👩🏽‍💻\n');
      for (const filename of names) {
        expect(readWindowsTuiPrivateFile(access, filename)).toBeNull();
        withDataLock(access, (lock) => {
          publishWindowsTuiPrivateFile({
            access,
            filename,
            bytes,
            writeLock: lock,
            expectedEtag: null,
            recheck: () => {},
          });
        });
        expect(readWindowsTuiPrivateFile(access, filename)).toEqual(bytes);
      }
      const full = Buffer.alloc(9 * 1024 * 1024, 0x78);
      full.set(Buffer.from('完整尾部'), full.length - Buffer.byteLength('完整尾部'));
      withDataLock(access, (lock) => {
        publishWindowsTuiPrivateFile({
          access,
          filename: 'tui.json',
          bytes: full,
          writeLock: lock,
          expectedEtag: sha(bytes),
          recheck: () => {},
        });
        expect(readWindowsTuiPrivateFile(access, 'tui.json')).toEqual(full);
        const recovery = Buffer.alloc(262145, 0x72);
        publishWindowsTuiPrivateFile({
          access,
          filename: 'recovery.json',
          bytes: recovery,
          writeLock: lock,
          expectedEtag: sha(bytes),
          recheck: () => {},
        });
        expect(() => readWindowsTuiPrivateFile(access, 'recovery.json', 262144)).toThrow(
          'windows_path_size_limit',
        );
        expect(readWindowsTuiPrivateFile(access, 'recovery.json')).toEqual(recovery);
        expect(() => readWindowsTuiPrivateFile(access, 'tui.json', 262144)).toThrow(
          'windows_path_size_limit',
        );
        expect(() =>
          defaultWindowsPathSecurity()!.writePrivateFile(
            join(access.profilePath, 'ui', 'config-limit.tmp'),
            full,
          ),
        ).toThrow();
        expect(existsSync(join(access.profilePath, 'ui', 'config-limit.tmp'))).toBe(false);
        expect(() =>
          publishWindowsTuiPrivateFile({
            access,
            filename: 'tui.json',
            bytes,
            writeLock: lock,
            expectedEtag: sha(bytes),
            recheck: () => {},
          }),
        ).toThrow('tui_private_publication_changed');
        const originalError = Error('original_recheck_failed');
        let actual: unknown;
        try {
          publishWindowsTuiPrivateFile({
            access,
            filename: 'tui.json',
            bytes,
            writeLock: lock,
            expectedEtag: sha(full),
            recheck: () => {
              throw originalError;
            },
          });
        } catch (error) {
          actual = error;
        }
        expect(actual).toBe(originalError);
        expect(readWindowsTuiPrivateFile(access, 'tui.json')).toEqual(full);
        expect(
          readdirSync(join(access.profilePath, 'ui')).filter((name) =>
            name.startsWith('.tui-private-'),
          ),
        ).toEqual([]);
      });
      access.lock.release();
      const cold = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
      owners.push(cold);
      expect(readWindowsTuiPrivateFile(cold, 'tui.json')).toEqual(full);
    });
  },
);
windows(
  'real Windows records reject hardlinks and rebound ui paths without repairing objects',
  () => {
    withFixture(({ root, access }) => {
      const bytes = Buffer.from('原记录');
      withDataLock(access, (lock) => {
        publishWindowsTuiPrivateFile({
          access,
          filename: 'caller-intents.json',
          bytes,
          writeLock: lock,
          expectedEtag: null,
          recheck: () => {},
        });
      });
      const path = join(access.profilePath, 'ui', 'caller-intents.json'),
        alias = join(access.profilePath, 'alias');
      linkSync(path, alias);
      try {
        expect(() => readWindowsTuiPrivateFile(access, 'caller-intents.json')).toThrow();
      } finally {
        unlinkSync(alias);
      }
      expect(readWindowsTuiPrivateFile(access, 'caller-intents.json')).toEqual(bytes);
      const foreign = join(root, 'foreign');
      privateDirectory(foreign);
      const rebound = join(access.profilePath, 'ui', 'mcp-selection-intents.json');
      symlinkSync(foreign, rebound, 'junction');
      try {
        expect(() => readWindowsTuiPrivateFile(access, 'mcp-selection-intents.json')).toThrow();
      } finally {
        unlinkSync(rebound);
      }
      expect(readdirSync(foreign)).toEqual([]);
      expect(() =>
        readWindowsTuiPrivateFile(access, '../outside' as WindowsTuiPrivateFilename),
      ).toThrow('tui_private_filename_invalid');
    });
  },
);
test.skipIf(process.platform === 'win32')(
  'POSIX import and explicit rejection acquire no Windows file authority',
  async () => {
    const module = await import('../../host/windows-tui-private-files');
    expect(() => module.readWindowsTuiPrivateFile({} as ProfileAccess, 'tui.json')).toThrow(
      'tui_private_platform_unsupported',
    );
    expect(() =>
      module.publishWindowsTuiPrivateFile({
        access: {} as ProfileAccess,
        filename: 'tui.json',
        bytes: Buffer.from(''),
        writeLock: {} as never,
        expectedEtag: null,
        recheck: () => {},
      }),
    ).toThrow('tui_private_platform_unsupported');
  },
);

test('validation Close unknown retains original Profile and data regions before any probe', async () => {
  const profile = fileURLToPath(
    new URL('../../../../packages/agent/src/platform/profile.ts', import.meta.url),
  );
  const security = fileURLToPath(
    new URL('../../../../packages/agent/src/platform/windows-path-security.ts', import.meta.url),
  );
  const helper = fileURLToPath(new URL('../../host/windows-tui-private-files.ts', import.meta.url));
  const code = `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nativeFFI from 'bun:ffi';
assert.equal(typeof require('bun:ffi').dlopen, 'function');
Object.defineProperty(process, 'platform', {value:'win32'});
let next = 1n, armed, probes = 0;
const handles = new Set(), regions = new Set();
mock.module('bun:ffi', () => ({...nativeFFI, ptr: value => value, dlopen() { return {
close() {}, symbols: {
CreateFileW() { const h = next++; handles.add(h); return h; },
GetFileInformationByHandle(_h, bytes) { new DataView(bytes.buffer).setUint32(40,1,true); return true; },
LockFileEx(h) { regions.add(h); return true; },
UnlockFileEx() { throw Error('unexpected unlock'); },
CloseHandle(h) { assert(handles.delete(h)); regions.delete(h); return true; }
}}; }}));
const policy = {
verifyPath() {}, verifyDirectory() {}, verifyFile() {},
verifyHandle() { probes++; if (armed) { const error = armed; armed = undefined; throw error; } },
createFile(path) { if (!existsSync(path)) writeFileSync(path,''); }
};
mock.module(${JSON.stringify(security)}, () => ({defaultWindowsPathSecurity:()=>policy, privateDirectory(path) { mkdirSync(path,{recursive:true}); }}));
const { acquireProfileAccess, acquireProfileDataLock, retainProfileTuiPrivateOperation } = await import(${JSON.stringify(profile)});
const { readWindowsTuiPrivateFile } = await import(${JSON.stringify(helper)});
const root = mkdtempSync(join(tmpdir(),'kite-tui-guard-mock-'));
try {
  const known = acquireProfileAccess({dataRoot:join(root,'known'),profile:'owned'});
  const knownWrite = acquireProfileDataLock(known,'tui_private');
  const ordinary = Error('ordinary policy refusal'); armed = ordinary;
  assert.throws(()=>retainProfileTuiPrivateOperation(known,knownWrite), error=>error===ordinary);
  knownWrite.release(); known.lock.release(); assert.equal(regions.size,0);
  const access = acquireProfileAccess({dataRoot:join(root,'unknown'),profile:'owned'});
  const write = acquireProfileDataLock(access,'tui_private');
  const originalRegions = [...regions];
  const original = Error('windows_path_security_close_failed'); armed = original;
  assert.throws(()=>retainProfileTuiPrivateOperation(access,write), error=>error===original);
  for (const lock of [write,access.lock]) assert.throws(()=>lock.release());
  assert.deepEqual([...regions],originalRegions);
  const before = probes;
  assert.throws(()=>readWindowsTuiPrivateFile({...access},'tui.json'), /profile_access_authority_invalid/);
  assert.equal(probes,before);
} finally { rmSync(root,{recursive:true,force:true}); }
`;
  const child = Bun.spawn([process.execPath, '--eval', code], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('tui_guard_mock_deadline')), 4000);
      }),
    ]);
    const errors = await stderr;
    if (exit !== 0) throw Error(`tui_guard_mock_failed:${errors}`);
    expect(exit).toBe(0);
    expect(await stdout).toBe('');
    expect(errors).toBe('');
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
});
