param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Sha256,
  [Parameter(Mandatory = $true)][string]$ZstdArchive,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Bun = 'bun.exe',
  [switch]$Fixture
)

$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path -LiteralPath $Archive).ProviderPath
$decoderArchive = (Resolve-Path -LiteralPath $ZstdArchive).ProviderPath
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
if ([IO.Path]::GetExtension($output) -ine '.exe' -or
    (Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath ($output + '.sha256'))) {
  throw 'Choose a new .exe output path.'
}
if ((Get-FileHash -LiteralPath $decoderArchive -Algorithm SHA256).Hash -ine
    'eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3') {
  throw 'Expected the verified Zstandard 1.5.7 release source archive.'
}

$bunPath = (Get-Command $Bun -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$gitPath = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$bash = Join-Path (Split-Path -Parent (Split-Path -Parent $gitPath)) 'bin/bash.exe'
$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio -or -not (Test-Path -LiteralPath $bash)) {
  throw 'MSVC x64 Build Tools and Git for Windows are required.'
}
$devShell = Join-Path $visualStudio 'Common7/Tools/Launch-VsDevShell.ps1'
& $devShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).ProviderPath
$cacheRoot = New-Item -ItemType Directory -Path (Join-Path $repo '.cache') -Force
$cacheDirectory = New-Item -ItemType Directory -Path (Join-Path $cacheRoot.FullName 'windows-setup-build') -Force
if (($cacheRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($cacheDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Windows setup build cache must be a local directory.'
}
$cache = $cacheDirectory.FullName
$work = (New-Item -ItemType Directory -Path (Join-Path $cache ([guid]::NewGuid().ToString()))).FullName
$zstd = Join-Path $work 'zstd-1.5.7'
$decoderTools = Join-Path $zstd 'build/single_file_libs'
$decoder = Join-Path $decoderTools 'zstddeclib.c'
$zstdInclude = Join-Path $zstd 'lib'
$buildOutput = Join-Path $work 'setup.exe'
$defines = @('/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00')
if ($Fixture) { $defines += '/DKITE_SETUP_FIXTURE' }
$linkOptions = @('/nologo', '/MACHINE:X64', '/SUBSYSTEM:WINDOWS', '/DYNAMICBASE',
  '/NXCOMPAT', '/HIGHENTROPYVA', '/MANIFEST:NO')
$objects = @('setup.obj', 'location-dialog.obj', 'shell-integration.obj', 'zstddeclib.obj')
$libraries = @('kernel32.lib', 'user32.lib', 'advapi32.lib', 'bcrypt.lib', 'shell32.lib',
  'ole32.lib', 'uuid.lib', 'gdi32.lib', 'comctl32.lib')

Push-Location -LiteralPath $work
try {
  & "$env:WINDIR\System32\tar.exe" -xf $decoderArchive -C $work 'zstd-1.5.7/LICENSE' 'zstd-1.5.7/lib' 'zstd-1.5.7/build/single_file_libs'
  if ($LASTEXITCODE) { throw 'Zstandard source extraction failed.' }
  Push-Location -LiteralPath $decoderTools
  try {
    & $bash './create_single_file_decoder.sh' | Out-Host
    if ($LASTEXITCODE) { throw 'Zstandard decoder preparation failed.' }
  } finally {
    Pop-Location
  }
  & $bunPath run (Join-Path $PSScriptRoot 'prepare.ts') $bundle $Sha256 (Join-Path $zstd 'LICENSE') $work
  if ($LASTEXITCODE) { throw 'Windows setup payload preparation failed.' }
  & cl.exe /nologo /c /MT /O2 /utf-8 /W3 /Fozstddeclib.obj $decoder
  if ($LASTEXITCODE) { throw 'Zstandard decoder compilation failed.' }
  & cl.exe /nologo /c /MT /O2 /utf-8 /std:c++17 /EHsc /W4 @defines "/I$zstdInclude" "/I$work" (Join-Path $PSScriptRoot 'setup.cc') (Join-Path $PSScriptRoot 'location-dialog.cc') (Join-Path $PSScriptRoot 'shell-integration.cc')
  if ($LASTEXITCODE) { throw 'Windows setup compilation failed.' }
  & rc.exe /nologo /fo maintenance.res /i $PSScriptRoot maintenance.rc
  if ($LASTEXITCODE) { throw 'Windows desktop maintenance resource compilation failed.' }
  & link.exe @linkOptions /OUT:maintenance.exe @objects maintenance.res @libraries
  if ($LASTEXITCODE) { throw 'Windows desktop maintenance linking failed.' }
  & rc.exe /nologo /fo setup.res /i $PSScriptRoot setup.rc
  if ($LASTEXITCODE) { throw 'Windows setup resource compilation failed.' }
  & link.exe @linkOptions "/OUT:$buildOutput" @objects setup.res @libraries
  if ($LASTEXITCODE) { throw 'Windows setup linking failed.' }

  New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
  [IO.File]::Move($buildOutput, $output)
  $digest = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
  $name = [IO.Path]::GetFileName($output)
  [IO.File]::WriteAllText($output + '.sha256', $digest + '  ' + $name + [char]10)
  [PSCustomObject]@{ Setup = $output; Bytes = (Get-Item -LiteralPath $output).Length; SHA256 = $digest }
} finally {
  Pop-Location
  $resolved = (Resolve-Path -LiteralPath $work).ProviderPath
  $scratch = Get-Item -LiteralPath $resolved -Force
  if ($resolved -ceq $work -and $scratch.Parent.FullName -ceq $cache -and
      -not ($scratch.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
      -not (Get-ChildItem -LiteralPath $resolved -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
