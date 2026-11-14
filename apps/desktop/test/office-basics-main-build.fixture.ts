/** Resource-bounded isolated native rebuild. Reuses unchanged service/helpers; fixed production defines. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveOfficeRuntimeAssets } from '@kite-ai/agent/documents';
import { parseNativeAssets, verifyNativeAsset } from '../electron/native-assets';

const directory = process.env.KITE_OFFICE_PRODUCT_FIXTURE_DIRECTORY;
if (!directory?.startsWith('/workspace/shared/'))
  throw Error('explicit_owned_fixture_directory_required');
const outdir = join(directory, 'app');
const root = resolve(import.meta.dir, '..');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const serviceEntrypoint = join(directory, 'apps/service/dist/service.js');
const bunExecutable = realpathSync(process.execPath);
const assets = parseNativeAssets({
  serviceEntrypoint,
  bunExecutable,
  serviceSha256: sha(serviceEntrypoint),
  bunSha256: sha(bunExecutable),
  buildId: 'isolated-office-product-fixture',
  apiMajor: 1,
  requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
  profile: { dataRoot: join(directory, 'data'), profile: 'office-fixture' },
});
verifyNativeAsset(assets.serviceEntrypoint, assets.serviceSha256);
verifyNativeAsset(assets.bunExecutable, assets.bunSha256);
const profileAccessAsset = {
  relativePath: 'profile-access.js',
  sha256: sha(join(outdir, 'profile-access.js')),
};
for (const entry of ['main', 'preload', 'global-dialog-preload', 'trajectory-preload']) {
  const result = await Bun.build({
    entrypoints: [join(root, 'electron', `${entry}.ts`)],
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    outdir,
    naming: `${entry}.cjs`,
    define: {
      __KITE_DESKTOP_NATIVE_ASSETS__: JSON.stringify(assets),
      __KITE_OFFICE_ASSETS_ROOT__: JSON.stringify(resolveOfficeRuntimeAssets().root),
      __KITE_DESKTOP_DEVELOPMENT__: 'null',
      __KITE_DESKTOP_PROFILE_ACCESS__: JSON.stringify(profileAccessAsset),
      __KITE_DESKTOP_WINDOWS_ACCESS__: 'null',
      __KITE_DESKTOP_MACOS_RESIZE__: 'null',
    },
  });
  if (!result.success) throw new AggregateError(result.logs, 'native_build_failed');
}
