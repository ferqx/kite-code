import { mkdirSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { buildPolicyProvenReadOnlyEnv } from '../trusted-readonly-environment';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from '../types';

export function buildUlimitPreamble(limits: Partial<ResourceLimits> = {}): string {
  const resolved = { ...DEFAULT_RESOURCE_LIMITS, ...limits };
  const parts: string[] = [];
  if (resolved.cpuTime > 0) parts.push(`ulimit -t ${resolved.cpuTime}`);
  if (resolved.fileSize > 0) parts.push(`ulimit -f ${resolved.fileSize}`);
  if (resolved.fileDescriptors > 0) parts.push(`ulimit -n ${resolved.fileDescriptors}`);
  if (resolved.virtualMemory > 0) parts.push(`ulimit -v ${resolved.virtualMemory}`);
  if (resolved.processes > 0) parts.push(`ulimit -u ${resolved.processes}`);
  return parts.length === 0 ? '' : `${parts.join(' ; ')} ; `;
}

export function buildHardenedEnv(
  workspace: string,
  runtimeDir: string,
  options: { policyProvenReadOnly?: boolean } = {},
): Record<string, string> {
  const canonicalWorkspace = realpathSync.native(resolve(workspace));
  const canonicalRuntimeDir = realpathSync.native(resolve(runtimeDir));
  if (canonicalRuntimeDir === canonicalWorkspace) {
    throw new Error('Sandbox runtime directory must be outside the Workspace.');
  }
  const sandboxTmp = join(canonicalRuntimeDir, 'tmp');
  const sandboxBunCache = join(canonicalRuntimeDir, 'bun-cache');
  mkdirSync(sandboxTmp, { recursive: true });
  mkdirSync(sandboxBunCache, { recursive: true });
  const env: Record<string, string> = {};
  if (options.policyProvenReadOnly) {
    Object.assign(env, buildPolicyProvenReadOnlyEnv(canonicalWorkspace));
  } else {
    for (const key of SAFE_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  if (!options.policyProvenReadOnly && process.env.HOME) env.HOME = process.env.HOME;
  const developerBin = selectedDarwinDeveloperBin();
  if (developerBin) {
    env.PATH = env.PATH ? `${developerBin}${delimiter}${env.PATH}` : developerBin;
  }
  env.TMPDIR = sandboxTmp;
  env.TMP = sandboxTmp;
  env.TEMP = sandboxTmp;
  env.XDG_CACHE_HOME = join(sandboxTmp, '.cache');
  env.BUN_INSTALL_CACHE_DIR = sandboxBunCache;
  return env;
}

/** Resolve the selected Apple toolchain without invoking the xcrun shim or its external cache. */
export function selectedDarwinDeveloperBin(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return realpathSync.native('/private/var/select/developer_dir/usr/bin');
  } catch {
    return undefined;
  }
}

const SAFE_ENV_KEYS = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',
  'SSH_AUTH_SOCK',
  'DISPLAY',
];

export function buildEnvStripSnippet(): string {
  const dangerousVariables = [
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'NODE_OPTIONS',
    'BUN_RUNTIME',
    'BUN_CONFIG',
    'PYTHONPATH',
    'PYTHONHOME',
    'PERL5LIB',
    'RUBYOPT',
    'GEM_HOME',
    'GEM_PATH',
    'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS',
    'CLASSPATH',
    'GRADLE_OPTS',
    'MAVEN_OPTS',
    'SBT_OPTS',
    'RIPGREP_CONFIG_PATH',
  ];
  return `${dangerousVariables.map((name) => `unset ${name}`).join(' ; ')} ; `;
}

export function buildEnvExportSnippet(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`)
    .join(' ; ')} ; `;
}
