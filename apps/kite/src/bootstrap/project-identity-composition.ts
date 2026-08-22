import { join } from 'node:path';
import { secureWindowsOwnerOnlyPath } from '@kite/builtin-runtime/model';
import {
  type AuthorityKeyV1,
  createProjectIdentityStoreV1,
  loadOrCreateRuntimeInstallationAuthorityKeyV1,
  type ProjectIdentityStoreV1,
} from '@kite/runtime-host';
import { userKiteCodeDir } from '#app/config/paths';

export const RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1 =
  'project-identities-state26-store5-v1.json' as const;

/** The one installation-scoped Project identity authority composed by Kite. */
export function loadInstalledRuntimeAuthorityKeyV1(
  authorityEvidencePaths: readonly string[] = [],
  installationRoot = userKiteCodeDir(),
): AuthorityKeyV1 & {
  readonly keyId: `sha256:${string}`;
} {
  return loadOrCreateRuntimeInstallationAuthorityKeyV1({
    keyPath: join(installationRoot, 'runtime-authority.key'),
    authorityEvidencePaths: [
      join(installationRoot, RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1),
      ...authorityEvidencePaths,
    ],
    secureWindowsPath: secureWindowsOwnerOnlyPath,
  });
}

/** The one installation-scoped Project identity authority composed by Kite. */
export function createInstalledProjectIdentityStoreV1(
  authority = loadInstalledRuntimeAuthorityKeyV1(),
  installationRoot = userKiteCodeDir(),
): ProjectIdentityStoreV1 {
  const digest = authority.keyId.slice('sha256:'.length);
  return createProjectIdentityStoreV1({
    path: join(installationRoot, RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1),
    installationId: `install_${digest}`,
    keyId: authority.keyId,
    authenticatorKey: authority.key,
    secureWindowsPath: secureWindowsOwnerOnlyPath,
  });
}
