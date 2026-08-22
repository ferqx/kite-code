import { join } from 'node:path';
import { secureWindowsOwnerOnlyPath } from '@kite/builtin-runtime/model';
import {
  type AuthorityKeyV1,
  createProjectIdentityStoreV1,
  loadOrCreateRuntimeInstallationAuthorityKeyV1,
  type ProjectIdentityStoreV1,
} from '@kite/runtime-host';
import { userKiteCodeDir } from '#app/config/paths';

/** The one installation-scoped Project identity authority composed by Kite. */
export function loadInstalledRuntimeAuthorityKeyV1(
  authorityEvidencePaths: readonly string[] = [],
): AuthorityKeyV1 & {
  readonly keyId: `sha256:${string}`;
} {
  const installationRoot = userKiteCodeDir();
  return loadOrCreateRuntimeInstallationAuthorityKeyV1({
    keyPath: join(installationRoot, 'runtime-authority.key'),
    authorityEvidencePaths: [
      join(installationRoot, 'project-identities-v1.json'),
      ...authorityEvidencePaths,
    ],
    secureWindowsPath: secureWindowsOwnerOnlyPath,
  });
}

/** The one installation-scoped Project identity authority composed by Kite. */
export function createInstalledProjectIdentityStoreV1(
  authority = loadInstalledRuntimeAuthorityKeyV1(),
): ProjectIdentityStoreV1 {
  const digest = authority.keyId.slice('sha256:'.length);
  return createProjectIdentityStoreV1({
    path: join(userKiteCodeDir(), 'project-identities-v1.json'),
    installationId: `install_${digest}`,
    keyId: authority.keyId,
    authenticatorKey: authority.key,
    secureWindowsPath: secureWindowsOwnerOnlyPath,
  });
}
