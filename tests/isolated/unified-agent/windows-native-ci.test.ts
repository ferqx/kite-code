import { expect, test } from 'bun:test';
import {
  decodeWindowsToolOutput,
  parseWindowsBuildEnvironment,
  prepareWindowsNativeCI,
  windowsBuildEnvironmentCommand,
} from '../../../scripts/release/prepare-windows-native-ci';

const environment = {
  PATH: 'C:\\Windows\\System32;C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64',
  INCLUDE: 'C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\um',
  LIB: 'C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\um\\x64',
  LIBPATH:
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\lib\\x64',
  VCToolsInstallDir:
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\',
  VCToolsVersion: '14.44.35207',
  WindowsSdkDir: 'C:\\Program Files (x86)\\Windows Kits\\10\\',
  WindowsSDKVersion: '10.0.26100.0\\',
  VSCMD_ARG_HOST_ARCH: 'x64',
  VSCMD_ARG_TGT_ARCH: 'x64',
};
const output = (values: Record<string, string> = environment) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\r\n');

test('CMD Unicode and vswhere UTF-8 preserve non-ASCII bytes; malformed bytes never become replacement paths', () => {
  const unicode = {
    ...environment,
    PATH: `${environment.PATH};C:\\环境\\工具😀`,
    INCLUDE: `${environment.INCLUDE};C:\\环境\\头文件`,
    LIB: `${environment.LIB};C:\\环境\\库`,
  };
  expect(
    parseWindowsBuildEnvironment(
      decodeWindowsToolOutput(Buffer.from(output(unicode), 'utf16le'), 'utf16le'),
    ),
  ).toEqual(unicode);
  expect(decodeWindowsToolOutput(Buffer.from('C:\\环境\\Visual Studio\r\n', 'utf8'), 'utf8')).toBe(
    'C:\\环境\\Visual Studio\r\n',
  );
  for (const bytes of [Buffer.from([0x41]), Buffer.from([0x00, 0xd8])])
    expect(() => decodeWindowsToolOutput(bytes, 'utf16le')).toThrow(
      'windows_native_ci_tool_encoding_invalid',
    );
  expect(() => decodeWindowsToolOutput(Buffer.from([0xc3, 0x28]), 'utf8')).toThrow(
    'windows_native_ci_tool_encoding_invalid',
  );
});

test('installed-tool environment preserves exact values, ignores set-prefix matches and accepts identical LIBPATH repeats', () => {
  const parsed = parseWindowsBuildEnvironment(
    `${output()}\r\nLIBPATH=${environment.LIBPATH}\r\nPATHEXT=.EXE\r\nPATH_PRIVATE_TEST_VALUE=hidden\r\nCL=/injected\r\n`,
  );
  expect(parsed).toEqual(environment);
  expect(Object.keys(parsed)).toHaveLength(10);
  expect(parsed.PATH).toContain('Program Files');
  expect('CL' in parsed).toBe(false);
  expect('PATH_PRIVATE_TEST_VALUE' in parsed).toBe(false);
});

test('missing SDK/compiler facts, wrong architecture, conflicting repeated values and unsafe environment cannot be published', () => {
  const { WindowsSdkDir: _sdk, ...missing } = environment;
  expect(() => parseWindowsBuildEnvironment(output(missing))).toThrow(
    'windows_native_ci_environment_incomplete',
  );
  for (const changed of [
    { VSCMD_ARG_HOST_ARCH: 'x86' },
    { VSCMD_ARG_TGT_ARCH: 'x86' },
    { WindowsSDKVersion: 'latest' },
    { VCToolsVersion: '14.44\nINJECTED=value' },
    { PATH: 'C:\\Windows\u0000injected' },
    { WindowsSdkDir: '\\\\server\\sdk' },
    { VCToolsInstallDir: 'C:\\tool%INJECTED%\\' },
  ])
    expect(() => parseWindowsBuildEnvironment(output({ ...environment, ...changed }))).toThrow();
  expect(() => parseWindowsBuildEnvironment(`${output()}\r\nLIBPATH=C:\\different`)).toThrow(
    'windows_native_ci_environment_invalid',
  );
  expect(() => parseWindowsBuildEnvironment('x'.repeat(262145))).toThrow(
    'windows_native_ci_environment_invalid',
  );
});

test('batch command quotes the installed path and rejects computed, device or shell-injected paths', () => {
  const path =
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat',
    command = windowsBuildEnvironmentCommand(path);
  expect(command.startsWith(`"call "${path}" -arch=x64 -host_arch=x64 >nul && `)).toBe(true);
  expect(command.endsWith('set VSCMD_ARG_TGT_ARCH"')).toBe(true);
  expect(command).not.toContain('echo');
  for (const value of [
    'relative\\VsDevCmd.bat',
    '\\\\?\\C:\\VsDevCmd.bat',
    'C:\\VsDevCmd.bat" & echo injected',
    'C:\\%COMPUTED%\\VsDevCmd.bat',
    'C:\\VsDevCmd.bat\nGITHUB_ENV=value',
  ])
    expect(() => windowsBuildEnvironmentCommand(value)).toThrow('windows_native_ci_path_invalid');
});

test.skipIf(process.platform === 'win32')(
  'non-Windows setup fails before tool discovery or environment writes',
  () => {
    expect(() => prepareWindowsNativeCI()).toThrow('windows_native_ci_platform_unsupported');
  },
);
