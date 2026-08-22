import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { normalizeMsys2DrivePathsInShellCommand } from '../path-utils';
import {
  buildWorkspaceExcludedPath,
  isCanonicalPathOutsideWorkspace,
  POLICY_PROVEN_READ_ONLY_EXECUTION,
} from '../trusted-readonly-environment';
import type { FilesystemScope, ShellFilesystemMode, ShellNetworkMode } from '../types';
import {
  resolveWindowsSandboxRunnerV1,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  type WindowsSandboxRunnerV1,
} from '../windows-runner';

export interface SandboxShellPreparationInputV1 {
  readonly workspace: string;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly networkMode?: ShellNetworkMode;
  readonly filesystemMode?: ShellFilesystemMode;
  readonly executionTrust?: 'policy_proven_read_only';
  readonly networkBroker?: unknown;
}

const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_WINDOWS_RESTRICTED_TOKEN_MAX_PROCESSES = 31;

export interface RestrictedTokenInvocationRequestV1 {
  version: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
  directWorkspace: WindowsRestrictedTokenDirectWorkspaceV1;
  invocationName: string;
  commandLine: string;
  cwd: string;
  env: Record<string, string>;
  filesystemScope: 'workspace_write' | 'read_only' | 'full_access';
  workspaceRoot: string;
  runtimeRoot: string;
  shellRuntimeRoot: string;
  shellRuntime: 'bash' | 'busybox' | 'isksh';
  shellRuntimeDigest: string;
  coreutilsDigest: string;
  maxProcesses: number;
  timeoutMs: number;
  networkMode: 'off' | 'allow_all';
}

export interface WindowsRestrictedTokenPreparedTransportV1 {
  readonly runner: WindowsSandboxRunnerV1;
  readonly request: RestrictedTokenInvocationRequestV1;
  readonly workspaceRoot: string;
  readonly runtimeRoot: string;
}

export interface WindowsRestrictedTokenDirectWorkspaceV1 {
  runtimeCapabilitySid: string;
  approvedFilesystemGuardSid?: string;
  ephemeralWorkspaceCapabilitySid?: string;
}

export interface WindowsRestrictedTokenExecutorOptionsV1 {
  enabled: boolean;
  workspace: string;
  filesystemScope?: Exclude<FilesystemScope, 'full_access'>;
  maxProcessTreeTasks?: number;
  network?: { mode: ShellNetworkMode };
  startupProbe?: boolean;
}

export type WindowsRestrictedTokenPreparationResultV1 =
  | { readonly ok: true; readonly prepared: WindowsRestrictedTokenPreparedTransportV1 }
  | { readonly ok: false; readonly error: string };

/** Strict data-only codec used by Runtime consumption and crash recovery. */
export function decodeWindowsRestrictedTokenPreparedTransportV1(
  serialized: string,
): Readonly<WindowsRestrictedTokenPreparedTransportV1> {
  const parsed: unknown = JSON.parse(serialized);
  if (
    !recordWithKeys(parsed, ['runner', 'request', 'workspaceRoot', 'runtimeRoot']) ||
    !recordWithKeys(parsed.runner, [
      'path',
      'version',
      'digest',
      'minimumWindowsVersion',
      'protocolVersion',
      'shellRuntimePath',
      'shellRuntime',
      'shellRuntimeDigest',
      'coreutilsDigest',
    ]) ||
    !recordWithKeys(parsed.request, [
      'version',
      'directWorkspace',
      'invocationName',
      'commandLine',
      'cwd',
      'env',
      'filesystemScope',
      'workspaceRoot',
      'runtimeRoot',
      'shellRuntimeRoot',
      'shellRuntime',
      'shellRuntimeDigest',
      'coreutilsDigest',
      'maxProcesses',
      'timeoutMs',
      'networkMode',
    ]) ||
    !validDirectWorkspace(parsed.request.directWorkspace) ||
    !isStringRecord(parsed.request.env)
  ) {
    throw new Error('Windows restricted-token prepared transport has an invalid shape.');
  }
  const runner = parsed.runner;
  const request = parsed.request;
  if (
    ![
      parsed.workspaceRoot,
      parsed.runtimeRoot,
      runner.path,
      runner.version,
      runner.digest,
      runner.minimumWindowsVersion,
      runner.shellRuntimePath,
      runner.shellRuntimeDigest,
      runner.coreutilsDigest,
      request.invocationName,
      request.commandLine,
      request.cwd,
      request.workspaceRoot,
      request.runtimeRoot,
      request.shellRuntimeRoot,
      request.shellRuntimeDigest,
      request.coreutilsDigest,
    ].every(nonEmpty) ||
    runner.minimumWindowsVersion !== '10.0.19045' ||
    runner.protocolVersion !== WINDOWS_SANDBOX_PROTOCOL_VERSION ||
    request.version !== WINDOWS_SANDBOX_PROTOCOL_VERSION ||
    !['bash', 'busybox', 'isksh'].includes(String(runner.shellRuntime)) ||
    request.shellRuntime !== runner.shellRuntime ||
    request.shellRuntimeRoot !== runner.shellRuntimePath ||
    request.shellRuntimeDigest !== runner.shellRuntimeDigest ||
    request.coreutilsDigest !== runner.coreutilsDigest ||
    request.cwd !== parsed.workspaceRoot ||
    request.workspaceRoot !== parsed.workspaceRoot ||
    request.runtimeRoot !== parsed.runtimeRoot ||
    !['read_only', 'workspace_write', 'full_access'].includes(String(request.filesystemScope)) ||
    !['off', 'allow_all'].includes(String(request.networkMode)) ||
    !Number.isSafeInteger(request.maxProcesses) ||
    Number(request.maxProcesses) < 1 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    Number(request.timeoutMs) < 1
  ) {
    throw new Error('Windows restricted-token prepared transport identity mismatch.');
  }
  return deepFreeze(parsed as unknown as WindowsRestrictedTokenPreparedTransportV1);
}

export function prepareWindowsRestrictedTokenTransportV1(
  options: WindowsRestrictedTokenExecutorOptionsV1,
  input: SandboxShellPreparationInputV1,
  allocatedRuntimeRoot: string,
  resolvedRunner: WindowsSandboxRunnerV1 | null = resolveWindowsSandboxRunnerV1(),
): WindowsRestrictedTokenPreparationResultV1 {
  if (!resolvedRunner) {
    return { ok: false, error: 'windows_restricted_token_runner_unavailable' };
  }
  if (input.networkBroker !== undefined) {
    return {
      ok: false,
      error:
        'Network broker/allowlist execution is unavailable for the Windows restricted-token backend.',
    };
  }
  let workspaceRoot: string;
  let runtimeRoot: string;
  try {
    workspaceRoot = realpathSync.native(options.workspace);
    runtimeRoot = realpathSync.native(allocatedRuntimeRoot);
  } catch (error) {
    return {
      ok: false,
      error: `Sandbox direct-workspace setup failed: ${message(error)}`,
    };
  }
  try {
    const filesystemScope = resolveWindowsRestrictedTokenFilesystemScopeV1({
      configuredFilesystemScope: options.filesystemScope,
      invocationFilesystemMode: input.filesystemMode,
    });
    const networkMode = resolveWindowsRestrictedTokenNetworkModeV1({
      configuredNetworkMode: options.network?.mode,
      invocationNetworkMode: input.networkMode,
    });
    const networkScopeError = windowsApprovedNetworkScopeErrorV1({ networkMode, filesystemScope });
    if (networkScopeError) return { ok: false, error: networkScopeError };
    const directWorkspace = createWindowsRestrictedTokenDirectWorkspaceV1({
      startupProbe: options.startupProbe === true && filesystemScope === 'workspace_write',
      approvedFilesystem: filesystemScope === 'full_access',
    });
    const request: RestrictedTokenInvocationRequestV1 = {
      version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
      directWorkspace,
      invocationName: createWindowsRestrictedTokenInvocationName(),
      commandLine: wrapWindowsRestrictedTokenCommandV1(input.command),
      cwd: workspaceRoot,
      env: buildEnvironment(
        runtimeRoot,
        resolvedRunner,
        workspaceRoot,
        input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION,
      ),
      filesystemScope,
      workspaceRoot,
      runtimeRoot,
      shellRuntimeRoot: resolvedRunner.shellRuntimePath,
      shellRuntime: resolvedRunner.shellRuntime,
      shellRuntimeDigest: resolvedRunner.shellRuntimeDigest,
      coreutilsDigest: resolvedRunner.coreutilsDigest,
      maxProcesses: options.maxProcessTreeTasks ?? DEFAULT_WINDOWS_RESTRICTED_TOKEN_MAX_PROCESSES,
      timeoutMs:
        input.timeoutMs != null && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? input.timeoutMs
          : DEFAULT_SHELL_TIMEOUT_MS,
      networkMode,
    };
    return {
      ok: true,
      prepared: Object.freeze({
        runner: resolvedRunner,
        request: Object.freeze(request),
        workspaceRoot,
        runtimeRoot,
      }),
    };
  } catch (error) {
    return { ok: false, error: `Sandbox direct-workspace preparation failed: ${message(error)}` };
  }
}

export function createWindowsRestrictedTokenCapabilitySidV1(
  random: () => string = randomUUID,
): string {
  const hex = random().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error('Unable to generate a valid Windows restricted-token capability SID.');
  }
  const parts: string[] = [];
  for (let offset = 0; offset < hex.length; offset += 8) {
    const component = Number.parseInt(hex.slice(offset, offset + 8), 16);
    if (!Number.isSafeInteger(component)) {
      throw new Error('Unable to generate a valid Windows restricted-token capability SID.');
    }
    parts.push(String(component));
  }
  return `S-1-5-21-${parts.join('-')}`;
}

export function createWindowsRestrictedTokenDirectWorkspaceV1(input: {
  startupProbe: boolean;
  approvedFilesystem?: boolean;
  createCapabilitySid?: () => string;
}): WindowsRestrictedTokenDirectWorkspaceV1 {
  const createCapabilitySid =
    input.createCapabilitySid ?? createWindowsRestrictedTokenCapabilitySidV1;
  const runtimeCapabilitySid = createCapabilitySid();
  if (input.approvedFilesystem) {
    return { runtimeCapabilitySid, approvedFilesystemGuardSid: createCapabilitySid() };
  }
  return input.startupProbe
    ? { runtimeCapabilitySid, ephemeralWorkspaceCapabilitySid: createCapabilitySid() }
    : { runtimeCapabilitySid };
}

export function createWindowsRestrictedTokenInvocationName(): string {
  return `kitecode.${randomUUID().replaceAll('-', '')}`;
}

export function restrictedTokenNetworkUnsupportedReasonV1(input: {
  hasNetworkBroker: boolean;
}): string | null {
  return input.hasNetworkBroker
    ? 'Network broker/allowlist execution is unavailable for the Windows restricted-token backend.'
    : null;
}

export function resolveWindowsRestrictedTokenNetworkModeV1(input: {
  configuredNetworkMode?: ShellNetworkMode;
  invocationNetworkMode?: ShellNetworkMode;
}): 'off' | 'allow_all' {
  return input.configuredNetworkMode === 'allow_all' || input.invocationNetworkMode === 'allow_all'
    ? 'allow_all'
    : 'off';
}

export function resolveWindowsRestrictedTokenFilesystemScopeV1(input: {
  configuredFilesystemScope?: 'read_only' | 'workspace_write';
  invocationFilesystemMode?: ShellFilesystemMode;
}): 'read_only' | 'workspace_write' | 'full_access' {
  if (input.invocationFilesystemMode === 'allow_all') return 'full_access';
  return input.configuredFilesystemScope === 'read_only' ? 'read_only' : 'workspace_write';
}

/**
 * Schannel-compatible current-user networking has no restricted-SID
 * filesystem ceiling. Keep narrower filesystem grants fail-closed instead of
 * treating a network approval as ambient current-user file authority.
 */
export function windowsApprovedNetworkScopeErrorV1(input: {
  networkMode: 'off' | 'allow_all';
  filesystemScope: 'read_only' | 'workspace_write' | 'full_access';
}): string | null {
  return input.networkMode === 'allow_all' && input.filesystemScope !== 'full_access'
    ? 'approved_network_requires_full_filesystem_scope'
    : null;
}

const PACKAGE_MANAGER_PRELUDE = [
  'npm() { cmd.exe /d /c npm.cmd "$@"; }',
  'npx() { cmd.exe /d /c npx.cmd "$@"; }',
  'pnpm() { cmd.exe /d /c pnpm.cmd "$@"; }',
  'pnpx() { cmd.exe /d /c pnpx.cmd "$@"; }',
  'yarn() { cmd.exe /d /c yarn.cmd "$@"; }',
  'yarnpkg() { cmd.exe /d /c yarnpkg.cmd "$@"; }',
  'corepack() { cmd.exe /d /c corepack.cmd "$@"; }',
].join('; ');

export function wrapWindowsRestrictedTokenCommandV1(command: string): string {
  return `${PACKAGE_MANAGER_PRELUDE};\n${normalizeMsys2DrivePathsInShellCommand(command)}`;
}

export const WINDOWS_RESTRICTED_TOKEN_ENV_ALLOWLIST = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'SESSIONNAME',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;

function buildEnvironment(
  runtimeRoot: string,
  runner: WindowsSandboxRunnerV1,
  workspaceRoot: string,
  policyProvenReadOnly: boolean,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WINDOWS_RESTRICTED_TOKEN_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.TEMP = runtimeRoot;
  env.TMP = runtimeRoot;
  env.HOME = runtimeRoot;
  env.BUN_INSTALL_CACHE_DIR = win32.join(runtimeRoot, 'bun-cache');
  const pathEntries = [
    runtimeRoot,
    win32.join(runtimeRoot, 'kite-coreutils'),
    runner.shellRuntimePath,
  ];
  const bun = resolveBunExecutableForWindowsRestrictedTokenV1();
  if (
    bun &&
    (!policyProvenReadOnly ||
      isCanonicalPathOutsideWorkspace(workspaceRoot, bun, { platform: 'win32' }))
  ) {
    pathEntries.push(win32.dirname(bun));
  }
  if (env.PATH) {
    const inheritedPath = policyProvenReadOnly
      ? buildWorkspaceExcludedPath(workspaceRoot, {
          platform: 'win32',
          pathValue: env.PATH,
          systemRoot: process.env.SystemRoot,
        })
      : env.PATH;
    if (inheritedPath) pathEntries.push(inheritedPath);
  }
  env.PATH = pathEntries.join(';');
  return env;
}

/** Build the direct token's child environment without touching the filesystem. */
export function buildWindowsRestrictedTokenEnvForTest(
  processEnv: NodeJS.ProcessEnv,
  runtimeRoot: string,
  shellRuntimePath: string,
  bunExecutablePath: string | null = null,
  options: {
    workspaceRoot?: string;
    policyProvenReadOnly?: boolean;
    canonicalizePath?: (path: string) => string;
  } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WINDOWS_RESTRICTED_TOKEN_ENV_ALLOWLIST) {
    const value = processEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.TEMP = runtimeRoot;
  env.TMP = runtimeRoot;
  env.HOME = runtimeRoot;
  env.BUN_INSTALL_CACHE_DIR = win32.join(runtimeRoot, 'bun-cache');
  const pathEntries = [runtimeRoot, win32.join(runtimeRoot, 'kite-coreutils'), shellRuntimePath];
  if (
    bunExecutablePath &&
    (!options.policyProvenReadOnly ||
      !options.workspaceRoot ||
      isCanonicalPathOutsideWorkspace(options.workspaceRoot, bunExecutablePath, {
        platform: 'win32',
        canonicalize: options.canonicalizePath,
      }))
  ) {
    pathEntries.push(win32.dirname(bunExecutablePath));
  }
  if (env.PATH) {
    const inheritedPath =
      options.policyProvenReadOnly && options.workspaceRoot
        ? buildWorkspaceExcludedPath(options.workspaceRoot, {
            platform: 'win32',
            pathValue: env.PATH,
            canonicalize: options.canonicalizePath,
            systemRoot: processEnv.SystemRoot,
          })
        : env.PATH;
    if (inheritedPath) pathEntries.push(inheritedPath);
  }
  env.PATH = pathEntries.join(';');
  return env;
}

/** Resolve an independently canonical Bun executable for the direct PATH entry. */
export function resolveBunExecutableForWindowsRestrictedTokenV1(
  input: {
    which?: () => string | null;
    execPath?: string | null;
    realpath?: (path: string) => string;
  } = {},
): string | null {
  let whichCandidate: string | null = null;
  try {
    whichCandidate = (input.which ?? (() => Bun.which('bun')))();
  } catch {
    // Fall through to process.execPath when PATH resolution is unavailable.
  }
  const execCandidate = input.execPath === undefined ? process.execPath : input.execPath;
  const canonicalize = input.realpath ?? realpathSync.native;
  for (const candidate of [whichCandidate, execCandidate]) {
    if (!candidate) continue;
    try {
      const canonical = canonicalize(candidate);
      const name = win32.basename(canonical).toLowerCase();
      if (name === 'bun.exe' || name === 'bun') return canonical;
    } catch {
      // Try the independently resolved executable.
    }
  }
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validDirectWorkspace(value: unknown): value is WindowsRestrictedTokenDirectWorkspaceV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (
    !keys.includes('runtimeCapabilitySid') ||
    keys.some(
      (key) =>
        ![
          'runtimeCapabilitySid',
          'approvedFilesystemGuardSid',
          'ephemeralWorkspaceCapabilitySid',
        ].includes(key),
    ) ||
    (keys.includes('approvedFilesystemGuardSid') &&
      keys.includes('ephemeralWorkspaceCapabilitySid'))
  ) {
    return false;
  }
  return Object.values(value).every(nonEmpty);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}
