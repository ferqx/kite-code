import { join } from 'node:path';
import { secureWindowsOwnerOnlyPath } from '@kite/builtin-runtime/model';
import { createProjectIdentityStoreV1, type ProjectIdentityStoreV1 } from '@kite/runtime-host';
import { userKiteCodeDir } from '#app/config/paths';

export const RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1 =
  'project-identities-state26-store5-v2.json' as const;

/** The one installation-scoped Project identity authority composed by Kite. */
export function createInstalledProjectIdentityStoreV1(
  installationRoot = userKiteCodeDir(),
): ProjectIdentityStoreV1 {
  return createProjectIdentityStoreV1({
    path: join(installationRoot, RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1),
    secureWindowsPath: secureWindowsOwnerOnlyPath,
  });
}
