import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '../../../src/artifact-access';
import { assertLiveLock, attachLockResource } from '../../../src/platform/locks';
import {
  hashWindowsArtifactFile,
  readWindowsArtifactFile,
  readWindowsArtifactObject,
  retainWindowsArtifactScope,
} from '../../../src/platform/windows-artifact-scope';
import { retainWindowsCandidateFiles } from '../../../src/platform/windows-candidate-files';

const windows = process.platform === 'win32';
function command(args: string[]) {
  const result = spawnSync('icacls.exe', args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw Error(`owned_acl_fixture_failed:${result.status}:${result.stderr}:${result.stdout}`);
  return result.stdout;
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kite-candidate-scope-')));
  const parent = join(base, 'releases');
  mkdirSync(parent);
  const user = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  if (user.status !== 0) throw Error('owned_user_fixture_failed');
  const sid = user.stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
  if (!sid) throw Error('owned_user_fixture_invalid');
  // Ordinary public readable directories: multiple ACEs, no exact private FA policy.
  command([
    parent,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)(F)`,
    '*S-1-5-18:(OI)(CI)(F)',
    '*S-1-5-32-544:(OI)(CI)(F)',
    '*S-1-1-0:(OI)(CI)(RX)',
  ]);
  const root = join(parent, 'bundle');
  mkdirSync(root);
  writeFileSync(join(root, 'asset'), 'original immutable asset');
  return {
    base,
    parent,
    root,
    sid,
    lock: join(parent, '.use-bundle.lock'),
    close: () => rmSync(base, { recursive: true, force: true }),
  };
}

test.skipIf(windows)(
  'candidate Windows scope import is inert and attachment cannot accept forged authority',
  async () => {
    expect(() => retainWindowsArtifactScope('/unused')).toThrow(
      'artifact_scope_platform_unsupported',
    );
    let touched = false;
    expect(() =>
      attachLockResource(
        { path: 'fake', mode: 'shared', release() {} },
        {
          verify() {
            touched = true;
          },
          release() {
            touched = true;
          },
        },
      ),
    ).toThrow('Invalid lock resource attachment');
    expect(touched).toBe(false);
    const root = mkdtempSync(join(tmpdir(), 'kite-scope-import-'));
    try {
      const result = await Bun.build({
        entrypoints: [
          fileURLToPath(
            new URL('../../../src/platform/windows-artifact-scope.ts', import.meta.url),
          ),
        ],
        target: 'node',
        outdir: root,
        packages: 'external',
      });
      expect(result.success).toBe(true);
      const child = spawnSync(
        'node',
        [
          '--input-type=module',
          '-e',
          `const m=await import(${JSON.stringify(pathToFileURL(join(root, 'windows-artifact-scope.js')).href)});if(typeof m.retainWindowsArtifactScope!=='function')throw Error('missing');`,
        ],
        { encoding: 'utf8' },
      );
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// Native Windows cases are mandatory on win32, with no backend-availability skip.
test.skipIf(!windows)(
  'public inherited read ACL candidates pin ancestry and preserve real lock authority through release',
  () => {
    const f = fixture();
    try {
      const originalAcl = command([f.root]);
      const lease = acquireArtifactAccess({ root: f.root, mode: 'shared' });
      try {
        assertLiveLock(lease, f.lock, 'shared');
        expect(() => attachLockResource(lease, { verify() {}, release() {} })).toThrow();
        acquireArtifactAccess({ root: f.root, mode: 'shared' }).release();
        expect(() => acquireArtifactAccess({ root: f.root, mode: 'exclusive' })).toThrow(
          'Lock is busy',
        );
        expect(() => renameSync(f.root, join(f.parent, 'moved'))).toThrow();
        expect(() => renameSync(f.parent, `${f.parent}-moved`)).toThrow();
        expect(() => renameSync(f.base, `${f.base}-moved`)).toThrow();
        expect(readFileSync(join(f.root, 'asset'), 'utf8')).toBe('original immutable asset');
        expect(command([f.root])).toBe(originalAcl);
        command([f.root, '/grant', '*S-1-1-0:(WD)']);
        expect(() => assertLiveLock(lease, f.lock, 'shared')).toThrow('artifact_scope_denied');
      } finally {
        lease.release();
      }
      lease.release();
      expect(() => assertLiveLock(lease, f.lock, 'shared')).toThrow();
      command([f.root, '/remove:g', '*S-1-1-0']);
      command([f.root, '/grant', '*S-1-1-0:(RX)']);
      acquireArtifactAccess({ root: f.root, mode: 'exclusive' }).release();
      renameSync(f.root, join(f.parent, 'moved'));
      renameSync(join(f.parent, 'moved'), f.root);
    } finally {
      f.close();
    }
  },
);

test.skipIf(!windows)(
  'manifest pins check exact native paths and every original object without a preceding realpath per leaf',
  () => {
    const f = fixture();
    try {
      const directory = join(f.root, 'nested');
      mkdirSync(directory);
      const longName = `${'long-'.repeat(16)}asset`;
      writeFileSync(join(directory, longName), 'long path');
      const paths = [`nested/${longName}`, 'asset'];
      const pin = retainWindowsCandidateFiles(f.root, paths);
      try {
        pin.verify();
        expect(readFileSync(join(directory, longName), 'utf8')).toBe('long path');
        expect(readFileSync(join(f.root, 'asset'), 'utf8')).toBe('original immutable asset');
        expect(() => writeFileSync(join(f.root, 'asset'), 'changed')).toThrow();
        expect(() => renameSync(directory, join(f.root, 'moved'))).toThrow();
        expect(() => renameSync(f.root, join(f.parent, 'moved'))).toThrow();
        expect(() => writeFileSync(join(directory, 'unlisted.js'), 'new child')).not.toThrow();
        expect(() => pin.verify()).toThrow('artifact_scope_denied');
      } finally {
        pin.release();
      }
      unlinkSync(join(directory, 'unlisted.js'));
      for (const paths of [
        ['asset', 'ASSET'],
        ['nested/../asset'],
        ['asset:stream'],
        ['nested\\asset'],
        ['missing'],
      ])
        expect(() => retainWindowsCandidateFiles(f.root, paths)).toThrow('artifact_scope_denied');
      const alias = join(f.root, 'alias');
      symlinkSync(directory, alias, 'junction');
      expect(() => retainWindowsCandidateFiles(f.root, [`alias/${longName}`])).toThrow(
        'artifact_scope_denied',
      );
      unlinkSync(alias);
      linkSync(join(f.root, 'asset'), alias);
      expect(() => retainWindowsCandidateFiles(f.root, ['asset'])).toThrow('artifact_scope_denied');
      unlinkSync(alias);
      const final = retainWindowsCandidateFiles(f.root, paths);
      final.verify();
      final.release();
      renameSync(directory, join(f.root, 'moved'));
      writeFileSync(join(f.root, 'asset'), 'changed after release');
    } finally {
      f.close();
    }
  },
);

test.skipIf(!windows)(
  'original object facts reject copied or released owners and live ACL changes are still rejected',
  () => {
    const f = fixture();
    try {
      const path = join(f.root, 'asset');
      const pin = retainWindowsCandidateFiles(f.root, ['asset']);
      try {
        expect(readWindowsArtifactObject(pin, path)?.size).toBe(
          BigInt(Buffer.byteLength('original immutable asset')),
        );
        expect(readWindowsArtifactObject(pin, f.root)?.directory).toBe(true);
        expect(readWindowsArtifactObject(pin, join(f.root, 'absent'))).toBeUndefined();
        const expected = Buffer.from('original immutable asset');
        const bytes = readWindowsArtifactFile(pin, path);
        expect(bytes).toEqual(expected);
        bytes[0] = 0;
        expect(readWindowsArtifactFile(pin, path)).toEqual(expected);
        expect(hashWindowsArtifactFile(pin, path)).toBe(
          createHash('sha256').update(expected).digest('hex'),
        );
        expect(hashWindowsArtifactFile(pin, path)).toBe(
          createHash('sha256').update(expected).digest('hex'),
        );
        expect(() => readWindowsArtifactObject({ ...pin }, path)).toThrow('artifact_scope_denied');
        command([path, '/grant', '*S-1-1-0:(W)']);
        expect(() => pin.verify()).toThrow('artifact_scope_denied');
        command([path, '/remove:g', '*S-1-1-0']);
        command([path, '/grant', '*S-1-1-0:(RX)']);
        pin.verify();
      } finally {
        pin.release();
      }
      expect(() => readWindowsArtifactObject(pin, path)).toThrow('artifact_scope_denied');
      expect(() => readWindowsArtifactFile(pin, path)).toThrow('artifact_scope_denied');
      expect(() => hashWindowsArtifactFile(pin, path)).toThrow('artifact_scope_denied');
      expect(readFileSync(path, 'utf8')).toBe('original immutable asset');
    } finally {
      f.close();
    }
  },
);

test.skipIf(!windows)(
  'candidate root and parent unsafe ACL, owner, junction and lock hardlink are rejected without repair',
  () => {
    const f = fixture();
    try {
      for (const path of [f.root, f.parent])
        for (const right of ['W', 'D', 'WD', 'WO', 'DC']) {
          command([path, '/grant', `*S-1-1-0:(${right})`]);
          const unsafe = command([path]);
          expect(() => acquireArtifactAccess({ root: f.root, mode: 'shared' })).toThrow();
          expect(command([path])).toBe(unsafe);
          command([path, '/remove:g', '*S-1-1-0']);
          command([path, '/grant', '*S-1-1-0:(RX)']);
        }
      // A different owner cannot be assigned by an ordinary user's token.
      // Read an existing OS-owned directory; never change its ACL or create a lock there.
      const systemRoot = realpathSync(process.env.SystemRoot!);
      const owner = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[System.IO.Directory]::GetAccessControl($env:SystemRoot).GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      if (owner.status !== 0)
        throw Error(`owned_system_owner_query_failed:${owner.stderr}:${owner.stdout}`);
      expect(owner.stdout.trim()).toMatch(/^S-1-/);
      expect(owner.stdout.trim()).not.toBe(f.sid);
      expect(() => retainWindowsArtifactScope(systemRoot)).toThrow('artifact_scope_denied');
      const alias = join(f.parent, 'alias');
      symlinkSync(f.root, alias, 'junction');
      expect(() => acquireArtifactAccess({ root: alias, mode: 'shared' })).toThrow();
      unlinkSync(alias);
      acquireArtifactAccess({ root: f.root, mode: 'shared' }).release();
      linkSync(f.lock, alias);
      expect(() => acquireArtifactAccess({ root: f.root, mode: 'shared' })).toThrow();
      unlinkSync(alias);
      expect(readFileSync(join(f.root, 'asset'), 'utf8')).toBe('original immutable asset');
      acquireArtifactAccess({ root: f.root, mode: 'exclusive' }).release();
    } finally {
      f.close();
    }
  },
);

test.skipIf(!windows)(
  'independent Windows Bun holders retain shared candidate usage until every original holder closes',
  async () => {
    const f = fixture();
    const entry = pathToFileURL(
      fileURLToPath(new URL('../../../src/artifact-access.ts', import.meta.url)),
    ).href;
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const marker = join(f.parent, `ready-${index}`);
        const code = `import {writeFileSync} from 'node:fs';import {acquireArtifactAccess} from ${JSON.stringify(entry)};const lock=acquireArtifactAccess({root:${JSON.stringify(f.root)},mode:'shared'});writeFileSync(${JSON.stringify(marker)},'held');for await(const _ of Bun.stdin.stream()){}lock.release();`;
        const child = Bun.spawn([process.execPath, '-e', code], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        children.push(child);
        const deadline = Date.now() + 5000;
        while (!existsSync(marker)) {
          if (child.exitCode !== null || Date.now() > deadline) {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
              await child.exited;
            }
            throw Error(`owned_holder_not_ready:${await new Response(child.stderr).text()}`);
          }
          await Bun.sleep(10);
        }
      }
      expect(() => acquireArtifactAccess({ root: f.root, mode: 'exclusive' })).toThrow(
        'Lock is busy',
      );
      for (const [index, child] of children.entries()) {
        (child.stdin as import('bun').FileSink).end();
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stderr as ReadableStream<Uint8Array>).text()).toBe('');
        if (index === 0)
          expect(() => acquireArtifactAccess({ root: f.root, mode: 'exclusive' })).toThrow(
            'Lock is busy',
          );
      }
      acquireArtifactAccess({ root: f.root, mode: 'exclusive' }).release();
    } finally {
      for (const child of children)
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      f.close();
    }
  },
  15000,
);

test('Windows attached lock keeps its original region through scope and native close failures', () => {
  const lockModule = fileURLToPath(new URL('../../../src/platform/locks.ts', import.meta.url));
  const securityModule = fileURLToPath(
    new URL('../../../src/platform/windows-path-security.ts', import.meta.url),
  );
  const code = `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as nativeFFI from 'bun:ffi';
assert.equal(typeof require('bun:ffi').dlopen, 'function');
Object.defineProperty(process, 'platform', { value: 'win32' });
let nextHandle = 1n, region, failClose = false, failScope = true;
const handles = new Map(), calls = [];
mock.module('bun:ffi', () => ({
  ...nativeFFI,
  ptr: value => value,
  dlopen() {
    return {
      close() { calls.push('dll-close'); },
      symbols: {
        CreateFileW() { const handle = nextHandle++; handles.set(handle, true); return handle; },
        GetFileInformationByHandle(_handle, bytes) {
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(40, 1, true);
          return true;
        },
        LockFileEx(handle, flags) {
          if ((flags & 2) && region !== undefined) return false;
          region = handle;
          return true;
        },
        UnlockFileEx(handle) { calls.push('unlock'); if (region === handle) region = undefined; return true; },
        CloseHandle(handle) {
          calls.push('close:' + handle);
          if (failClose && handle === region) { failClose = false; return false; }
          handles.delete(handle);
          if (region === handle) region = undefined;
          return true;
        },
      },
    };
  },
}));
const security = { verifyPath() {}, createFile() {}, verifyFile() {}, verifyHandle() {} };
mock.module(${JSON.stringify(securityModule)}, () => ({ defaultWindowsPathSecurity: () => security }));
const { acquireFileLock, attachLockResource, assertLiveLock } = await import(${JSON.stringify(lockModule)});
const lock = acquireFileLock('owned-mock-lock', 'shared', security);
const original = region;
let scopeAttempts = 0;
attachLockResource(lock, {
  verify() {},
  release() {
    calls.push('scope'); scopeAttempts++;
    assert.equal(region, original);
    if (failScope) throw Error('scope_close_unknown');
  },
});
assert.throws(() => lock.release(), /scope_close_unknown/);
assert.deepEqual(calls, ['scope']);
assert.equal(region, original);
assertLiveLock(lock, lock.path, 'shared');
assert.throws(() => acquireFileLock('owned-mock-lock', 'exclusive', security), /Lock is busy/);
failScope = false; failClose = true; calls.length = 0;
assert.throws(() => lock.release(), /Lock release failed/);
assert.deepEqual(calls, ['scope', 'close:' + original]);
assert.equal(region, original);
assert.equal(handles.has(original), true);
assert.throws(() => acquireFileLock('owned-mock-lock', 'exclusive', security), /Lock is busy/);
calls.length = 0;
lock.release();
assert.deepEqual(calls, ['close:' + original, 'dll-close']);
assert.equal(scopeAttempts, 2);
assert.equal(region, undefined);
assert.equal(handles.has(original), false);
assert.throws(() => assertLiveLock(lock, lock.path, 'shared'), /released lock authority/);
lock.release();
assert.deepEqual(calls, ['close:' + original, 'dll-close']);
const replacement = acquireFileLock('owned-mock-lock', 'exclusive', security);
const replacementHandle = region;
failClose = true; calls.length = 0;
assert.throws(() => replacement.release(), /Lock release failed/);
assert.deepEqual(calls, ['close:' + replacementHandle]);
assert.equal(region, replacementHandle);
assert.equal(handles.has(replacementHandle), true);
assertLiveLock(replacement, replacement.path, 'exclusive');
assert.throws(() => acquireFileLock('owned-mock-lock', 'exclusive', security), /Lock is busy/);
calls.length = 0;
replacement.release();
assert.deepEqual(calls, ['close:' + replacementHandle, 'dll-close']);
assert.equal(region, undefined);
assert.throws(() => assertLiveLock(replacement, replacement.path, 'exclusive'), /released lock authority/);
replacement.release();
assert.deepEqual(calls, ['close:' + replacementHandle, 'dll-close']);
assert.equal(handles.size, 0);
console.log('attached-original-close-confirmed');
`;
  const child = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (child.error || child.status !== 0)
    process.stderr.write(child.stderr || `${String(child.error ?? child.signal)}\n`);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout).toBe('attached-original-close-confirmed\n');
});
