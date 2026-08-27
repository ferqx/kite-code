import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLocalRuntimeServiceLock,
  clearLocalRuntimeServiceState,
  createKiteHomeIdentity,
  createLocalRuntimeServiceToken,
  ensureLocalRuntimeServiceStateRoot,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  LocalRuntimeServiceStateError,
  type LocalServiceLockIdentity,
  publishLocalRuntimeServiceDescriptor,
  publishLocalRuntimeServiceToken,
  quarantineLocalRuntimeServiceLock,
  readLocalRuntimeServiceDescriptor,
  readLocalRuntimeServiceLockIdentity,
  readLocalRuntimeServiceToken,
  resolveLocalRuntimeServiceStatePaths,
  tryAcquireLocalRuntimeServiceLock,
} from '@kite-ai/kite-local-runtime/service';

const descriptor = {
  schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  instanceId: 'instance-state-test',
  pid: 42,
  startedAt: '2026-08-27T00:00:00.000Z',
  endpoint: {
    origin: 'http://127.0.0.1:43123',
    websocketUrl: 'ws://127.0.0.1:43123/rpc',
  },
  protocolVersion: 1,
  clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  serverVersion: '0.1.0',
  buildId: 'dev:state-test',
} as const;

const lockIdentity: LocalServiceLockIdentity = {
  schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  nonce: 'state-lock-nonce',
  pid: 42,
  operation: 'ensure',
  instanceId: descriptor.instanceId,
  createdAt: descriptor.startedAt,
};

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

function state() {
  temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), 'kite-local-runtime-state-'));
  return ensureLocalRuntimeServiceStateRoot(createKiteHomeIdentity(join(temporaryRoot, 'home')));
}

describe.skipIf(process.platform === 'win32')('kite-local-runtime service filesystem state', () => {
  test('creates the fixed root chain with owner-only POSIX permissions', () => {
    const paths = state();
    expect(readdirSync(paths.root).sort()).toEqual([]);
    expect(lstatSync(paths.root).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(lstatSync(paths.root).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(temporaryRoot!, 'home')).mode & 0o777).toBe(0o700);
    }

    const absent = resolveLocalRuntimeServiceStatePaths(
      createKiteHomeIdentity(join(temporaryRoot!, 'not-created')),
    );
    expect(readLocalRuntimeServiceDescriptor(absent)).toBeUndefined();
    expect(readLocalRuntimeServiceToken(absent, 'access')).toBeUndefined();
  });

  test('publishes and reads strict descriptor and separate restart-scoped tokens', () => {
    const paths = state();
    expect(publishLocalRuntimeServiceDescriptor(paths, descriptor)).toEqual(descriptor);
    expect(readLocalRuntimeServiceDescriptor(paths)).toEqual(descriptor);
    expect(readFileSync(paths.descriptor, 'utf8')).toBe(`${JSON.stringify(descriptor)}\n`);

    const access = createLocalRuntimeServiceToken();
    const control = createLocalRuntimeServiceToken();
    expect(access).not.toBe(control);
    publishLocalRuntimeServiceToken(paths, 'access', access);
    publishLocalRuntimeServiceToken(paths, 'control', control);
    expect(readLocalRuntimeServiceToken(paths, 'access')).toBe(access);
    expect(readLocalRuntimeServiceToken(paths, 'control')).toBe(control);
    expect(readFileSync(paths.accessToken, 'utf8')).toBe(access);
    expect(readFileSync(paths.controlToken, 'utf8')).toBe(control);

    writeFileSync(paths.descriptor, JSON.stringify({ ...descriptor, unexpected: true }));
    expect(() => readLocalRuntimeServiceDescriptor(paths)).toThrow(LocalRuntimeServiceStateError);
    writeFileSync(paths.accessToken, `${access}\n`);
    expect(() => readLocalRuntimeServiceToken(paths, 'access')).toThrow(
      LocalRuntimeServiceStateError,
    );
  });

  test('atomically replaces regular state files but refuses links and permissive files', () => {
    const paths = state();
    publishLocalRuntimeServiceDescriptor(paths, descriptor);
    if (process.platform !== 'win32') {
      chmodSync(paths.descriptor, 0o644);
      expect(() => publishLocalRuntimeServiceDescriptor(paths, descriptor)).toThrow(
        LocalRuntimeServiceStateError,
      );
      chmodSync(paths.descriptor, 0o600);
    }

    const external = join(temporaryRoot!, 'external.json');
    writeFileSync(external, 'outside');
    rmSync(paths.descriptor);
    symlinkSync(external, paths.descriptor);
    expect(() => readLocalRuntimeServiceDescriptor(paths)).toThrow(LocalRuntimeServiceStateError);
    expect(() => publishLocalRuntimeServiceDescriptor(paths, descriptor)).toThrow(
      LocalRuntimeServiceStateError,
    );
    expect(readFileSync(external, 'utf8')).toBe('outside');
  });

  test('uses an atomic directory lock and releases only its own inode/nonce', () => {
    const paths = state();
    const first = acquireLocalRuntimeServiceLock(paths, 'lifecycle', lockIdentity);
    expect(first.identity).toEqual(lockIdentity);
    expect(readLocalRuntimeServiceLockIdentity(paths, 'lifecycle')).toEqual(lockIdentity);
    expect(tryAcquireLocalRuntimeServiceLock(paths, 'lifecycle', lockIdentity)).toBeUndefined();

    first.release();
    first.release();
    expect(readLocalRuntimeServiceLockIdentity(paths, 'lifecycle')).toBeUndefined();

    const second = tryAcquireLocalRuntimeServiceLock(paths, 'lifecycle', {
      ...lockIdentity,
      nonce: 'second-lock-nonce',
    });
    expect(second).toBeDefined();
    second?.release();
    expect(readdirSync(paths.root).sort()).toEqual([]);
  });

  test('quarantines stale locks atomically and removes only exact cleanup identities', () => {
    const paths = state();
    publishLocalRuntimeServiceDescriptor(paths, descriptor);
    const access = createLocalRuntimeServiceToken();
    const control = createLocalRuntimeServiceToken();
    publishLocalRuntimeServiceToken(paths, 'access', access);
    publishLocalRuntimeServiceToken(paths, 'control', control);
    acquireLocalRuntimeServiceLock(paths, 'instance', lockIdentity);

    const quarantine = quarantineLocalRuntimeServiceLock(paths, 'instance', lockIdentity);
    expect(quarantine?.identity).toEqual(lockIdentity);
    expect(readLocalRuntimeServiceLockIdentity(paths, 'instance')).toBeUndefined();
    expect(quarantine && readdirSync(quarantine.path)).toEqual(['identity.json']);
    quarantine?.remove();

    clearLocalRuntimeServiceState(paths, {
      descriptor,
      accessToken: access,
      controlToken: control,
    });
    expect(readLocalRuntimeServiceDescriptor(paths)).toBeUndefined();
    expect(readLocalRuntimeServiceToken(paths, 'access')).toBeUndefined();
    expect(readLocalRuntimeServiceToken(paths, 'control')).toBeUndefined();
  });

  test('rejects a symlinked root and unexpected lock entries without following them', () => {
    const paths = state();
    const external = join(temporaryRoot!, 'external-root');
    const linkedHome = join(temporaryRoot!, 'linked-home');
    symlinkSync(external, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => ensureLocalRuntimeServiceStateRoot(createKiteHomeIdentity(linkedHome))).toThrow(
      LocalRuntimeServiceStateError,
    );

    const lock = acquireLocalRuntimeServiceLock(paths, 'instance', lockIdentity);
    writeFileSync(join(paths.instanceLock, 'extra'), 'must remain');
    expect(() => readLocalRuntimeServiceLockIdentity(paths, 'instance')).toThrow(
      LocalRuntimeServiceStateError,
    );
    expect(() => lock.release()).toThrow(LocalRuntimeServiceStateError);
    expect(readFileSync(join(paths.instanceLock, 'extra'), 'utf8')).toBe('must remain');
  });
});

test.skipIf(process.platform !== 'win32')(
  'applies and verifies the current-user Windows ACL and rejects permission drift',
  () => {
    const paths = state();
    const access = createLocalRuntimeServiceToken();
    publishLocalRuntimeServiceDescriptor(paths, descriptor);
    publishLocalRuntimeServiceToken(paths, 'access', access);
    const lock = acquireLocalRuntimeServiceLock(paths, 'instance', lockIdentity);
    expect(readLocalRuntimeServiceDescriptor(paths)).toEqual(descriptor);
    expect(readLocalRuntimeServiceToken(paths, 'access')).toBe(access);
    expect(readLocalRuntimeServiceLockIdentity(paths, 'instance')).toEqual(lockIdentity);

    grantWindowsWorldRead(paths.accessToken);
    expect(() => readLocalRuntimeServiceToken(paths, 'access')).toThrow(
      LocalRuntimeServiceStateError,
    );
    lock.release();
  },
  120_000,
);

function grantWindowsWorldRead(path: string): void {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const script = `
$path = $env:KITE_WINDOWS_STATE_TEST_PATH | ConvertFrom-Json
$acl = Get-Acl -LiteralPath $path
$world = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $world,
  [System.Security.AccessControl.FileSystemRights]::Read,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;
  const result = spawnSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        KITE_WINDOWS_STATE_TEST_PATH: JSON.stringify(path),
      },
    },
  );
  if (result.status !== 0) throw new Error('Windows state ACL drift fixture failed.');
}
