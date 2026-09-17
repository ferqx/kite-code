import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type LegacyKiteProcessIdentity,
  observeLegacyKiteStoreProcesses,
  readKiteSourceClientParentIdentity,
} from './legacy-store-processes';

export type SourceKiteStoreAdmissionReason =
  | 'unsupported_platform'
  | 'source_identity_mismatch'
  | 'source_build_mismatch'
  | 'source_parent_unverified'
  | 'installed_entrypoint_present'
  | 'desktop_entrypoint_present'
  | 'distribution_inspection_incomplete'
  | 'legacy_process_busy'
  | 'legacy_process_inspection_incomplete';

export type SourceKiteStoreAdmission =
  | {
      readonly admitted: true;
      readonly evidence: {
        readonly scope: 'current_source_cli_tui';
        readonly repositoryRoot: string;
        readonly parent: LegacyKiteProcessIdentity;
        readonly observedAt: string;
      };
    }
  | { readonly admitted: false; readonly reason: SourceKiteStoreAdmissionReason };

/**
 * A bounded distribution/process review for source CLI/TUI Service startup on macOS.
 * This is one prerequisite for migration, never a replacement for canonical maintenance,
 * source snapshot revalidation, or transaction-safe publication.
 */
export function reviewSourceKiteStoreAdmission(input: {
  readonly repositoryRoot: string;
  readonly canonicalKiteHome: string;
  readonly runtimeRoot: string;
  /** Must be recomputed by the caller from the current checkout, not copied from the environment. */
  readonly expectedSourceBuildId: string;
  readonly knownManagedPrefixes?: readonly string[];
}): SourceKiteStoreAdmission {
  if (process.platform !== 'darwin') return { admitted: false, reason: 'unsupported_platform' };
  const env = process.env;
  let root: string;
  let home: string;
  let runtimeRoot: string;
  let entrypoint: string;
  try {
    root = realpathSync.native(input.repositoryRoot);
    home = realpathSync.native(input.canonicalKiteHome);
    runtimeRoot = realpathSync.native(input.runtimeRoot);
    entrypoint = realpathSync.native(join(root, 'scripts/release/entrypoints/service.ts'));
  } catch {
    return { admitted: false, reason: 'source_identity_mismatch' };
  }
  const argvEntry = process.argv[1];
  let actualEntry: string | undefined;
  try {
    if (argvEntry) actualEntry = realpathSync.native(resolve(argvEntry));
  } catch {
    // An unresolved Service entrypoint is not a supported source invocation.
  }
  if (
    actualEntry !== entrypoint ||
    process.argv.length !== 4 ||
    process.argv[2] !== 'app-server' ||
    process.argv[3] !== 'run-stdio' ||
    env.KITE_STANDALONE_EXECUTABLE !== undefined ||
    env.KITE_CODE_CONFIG_HOME !== home ||
    env.KITE_CODE_HOME !== runtimeRoot ||
    runtimeRoot === join(home, 'source-profiles') ||
    runtimeRoot.startsWith(`${join(home, 'source-profiles')}/`)
  ) {
    return { admitted: false, reason: 'source_identity_mismatch' };
  }
  if (
    !input.expectedSourceBuildId.startsWith('dev:') ||
    env.KITE_APP_SERVER_BUILD_ID !== input.expectedSourceBuildId
  ) {
    return { admitted: false, reason: 'source_build_mismatch' };
  }
  const parent = readKiteSourceClientParentIdentity(process.ppid, root);
  if (!parent) return { admitted: false, reason: 'source_parent_unverified' };
  const distribution = inspectSourceDistributionEntrypoints(input.knownManagedPrefixes ?? [], env);
  if (distribution !== 'clear') return { admitted: false, reason: distribution };
  const observation = observeLegacyKiteStoreProcesses({
    exclude: [parent],
    managedInstallPrefixes: input.knownManagedPrefixes,
  });
  if (observation.status === 'busy') return { admitted: false, reason: 'legacy_process_busy' };
  if (observation.status !== 'complete') {
    return { admitted: false, reason: 'legacy_process_inspection_incomplete' };
  }
  return {
    admitted: true,
    evidence: {
      scope: 'current_source_cli_tui',
      repositoryRoot: root,
      parent,
      observedAt: new Date().toISOString(),
    },
  };
}

function inspectSourceDistributionEntrypoints(
  knownManagedPrefixes: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
):
  | 'clear'
  | 'installed_entrypoint_present'
  | 'desktop_entrypoint_present'
  | 'distribution_inspection_incomplete' {
  const systemHome = userInfo().homedir;
  const prefixes = [join(systemHome, '.local/share/kite-code'), ...knownManagedPrefixes];
  if (prefixes.some((value) => !isAbsolute(value))) return 'distribution_inspection_incomplete';
  try {
    for (const prefix of prefixes) {
      if (lstatSync(prefix, { throwIfNoEntry: false })) return 'installed_entrypoint_present';
    }
    const searchPath = environment.PATH;
    if (!searchPath) return 'distribution_inspection_incomplete';
    for (const directory of searchPath.split(':')) {
      if (!isAbsolute(directory)) return 'distribution_inspection_incomplete';
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch (error) {
        // PATH routinely contains optional directories that do not exist on this host.
        // Command resolution cannot start an old Kite entrypoint from such a segment.
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) continue;
        throw error;
      }
      if (names.some((name) => /^(?:kite|kite-tui|kite-service)(?:\.exe)?$/iu.test(name))) {
        return 'installed_entrypoint_present';
      }
    }
    for (const parent of ['/Applications', join(systemHome, 'Applications')]) {
      const stat = lstatSync(parent, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return 'distribution_inspection_incomplete';
      if (readdirSync(parent).some((name) => /^kite\.app$/iu.test(name))) {
        return 'desktop_entrypoint_present';
      }
    }
    return 'clear';
  } catch {
    return 'distribution_inspection_incomplete';
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
