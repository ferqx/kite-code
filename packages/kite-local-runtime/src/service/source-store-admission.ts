import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
 * A bounded process review for source CLI/TUI Service startup on macOS.
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
  const observation = observeLegacyKiteStoreProcesses({
    exclude: [parent],
    managedInstallPrefixes: input.knownManagedPrefixes,
    canonicalKiteHome: home,
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
