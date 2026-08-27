import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WINDOWS_STATE_SECURITY_TIMEOUT_MS = 10_000;

const WINDOWS_STATE_SECURITY_SCRIPT = `
$path = $env:KITE_WINDOWS_STATE_PATH | ConvertFrom-Json
$kind = $env:KITE_WINDOWS_STATE_KIND
$action = $env:KITE_WINDOWS_STATE_ACTION
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User

function Read-KiteStateItem {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 41 }
  if ($kind -eq 'directory' -and -not $item.PSIsContainer) { exit 42 }
  if ($kind -eq 'file' -and $item.PSIsContainer) { exit 42 }
  return $item
}

$item = Read-KiteStateItem
if ($action -eq 'secure') {
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
  Set-Acl -LiteralPath $path -AclObject $acl -ErrorAction Stop
}

$item = Read-KiteStateItem
$acl = Get-Acl -LiteralPath $path -ErrorAction Stop
if (-not $acl.AreAccessRulesProtected) { exit 43 }
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $identity.Value) { exit 44 }
$rules = @($acl.Access)
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

export function secureWindowsStatePath(path: string, kind: WindowsStatePathKind): void {
  runWindowsStateSecurity('secure', path, kind);
}

export function verifyWindowsStatePath(path: string, kind: WindowsStatePathKind): void {
  runWindowsStateSecurity('verify', path, kind);
}

function runWindowsStateSecurity(
  action: 'secure' | 'verify',
  path: string,
  kind: WindowsStatePathKind,
): void {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(WINDOWS_STATE_SECURITY_SCRIPT, 'utf16le').toString('base64');
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WINDOWS_STATE_SECURITY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        SystemRoot: systemRoot,
        SYSTEMROOT: systemRoot,
        PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        KITE_WINDOWS_STATE_ACTION: action,
        KITE_WINDOWS_STATE_KIND: kind,
        KITE_WINDOWS_STATE_PATH: JSON.stringify(path),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Windows state ${action} failed with status ${result.status ?? 'unknown'}.`);
  }
}
