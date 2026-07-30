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
  const script = `
$item = Get-Item -LiteralPath $env:KITE_SESSION_LOG_ACL_PATH -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 41 }
$acl = Get-Acl -LiteralPath $item.FullName
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$inheritance = if ($item.PSIsContainer) {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetOwner($identity)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $item.FullName -AclObject $acl
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, KITE_SESSION_LOG_ACL_PATH: path },
    },
  );
  if (result.status !== 0) {
    throw new Error('Failed to apply an owner-only, non-inheriting session-log ACL.');
  }
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
