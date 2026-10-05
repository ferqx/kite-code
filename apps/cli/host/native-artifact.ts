import { join } from 'node:path';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { parseCLIServiceArtifact } from './index';

/** Exact embedded Terminal plus the entire original Native closure, never a PATH backend. */
export function selectNativeTerminalArtifact(root: string) {
  const bundle = verifyNativeRuntimeBundle(root);
  const terminal = bundle.terminal;
  const files = new Map(terminal.manifest.files.map((file) => [file.path, file]));
  const artifact = parseCLIServiceArtifact({
    entrypoint: join(terminal.root, terminal.manifest.entries.service),
    entrypointSha256: files.get(terminal.manifest.entries.service)!.sha256,
    executable: join(terminal.root, terminal.manifest.entries.runtime),
    executableSha256: files.get(terminal.manifest.entries.runtime)!.sha256,
    buildId: `native-${bundle.digest}`,
    apiMajor: 1,
    runtimeProtection: {
      kind: 'native.candidate',
      root: bundle.root,
      manifestSha256: bundle.digest,
    },
    daemon: {
      entrypoint: join(terminal.root, terminal.manifest.entries.daemon),
      entrypointSha256: files.get(terminal.manifest.entries.daemon)!.sha256,
      web: {
        directory: join(terminal.root, 'web'),
        manifestSha256: files.get(terminal.manifest.entries.webManifest)!.sha256,
      },
    },
  });
  return Object.freeze({ bundle, artifact });
}
