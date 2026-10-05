import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

const environmentKeys = [
  'PATH',
  'INCLUDE',
  'LIB',
  'LIBPATH',
  'VCToolsInstallDir',
  'VCToolsVersion',
  'WindowsSdkDir',
  'WindowsSDKVersion',
  'VSCMD_ARG_HOST_ARCH',
  'VSCMD_ARG_TGT_ARCH',
] as const;
type EnvironmentKey = (typeof environmentKeys)[number];
type BuildEnvironment = Record<EnvironmentKey, string>;
const keysByUppercase = new Map(environmentKeys.map((key) => [key.toUpperCase(), key]));

function hasControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}
function localPath(value: string): string {
  if (!/^[A-Za-z]:\\/.test(value) || hasControl(value) || /["&|<>^%!]/.test(value))
    throw Error('windows_native_ci_path_invalid');
  return value;
}

/** Only the finite compiler environment is retained; prefix matches from `set` are ignored. */
export function parseWindowsBuildEnvironment(stdout: string): BuildEnvironment {
  if (Buffer.byteLength(stdout, 'utf8') > 262144)
    throw Error('windows_native_ci_environment_invalid');
  const values = new Map<EnvironmentKey, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw Error('windows_native_ci_environment_invalid');
    const key = keysByUppercase.get(line.slice(0, separator).toUpperCase());
    if (!key) continue;
    const value = line.slice(separator + 1);
    if (!value || hasControl(value) || (values.has(key) && values.get(key) !== value))
      throw Error('windows_native_ci_environment_invalid');
    values.set(key, value);
  }
  if (environmentKeys.some((key) => !values.has(key)))
    throw Error('windows_native_ci_environment_incomplete');
  const result = Object.fromEntries(values) as BuildEnvironment;
  if (result.VSCMD_ARG_HOST_ARCH !== 'x64' || result.VSCMD_ARG_TGT_ARCH !== 'x64')
    throw Error('windows_native_ci_arch_invalid');
  if (
    !/^\d+(?:\.\d+){2,3}$/.test(result.VCToolsVersion) ||
    !/^\d+(?:\.\d+){3}\\?$/.test(result.WindowsSDKVersion)
  )
    throw Error('windows_native_ci_version_invalid');
  localPath(result.VCToolsInstallDir);
  localPath(result.WindowsSdkDir);
  return result;
}

export function windowsBuildEnvironmentCommand(devCommand: string): string {
  localPath(devCommand);
  // /s strips the outer pair. The installed batch path stays quoted; no value is echoed.
  return `"call "${devCommand}" -arch=x64 -host_arch=x64 >nul && ${environmentKeys.map((key) => `set ${key}`).join(' && ')}"`;
}

export function decodeWindowsToolOutput(bytes: Uint8Array, encoding: 'utf8' | 'utf16le'): string {
  try {
    return new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'utf-16le', { fatal: true }).decode(
      bytes,
    );
  } catch {
    throw Error('windows_native_ci_tool_encoding_invalid');
  }
}

function run(
  executable: string,
  args: string[],
  timeout: number,
  verbatim = false,
  encoding: 'utf8' | 'utf16le' = 'utf8',
): string {
  const result = spawnSync(executable, args, {
    timeout,
    maxBuffer: 262144,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    env: { ...process.env, CL: '', _CL_: '', NODE_OPTIONS: '', NODE_PATH: '', BUN_OPTIONS: '' },
  });
  // Do not print captured environment, VS diagnostics or inherited secret values on failure.
  if (result.error || result.status !== 0 || result.signal)
    throw Error('windows_native_ci_tool_failed');
  return decodeWindowsToolOutput(result.stdout, encoding);
}

function directory(path: string): string {
  const canonical = localPath(realpathSync(localPath(path)));
  if (!statSync(canonical).isDirectory()) throw Error('windows_native_ci_directory_unavailable');
  return canonical;
}
function file(path: string): string {
  const canonical = localPath(realpathSync(localPath(path)));
  if (!statSync(canonical).isFile()) throw Error('windows_native_ci_file_unavailable');
  return canonical;
}

/** Hosted-CI setup only. No downloads, PATH compiler discovery or installed Main behavior. */
export function prepareWindowsNativeCI(): void {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_native_ci_platform_unsupported');
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows')
    throw Error('windows_native_ci_runner_required');
  const programFiles = directory(process.env['ProgramFiles(x86)'] ?? ''),
    systemRoot = directory(process.env.SystemRoot ?? ''),
    environmentFile = file(process.env.GITHUB_ENV ?? ''),
    vswhere = file(win32.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')),
    cmd = file(win32.join(systemRoot, 'System32/cmd.exe'));
  const installations = run(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
      '-utf8',
    ],
    15000,
  )
    .split(/\r?\n/)
    .filter((line) => line !== '');
  if (installations.length !== 1) throw Error('windows_native_ci_installation_unavailable');
  const installation = directory(installations[0]!),
    devCommand = file(win32.join(installation, 'Common7/Tools/VsDevCmd.bat')),
    prepared = parseWindowsBuildEnvironment(
      run(
        cmd,
        ['/d', '/u', '/s', '/c', windowsBuildEnvironmentCommand(devCommand)],
        30000,
        true,
        'utf16le',
      ),
    ),
    toolset = directory(prepared.VCToolsInstallDir),
    sdk = directory(prepared.WindowsSdkDir),
    sdkVersion = prepared.WindowsSDKVersion.replace(/\\$/, ''),
    compiler = file(win32.join(toolset, 'bin/Hostx64/x64/cl.exe'));
  if (
    win32.relative(installation, toolset).startsWith('..') ||
    win32.isAbsolute(win32.relative(installation, toolset))
  )
    throw Error('windows_native_ci_toolset_invalid');
  for (const header of ['ucrt/stdio.h', 'shared/sdkddkver.h', 'um/windows.h', 'um/bcrypt.h'])
    file(win32.join(sdk, 'Include', sdkVersion, header));
  for (const library of ['um/x64/advapi32.lib', 'um/x64/bcrypt.lib', 'ucrt/x64/ucrt.lib'])
    file(win32.join(sdk, 'Lib', sdkVersion, library));
  const output = [
    ...environmentKeys.map((key) => `${key}=${prepared[key]}`),
    `KITE_WINDOWS_MSVC=${compiler}`,
    'CL=',
    '_CL_=',
  ].join('\n');
  appendFileSync(environmentFile, `${output}\n`, 'utf8');
  const hash = createHash('sha256').update(readFileSync(compiler)).digest('hex');
  console.log(
    `Windows x64 Native compiler prepared: toolset=${prepared.VCToolsVersion} sdk=${sdkVersion} compilerSha256=${hash}`,
  );
}

if (import.meta.main) prepareWindowsNativeCI();
