import { createHash } from 'node:crypto';
import type { TerminalBundleManifest } from '../../apps/service/src/runtime-assets';

export const windowsTerminalVerifierPath = 'windows-frontdoor/terminal-verifier.exe';
export const windowsNativeVerifierChecksumPath = 'windows-frontdoor/native-verifier.sha256';

/** The Terminal builder emits this checksum only for the verifier that supports both frontdoors. */
export function sharedWindowsNativeVerifier(manifest: Pick<TerminalBundleManifest, 'files'>) {
  const checksum = manifest.files.find((file) => file.path === windowsNativeVerifierChecksumPath);
  if (!checksum) return undefined;
  const verifier = manifest.files.find((file) => file.path === windowsTerminalVerifierPath);
  if (verifier?.mode !== 493) throw Error('windows_shared_verifier_invalid');
  const bytes = Buffer.from(`${verifier.sha256}\n`);
  if (
    checksum.mode !== 420 ||
    checksum.size !== bytes.length ||
    checksum.sha256 !== createHash('sha256').update(bytes).digest('hex')
  )
    throw Error('windows_shared_verifier_invalid');
  return verifier;
}
