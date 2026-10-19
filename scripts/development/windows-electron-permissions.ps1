$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$pins = [Collections.Generic.List[IDisposable]]::new()
try {
    $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ((($inputValue.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'executable,packageDirectory') {
        throw 'development_electron_runtime_scope_invalid'
    }
    $package = [IO.Path]::GetFullPath($inputValue.packageDirectory)
    $runtime = Join-Path $package 'dist'
    $executable = Join-Path $runtime 'electron.exe'
    if (-not [String]::Equals($executable, [IO.Path]::GetFullPath($inputValue.executable), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'development_electron_runtime_scope_invalid'
    }
    # Pins prevent rename/reparse replacement while ACLs are read and amended.
    # Handles request attributes only and never share DELETE; no ACL is changed here.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class ElectronRuntimePin {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint size, uint flags);
    public static SafeFileHandle Open(string path, bool directory) {
        var handle = CreateFileW(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        try {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            Info info;
            if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1))
                throw new InvalidOperationException("development_electron_runtime_scope_invalid");
            var buffer = new StringBuilder(32768);
            var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
            var actual = buffer.ToString();
            if (actual.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) actual = @"\\" + actual.Substring(8);
            else if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual.Substring(4);
            if (!String.Equals(Path.GetFullPath(path), actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("development_electron_runtime_scope_invalid");
            return handle;
        } catch { handle.Dispose(); throw; }
    }
}
'@
    $ancestors = [Collections.Generic.Stack[string]]::new()
    $ancestor = $runtime
    while ($ancestor) {
        $ancestors.Push($ancestor)
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    while ($ancestors.Count) { $pins.Add([ElectronRuntimePin]::Open($ancestors.Pop(), $true)) }
    $metadata = Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw | ConvertFrom-Json
    $version = (Get-Content -LiteralPath (Join-Path $runtime 'version') -Raw).Trim() -replace '^v', ''
    if ($metadata.name -ne 'electron' -or $metadata.version -ne $version) { throw 'development_electron_runtime_scope_invalid' }
    $entries = [Collections.Generic.List[string]]::new()
    $directories = [Collections.Generic.Stack[string]]::new()
    $entries.Add($runtime)
    $directories.Push($runtime)
    while ($directories.Count) {
        $directory = $directories.Pop()
        foreach ($path in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $item = Get-Item -LiteralPath $path -Force
            $pins.Add([ElectronRuntimePin]::Open($path, $item.PSIsContainer))
            $entries.Add($path)
            if ($item.PSIsContainer) { $directories.Push($path) }
        }
    }
    # Preflight every original ACL before changing any. Explicit deny is not overridden.
    $sid = [Security.Principal.SecurityIdentifier]::new('S-1-15-2-2')
    $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    $pending = [Collections.Generic.List[object]]::new()
    foreach ($path in $entries) {
        $isDirectory = ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0
        $acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
        $granted = 0
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.IdentityReference.Value -ne $sid.Value -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
            if ($rule.AccessControlType -eq 'Deny' -and ($rule.FileSystemRights -band $rights)) { throw 'development_electron_permissions_denied' }
            if ($rule.AccessControlType -eq 'Allow') { $granted = $granted -bor $rule.FileSystemRights }
        }
        if (($granted -band $rights) -ne $rights) { $pending.Add([pscustomobject]@{ Path=$path; Acl=$acl; Directory=$isDirectory }) }
    }
    foreach ($entry in $pending) {
        # Explicit, non-inheriting RX on this physical object only. Keep all original
        # ACEs, ownership and inheritance settings; never propagate outside the inventory.
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [Security.AccessControl.AccessControlType]::Allow)
        $entry.Acl.AddAccessRule($rule)
        if ($entry.Directory) {
            [IO.Directory]::SetAccessControl($entry.Path, $entry.Acl)
            $actual = [IO.Directory]::GetAccessControl($entry.Path)
        } else {
            [IO.File]::SetAccessControl($entry.Path, $entry.Acl)
            $actual = [IO.File]::GetAccessControl($entry.Path)
        }
        $granted = 0
        foreach ($check in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($check.IdentityReference.Value -eq $sid.Value -and $check.AccessControlType -eq 'Allow' -and -not ($check.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { $granted = $granted -bor $check.FileSystemRights }
        }
        if (($granted -band $rights) -ne $rights) { throw 'development_electron_permissions_failed' }
    }
    [Console]::WriteLine((@{ok=$true;checked=$entries.Count;repaired=$pending.Count} | ConvertTo-Json -Compress))
} catch {
    $code = $_.Exception.GetBaseException().Message
    if ($code -notin @('development_electron_runtime_scope_invalid','development_electron_permissions_denied')) { $code='development_electron_permissions_failed' }
    [Console]::WriteLine((@{ok=$false;code=$code} | ConvertTo-Json -Compress))
    exit 1
} finally {
    for ($index=$pins.Count-1; $index -ge 0; $index--) { $pins[$index].Dispose() }
}
