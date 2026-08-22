import { dlopen, type Pointer, ptr, read } from 'bun:ffi';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_SEGMENTS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);
export const WINDOWS_SESSION_LOG_ACL_TIMEOUT_MS = 10_000;

export interface SecureSessionStorageOptions {
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
}

export interface SecureSessionLogDirectoryBinding {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
}

let cachedWindowsUserSid: string | undefined;
let windowsAclLibrary:
  | {
      readonly advapi32: WindowsAclApi;
      readonly kernel32: WindowsLocalMemoryApi;
    }
  | undefined;

export function assertSafeSessionLogSegment(value: string, label: string): void {
  const windowsBase = value.split('.')[0]?.toLowerCase() ?? '';
  if (
    !SAFE_SEGMENT.test(value) ||
    value === '.' ||
    value === '..' ||
    value.endsWith('.') ||
    WINDOWS_RESERVED_SEGMENTS.has(windowsBase)
  ) {
    throw new Error(`${label} is not a safe session-log path segment.`);
  }
}

export function secureWindowsOwnerOnlyPath(path: string): void {
  const target = lstatSync(path);
  if (target.isSymbolicLink() || (!target.isDirectory() && !target.isFile())) {
    throw new Error('Windows owner-only ACL targets must be regular files or directories.');
  }
  const sid = resolveCurrentWindowsUserSid();
  applyWindowsOwnerOnlyAcl(path, sid, target.isDirectory());
}

function resolveCurrentWindowsUserSid(): string {
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const result = spawnSync(
    join(systemRoot, 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WINDOWS_SESSION_LOG_ACL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  const sid = result.stdout.match(/\bS-\d+(?:-\d+)+\b/iu)?.[0];
  if (result.status !== 0 || !sid) {
    throw windowsAclError('resolve the current Windows user SID', result);
  }
  cachedWindowsUserSid = sid;
  return sid;
}

/** Apply the complete owner-only ACL with the Windows security API, without a child process. */
function applyWindowsOwnerOnlyAcl(path: string, sid: string, isDirectory: boolean): void {
  const { advapi32, kernel32 } = windowsAclApi();
  const sidText = Buffer.from(`${sid}\0`, 'utf16le');
  const nativePath = Buffer.from(`${path}\0`, 'utf16le');
  const sidOut = new Uint8Array(process.arch === 'ia32' ? 4 : 8);
  if (!advapi32.ConvertStringSidToSidW(ptr(sidText), ptr(sidOut))) {
    throw new Error(`Failed to convert the current Windows user SID for ${JSON.stringify(path)}.`);
  }

  const nativeSid = read.ptr(ptr(sidOut)) as Pointer;
  try {
    const sidLength = advapi32.GetLengthSid(nativeSid);
    // ACL header (8 bytes) + ACCESS_ALLOWED_ACE header/mask/SID offset (12 bytes) + SID.
    const acl = new Uint8Array(8 + 12 + sidLength);
    if (!advapi32.InitializeAcl(ptr(acl), acl.length, 2)) {
      throw new Error(
        `Failed to initialize the Windows session-log ACL for ${JSON.stringify(path)}.`,
      );
    }
    const inheritance = isDirectory ? 0x01 | 0x02 : 0;
    if (!advapi32.AddAccessAllowedAceEx(ptr(acl), 2, inheritance, 0x1f01ff, nativeSid)) {
      throw new Error(
        `Failed to construct the Windows session-log access rule for ${JSON.stringify(path)}.`,
      );
    }
    // SECURITY_DESCRIPTOR is 20 bytes on x86 and 40 bytes on x64. Keep it
    // over-allocated so the API owns the platform-specific layout.
    const descriptor = new Uint8Array(64);
    if (
      !advapi32.InitializeSecurityDescriptor(ptr(descriptor), 1) ||
      !advapi32.SetSecurityDescriptorOwner(ptr(descriptor), nativeSid, false) ||
      !advapi32.SetSecurityDescriptorDacl(ptr(descriptor), true, ptr(acl), false) ||
      !advapi32.SetSecurityDescriptorControl(ptr(descriptor), 0x1000, 0x1000) ||
      !advapi32.SetFileSecurityW(ptr(nativePath), 0x0000_0001 | 0x0000_0004, ptr(descriptor))
    ) {
      throw new Error(
        `Failed to apply an owner-only, non-inheriting session-log ACL to ${JSON.stringify(path)} with the Windows security API.`,
      );
    }
  } finally {
    kernel32.LocalFree(nativeSid);
  }
}

interface WindowsAclApi {
  ConvertStringSidToSidW(sidText: Pointer, sidOut: Pointer): boolean;
  GetLengthSid(sid: Pointer): number;
  InitializeAcl(acl: Pointer, aclLength: number, revision: number): boolean;
  AddAccessAllowedAceEx(
    acl: Pointer,
    revision: number,
    inheritance: number,
    accessMask: number,
    sid: Pointer,
  ): boolean;
  InitializeSecurityDescriptor(descriptor: Pointer, revision: number): boolean;
  SetSecurityDescriptorOwner(descriptor: Pointer, owner: Pointer, defaulted: boolean): boolean;
  SetSecurityDescriptorDacl(
    descriptor: Pointer,
    present: boolean,
    dacl: Pointer,
    defaulted: boolean,
  ): boolean;
  SetSecurityDescriptorControl(
    descriptor: Pointer,
    bitsOfInterest: number,
    bitsToSet: number,
  ): boolean;
  SetFileSecurityW(path: Pointer, securityInformation: number, descriptor: Pointer): boolean;
}

interface WindowsLocalMemoryApi {
  LocalFree(memory: Pointer): Pointer | null;
}

function windowsAclApi(): { advapi32: WindowsAclApi; kernel32: WindowsLocalMemoryApi } {
  if (windowsAclLibrary) return windowsAclLibrary;
  windowsAclLibrary = {
    advapi32: dlopen('advapi32.dll', {
      ConvertStringSidToSidW: { args: ['ptr', 'ptr'], returns: 'bool' },
      GetLengthSid: { args: ['ptr'], returns: 'u32' },
      InitializeAcl: { args: ['ptr', 'u32', 'u32'], returns: 'bool' },
      AddAccessAllowedAceEx: { args: ['ptr', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
      InitializeSecurityDescriptor: { args: ['ptr', 'u32'], returns: 'bool' },
      SetSecurityDescriptorOwner: { args: ['ptr', 'ptr', 'bool'], returns: 'bool' },
      SetSecurityDescriptorDacl: { args: ['ptr', 'bool', 'ptr', 'bool'], returns: 'bool' },
      SetSecurityDescriptorControl: { args: ['ptr', 'u16', 'u16'], returns: 'bool' },
      SetFileSecurityW: { args: ['ptr', 'u32', 'ptr'], returns: 'bool' },
    }).symbols,
    kernel32: dlopen('kernel32.dll', {
      LocalFree: { args: ['ptr'], returns: 'ptr' },
    }).symbols,
  };
  return windowsAclLibrary;
}

function windowsAclError(action: string, result: ReturnType<typeof spawnSync>): Error {
  const detail = `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`
    .trim()
    .replaceAll(/\s+/g, ' ')
    .slice(0, 512);
  return new Error(
    `Failed to ${action} (status ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}).`,
  );
}

export function ensureSecureSessionLogDirectory(
  path: string,
  options: SecureSessionStorageOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const secureWindowsPath = options.secureWindowsPath ?? secureWindowsOwnerOnlyPath;
  const parentPath = dirname(path);
  const parentBefore = lstatSync(parentPath);
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
    throw new Error('Session-log parent must be a real directory.');
  }
  assertOwnedByCurrentUser(parentBefore.uid, platform);
  if (platform !== 'win32' && (parentBefore.mode & 0o022) !== 0) {
    throw new Error('Session-log parent must not be group/world writable.');
  }
  if (existsSync(path)) {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error('Session-log directories must be real directories, not links.');
    }
  } else {
    mkdirSync(path, { recursive: false, mode: 0o700 });
  }

  const after = lstatSync(path);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new Error('Session-log directory identity changed during setup.');
  }
  assertOwnedByCurrentUser(after.uid, platform);
  if (platform === 'win32') secureWindowsPath(path);
  else chmodSync(path, 0o700);
  const parentAfter = lstatSync(parentPath);
  const finalTarget = lstatSync(path);
  if (
    parentAfter.isSymbolicLink() ||
    !parentAfter.isDirectory() ||
    parentAfter.dev !== parentBefore.dev ||
    parentAfter.ino !== parentBefore.ino ||
    finalTarget.isSymbolicLink() ||
    !finalTarget.isDirectory() ||
    finalTarget.dev !== after.dev ||
    finalTarget.ino !== after.ino
  ) {
    throw new Error('Session-log directory ancestry changed during setup.');
  }
  const expectedParent = normalizeIdentityPath(realpathSync(parentPath), platform);
  const actualParent = normalizeIdentityPath(dirname(realpathSync(path)), platform);
  if (actualParent !== expectedParent) {
    throw new Error('Session-log directory escaped its canonical parent.');
  }
}

export function ensureSecureSessionLogDirectoryChain(
  paths: readonly string[],
  options: SecureSessionStorageOptions = {},
): void {
  for (const path of paths) ensureSecureSessionLogDirectory(path, options);
}

export function captureSecureSessionLogDirectoryChain(
  paths: readonly string[],
  options: SecureSessionStorageOptions = {},
): readonly SecureSessionLogDirectoryBinding[] {
  const platform = options.platform ?? process.platform;
  return paths.map((path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Session-log directory chain must contain only real directories.');
    }
    assertOwnedByCurrentUser(info.uid, platform);
    return {
      path,
      canonicalPath: normalizeIdentityPath(realpathSync(path), platform),
      dev: info.dev,
      ino: info.ino,
    };
  });
}

export function assertSecureSessionLogDirectoryChainIdentity(
  bindings: readonly SecureSessionLogDirectoryBinding[],
  options: SecureSessionStorageOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  for (const binding of bindings) {
    const current = lstatSync(binding.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== binding.dev ||
      current.ino !== binding.ino ||
      normalizeIdentityPath(realpathSync(binding.path), platform) !== binding.canonicalPath
    ) {
      throw new Error('Session-log directory chain identity changed after setup.');
    }
    assertOwnedByCurrentUser(current.uid, platform);
  }
}

export function openSecureAppendFile(
  path: string,
  options: SecureSessionStorageOptions = {},
): { fd: number; size: number; identity: { dev: number; ino: number } } {
  const platform = options.platform ?? process.platform;
  const secureWindowsPath = options.secureWindowsPath ?? secureWindowsOwnerOnlyPath;
  if (existsSync(path)) {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error('Session-log targets must be regular single-link files.');
    }
    assertOwnedByCurrentUser(before.uid, platform);
  }

  const noFollow = platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error('Opened session-log target is not a regular single-link file.');
    }
    assertOwnedByCurrentUser(opened.uid, platform);
    if (platform === 'win32') secureWindowsPath(path);
    else chmodSync(path, 0o600);
    return {
      fd,
      size: opened.size,
      identity: { dev: opened.dev, ino: opened.ino },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function unlinkSecureFileIfIdentity(
  path: string,
  identity: { dev: number; ino: number },
): boolean {
  try {
    const current = lstatSync(path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function assertSecureOpenFileIdentity(
  fd: number,
  path: string,
  options: SecureSessionStorageOptions = {},
): number {
  const platform = options.platform ?? process.platform;
  const opened = fstatSync(fd);
  const current = lstatSync(path);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1
  ) {
    throw new Error('Session-log append target is no longer a regular single-link file.');
  }
  assertOwnedByCurrentUser(opened.uid, platform);
  assertOwnedByCurrentUser(current.uid, platform);
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error('Session-log append target identity changed after opening.');
  }
  return opened.size;
}

export function writeSessionLogJsonAtomically(
  target: string,
  value: unknown,
  options: SecureSessionStorageOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const secureWindowsPath = options.secureWindowsPath ?? secureWindowsOwnerOnlyPath;
  ensureSecureSessionLogDirectory(dirname(target), options);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error('Session-log metadata target must not be a link.');
  }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    const noFollow = platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (platform === 'win32') secureWindowsPath(temporary);
    else chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    if (platform === 'win32') secureWindowsPath(target);
    else chmodSync(target, 0o600);
    fsyncDirectory(dirname(target), platform);
  } catch (error) {
    if (fd != null) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function assertSecureOwnedRegularFile(
  path: string,
  options: SecureSessionStorageOptions = {},
): number {
  const platform = options.platform ?? process.platform;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error('Session-log cleanup only accepts regular single-link files.');
  }
  assertOwnedByCurrentUser(info.uid, platform);
  if (platform !== 'win32') chmodSync(path, 0o600);
  else (options.secureWindowsPath ?? secureWindowsOwnerOnlyPath)(path);
  return statSync(path).size;
}

function fsyncDirectory(path: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertOwnedByCurrentUser(uid: number, platform: NodeJS.Platform): void {
  if (platform === 'win32' || typeof process.getuid !== 'function') return;
  if (uid !== process.getuid()) {
    throw new Error('Session-log storage is not owned by the current OS user.');
  }
}

function normalizeIdentityPath(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.toLowerCase() : path;
}
