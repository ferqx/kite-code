import { createRequire } from 'node:module';
import { verifyNativeAsset } from './native-assets';

export interface WindowsAccessLease {
  verify(): void;
  release(): void;
  preparePrivateUi(): void;
  verifyPrivateUi(): void;
}
type Backend = {
  artifactShared(root: string): WindowsAccessLease;
  profileShared(dataRoot: string, profile: string): WindowsAccessLease;
};
/** Fixed Main-only asset; importing this wrapper does not load native code or acquire locks. */
export function loadWindowsAccess(asset: { path: string; sha256: string }): Backend {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_access_platform_unsupported');
  verifyNativeAsset(asset.path, asset.sha256);
  const backend = createRequire(import.meta.url)(asset.path) as Backend;
  if (
    Object.keys(backend).sort().join(',') !== 'artifactShared,profileShared' ||
    typeof backend.artifactShared !== 'function' ||
    typeof backend.profileShared !== 'function'
  )
    throw Error('windows_access_abi_unavailable');
  return backend;
}
