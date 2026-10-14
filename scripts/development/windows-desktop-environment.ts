import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  decodeWindowsToolOutput,
  parseWindowsBuildEnvironment,
  windowsBuildEnvironmentCommand,
  windowsBuildEnvironmentKeys,
} from '../release/prepare-windows-native-ci';

type Environment = Record<string, string | undefined>;
export interface WindowsDesktopBuildTools {
  file(path: string): string;
  directory(path: string): string;
  run(
    executable: string,
    args: string[],
    options: { env: Environment; timeout: number; unicode?: boolean; verbatim?: boolean },
  ): string;
}

function installedPath(path: string, kind: 'file' | 'directory'): string {
  try {
    if (!/^[A-Za-z]:\\/.test(path)) throw Error('invalid_path');
    const canonical = realpathSync(path),
      info = statSync(canonical);
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw Error('invalid_path');
    return canonical;
  } catch {
    throw Error('windows_desktop_build_tools_unavailable');
  }
}

const installedTools: WindowsDesktopBuildTools = {
  file: (path) => installedPath(path, 'file'),
  directory: (path) => installedPath(path, 'directory'),
  run(executable, args, options) {
    const result = spawnSync(executable, args, {
      env: options.env,
      timeout: options.timeout,
      maxBuffer: 262144,
      windowsHide: true,
      windowsVerbatimArguments: options.verbatim,
    });
    if (result.error || result.status !== 0 || result.signal)
      throw Error('windows_desktop_build_environment_failed');
    try {
      return decodeWindowsToolOutput(result.stdout, options.unicode ? 'utf16le' : 'utf8');
    } catch {
      throw Error('windows_desktop_build_environment_failed');
    }
  },
};

function environmentValue(env: Environment, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

function updateEnvironment(env: Environment, updates: Environment): void {
  const updatedKeys = new Set(Object.keys(updates).map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) if (updatedKeys.has(key.toUpperCase())) delete env[key];
  Object.assign(env, updates);
}

/** Development-only setup. The native builder still receives an explicit canonical compiler. */
export function initializeDesktopBuildEnvironment(
  input: {
    env?: Environment;
    platform?: NodeJS.Platform;
    arch?: string;
    tools?: WindowsDesktopBuildTools;
  } = {},
): void {
  if ((input.platform ?? process.platform) !== 'win32') return;
  if ((input.arch ?? process.arch) !== 'x64')
    throw Error('windows_desktop_build_platform_unsupported');
  const env = input.env ?? process.env,
    tools = input.tools ?? installedTools,
    explicitCompiler = environmentValue(env, 'KITE_WINDOWS_MSVC');
  let compiler: string | undefined;
  if (explicitCompiler) {
    try {
      if (!win32.isAbsolute(explicitCompiler)) throw Error('invalid_compiler');
      compiler = tools.file(explicitCompiler);
    } catch {
      throw Error('windows_desktop_compiler_override_invalid');
    }
  }
  const keys = new Set(windowsBuildEnvironmentKeys.map((key) => key.toUpperCase()));
  let prepared: ReturnType<typeof parseWindowsBuildEnvironment> | undefined;
  try {
    prepared = parseWindowsBuildEnvironment(
      Object.entries(env)
        .filter(([key, value]) => keys.has(key.toUpperCase()) && value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
  } catch {
    // A regular shell, incomplete SDK environment or x86 prompt needs x64 initialization.
  }
  if (!prepared) {
    const vswhere = tools.file(
        win32.join(
          environmentValue(env, 'ProgramFiles(x86)') ?? '',
          'Microsoft Visual Studio/Installer/vswhere.exe',
        ),
      ),
      cmd = tools.file(win32.join(environmentValue(env, 'SystemRoot') ?? '', 'System32/cmd.exe')),
      childEnv = { ...env };
    updateEnvironment(childEnv, {
      CL: '',
      _CL_: '',
      NODE_OPTIONS: '',
      NODE_PATH: '',
      BUN_OPTIONS: '',
    });
    const installations = tools
      .run(
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
        { env: childEnv, timeout: 15000 },
      )
      .split(/\r?\n/)
      .filter((line) => line !== '');
    if (installations.length !== 1) throw Error('windows_desktop_build_tools_unavailable');
    const installation = tools.directory(installations[0]!),
      devCommand = tools.file(win32.join(installation, 'Common7/Tools/VsDevCmd.bat'));
    try {
      prepared = parseWindowsBuildEnvironment(
        tools.run(cmd, ['/d', '/u', '/s', '/c', windowsBuildEnvironmentCommand(devCommand)], {
          env: childEnv,
          timeout: 30000,
          unicode: true,
          verbatim: true,
        }),
      );
    } catch {
      throw Error('windows_desktop_build_environment_failed');
    }
    const relativeToolset = win32.relative(
      installation,
      tools.directory(prepared.VCToolsInstallDir),
    );
    if (relativeToolset.startsWith('..') || win32.isAbsolute(relativeToolset))
      throw Error('windows_desktop_build_environment_failed');
  }
  const toolset = tools.directory(prepared.VCToolsInstallDir),
    sdk = tools.directory(prepared.WindowsSdkDir),
    sdkVersion = prepared.WindowsSDKVersion.replace(/\\$/, '');
  compiler ??= tools.file(win32.join(toolset, 'bin/Hostx64/x64/cl.exe'));
  for (const header of ['ucrt/stdio.h', 'shared/sdkddkver.h', 'um/windows.h', 'shared/bcrypt.h'])
    tools.file(win32.join(sdk, 'Include', sdkVersion, header));
  for (const library of ['um/x64/advapi32.lib', 'um/x64/bcrypt.lib', 'ucrt/x64/ucrt.lib'])
    tools.file(win32.join(sdk, 'Lib', sdkVersion, library));
  updateEnvironment(env, { ...prepared, KITE_WINDOWS_MSVC: compiler, CL: '', _CL_: '' });
}
