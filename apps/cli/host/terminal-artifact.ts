import { join } from 'node:path';
import {
  parseTerminalBundleManifest as parseManifest,
  type TerminalBundleManifest,
  TerminalRuntimeAssetError,
  terminalBundleEntries,
  verifyTerminalRuntimeBundle,
} from '@kite-ai/service/runtime-assets';
import { CLIHostError, type CLIServiceArtifact, parseCLIServiceArtifact } from './index';

export { type TerminalBundleManifest, terminalBundleEntries };
export interface VerifiedTerminalBundle {
  readonly root: string;
  readonly manifest: TerminalBundleManifest;
  readonly digest: string;
  readonly candidateId: string;
  readonly buildId: string;
  readonly artifact: Readonly<CLIServiceArtifact>;
}
function translate<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof CLIHostError) throw error;
    throw new CLIHostError(
      error instanceof TerminalRuntimeAssetError ? error.code : 'terminal_bundle_unavailable',
    );
  }
}
/** Closed unsigned integrity metadata. This does not establish publisher authenticity. */
export function parseTerminalBundleManifest(value: unknown): TerminalBundleManifest {
  return translate(() => parseManifest(value));
}
/** Shared entire-closure verification; the selected artifact retains its host-only protection proof. */
export function verifyTerminalBundle(bundleRoot: string): VerifiedTerminalBundle {
  return translate(() => {
    const { root, manifest, digest } = verifyTerminalRuntimeBundle(bundleRoot);
    const buildId = `terminal-${digest}`;
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    const fileDigest = (path: string) => files.get(path)!.sha256;
    const artifact = parseCLIServiceArtifact({
      entrypoint: join(root, manifest.entries.service),
      entrypointSha256: fileDigest(manifest.entries.service),
      executable: join(root, manifest.entries.runtime),
      executableSha256: fileDigest(manifest.entries.runtime),
      buildId,
      apiMajor: 1,
      runtimeProtection: { kind: 'terminal.candidate', root, manifestSha256: digest },
      daemon: {
        entrypoint: join(root, manifest.entries.daemon),
        entrypointSha256: fileDigest(manifest.entries.daemon),
        web: {
          directory: join(root, 'web'),
          manifestSha256: fileDigest(manifest.entries.webManifest),
        },
      },
    });
    return Object.freeze({ root, manifest, digest, candidateId: digest, buildId, artifact });
  });
}
export function selectTerminalArtifact(root: string): Readonly<CLIServiceArtifact> {
  return verifyTerminalBundle(root).artifact;
}
