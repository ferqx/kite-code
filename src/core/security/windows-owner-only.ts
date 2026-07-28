import { spawnSync } from 'node:child_process';

/** Apply a non-inheriting ACL granting full control only to the current Windows user. */
export function secureWindowsOwnerOnlyPath(path: string): void {
  const script = `
$item = Get-Item -LiteralPath $env:KITE_OWNER_ONLY_PATH -Force
$acl = Get-Acl -LiteralPath $item.FullName
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner -ne $identity) { throw 'Path is not owned by the current Windows user.' }
$principal = {
  param($value)
  if ($value -match '^S-') { return "*$value" }
  return $value
}
& icacls.exe $item.FullName /inheritance:r /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls inheritance removal failed with exit code $LASTEXITCODE." }
$acl = Get-Acl -LiteralPath $item.FullName
foreach ($rule in @($acl.Access)) {
  $rulePrincipal = & $principal $rule.IdentityReference.Value
  $removeSwitch = if ($rule.AccessControlType -eq 'Deny') { '/remove:d' } else { '/remove:g' }
  & icacls.exe $item.FullName $removeSwitch $rulePrincipal /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls explicit rule removal failed with exit code $LASTEXITCODE." }
}
$grant = if ($item.PSIsContainer) {
  "*$($identity.Value):(OI)(CI)F"
} else {
  "*$($identity.Value):F"
}
& icacls.exe $item.FullName /grant:r $grant /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE." }
$verified = Get-Acl -LiteralPath $item.FullName
$allow = @($verified.Access | Where-Object AccessControlType -eq Allow)
$deny = @($verified.Access | Where-Object AccessControlType -eq Deny)
if (-not $verified.AreAccessRulesProtected -or $deny.Count -ne 0 -or $allow.Count -ne 1) {
  throw 'Owner-only ACL verification failed.'
}
$verifiedIdentity = $allow[0].IdentityReference.Translate(
  [System.Security.Principal.SecurityIdentifier]
)
if ($verifiedIdentity -ne $identity) { throw 'Owner-only ACL identity verification failed.' }
`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, KITE_OWNER_ONLY_PATH: path },
    },
  );
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Failed to apply an owner-only, non-inheriting Windows ACL.${detail ? ` ${detail}` : ''}`,
    );
  }
}
