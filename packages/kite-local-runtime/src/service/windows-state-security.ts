import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WINDOWS_STATE_SECURITY_TIMEOUT_MS = 30_000;

const WINDOWS_STATE_SECURITY_SCRIPT = `
$path = [Text.Encoding]::Unicode.GetString(
  [Convert]::FromBase64String($env:KITE_WINDOWS_STATE_PATH_B64)
)
$kind = $env:KITE_WINDOWS_STATE_KIND
$action = $env:KITE_WINDOWS_STATE_ACTION
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User

function Read-KiteStateItem {
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 41 }
  if ($kind -eq 'directory') {
    if (-not [IO.Directory]::Exists($path) -or [IO.File]::Exists($path)) { exit 42 }
    return [IO.DirectoryInfo]::new($path)
  }
  if (-not [IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) { exit 42 }
  return [IO.FileInfo]::new($path)
}

$item = Read-KiteStateItem
if ($action -eq 'secure') {
  $existingAcl = $item.GetAccessControl(
    [System.Security.AccessControl.AccessControlSections]::All
  )
  $existingOwner = $existingAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if (
    $existingOwner.Value -ne $identity.Value -and
    $env:KITE_WINDOWS_STATE_ALLOW_OWNER_INITIALIZATION -ne '1'
  ) { exit 44 }
  if ($kind -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance =
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  $item.SetAccessControl($acl)
}

$item = Read-KiteStateItem
$acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::All)
if (-not $acl.AreAccessRulesProtected) { exit 43 }
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $identity.Value) { exit 44 }
$rules = $acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
)
if ($rules.Count -eq 0) { exit 45 }
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
  if ($sid.Value -ne $identity.Value) { exit 46 }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 47 }
  if ($rule.IsInherited) { exit 48 }
  if (
    ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
    [System.Security.AccessControl.FileSystemRights]::FullControl
  ) { exit 49 }
}
`;

export type WindowsStatePathKind = 'directory' | 'file';

export class WindowsStateSecurityError extends Error {
  readonly diagnostic: string;

  constructor(diagnostic: string) {
    super(`Windows state security failed: ${diagnostic}.`);
    this.name = 'WindowsStateSecurityError';
    this.diagnostic = diagnostic;
  }
}

export function windowsStateSecurityDiagnostic(error: unknown): string | undefined {
  return error instanceof WindowsStateSecurityError ? error.diagnostic : undefined;
}

export function secureWindowsStatePath(
  path: string,
  kind: WindowsStatePathKind,
  options: { readonly allowOwnerInitialization?: boolean } = {},
): void {
  runWindowsStateSecurity('secure', path, kind, options.allowOwnerInitialization === true);
}

export function verifyWindowsStatePath(path: string, kind: WindowsStatePathKind): void {
  runWindowsStateSecurity('verify', path, kind);
}

function runWindowsStateSecurity(
  action: 'secure' | 'verify',
  path: string,
  kind: WindowsStatePathKind,
  allowOwnerInitialization = false,
): void {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(WINDOWS_STATE_SECURITY_SCRIPT, 'utf16le').toString('base64');
  const runtimeEnvironment = windowsPowerShellRuntimeEnvironment();
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WINDOWS_STATE_SECURITY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        ...runtimeEnvironment,
        SystemRoot: systemRoot,
        SYSTEMROOT: systemRoot,
        PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        KITE_WINDOWS_STATE_ACTION: action,
        KITE_WINDOWS_STATE_ALLOW_OWNER_INITIALIZATION: allowOwnerInitialization ? '1' : '0',
        KITE_WINDOWS_STATE_KIND: kind,
        KITE_WINDOWS_STATE_PATH_B64: Buffer.from(path, 'utf16le').toString('base64'),
      },
    },
  );
  if (result.status !== 0) {
    const timedOut =
      result.error !== undefined &&
      typeof result.error === 'object' &&
      'code' in result.error &&
      result.error.code === 'ETIMEDOUT';
    throw new WindowsStateSecurityError(
      timedOut ? `${action}_timeout` : `${action}_status_${result.status ?? 'unknown'}`,
    );
  }
}

function windowsPowerShellRuntimeEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    'APPDATA',
    'COMSPEC',
    'LOCALAPPDATA',
    'PATHEXT',
    'PROGRAMDATA',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ]) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
