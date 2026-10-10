import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  retainWindowsNativeRuntimeFiles,
  windowsRuntimePinCloseUnknown,
} from './native-runtime-assets';
import {
  retainWindowsTerminalRuntimeFiles,
  windowsTerminalRuntimeArguments,
} from './runtime-assets';
import {
  parseRuntimeProtection,
  type RuntimeProtection,
  runtimeProtectionRoots,
  verifyRuntimeProtection,
} from './runtime-protection';

// Failed native closes remain owned; loss of the JS launcher is not release evidence.
const owned = new Set<{ release(): void }>();

/** Parent admission is independent of the child Service's own artifact lease. */
export function retainWindowsPairedArtifact(
  value: RuntimeProtection,
  actual: { entrypoint: string; executable: string; buildId: string },
): { readonly arguments: readonly string[]; release(): void } {
  const proof = parseRuntimeProtection(value);
  const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
  const files: ReturnType<typeof retainWindowsTerminalRuntimeFiles>[] = [];
  const owner = {
    release() {
      while (files.length) {
        files.at(-1)!.release();
        files.pop();
      }
      while (leases.length) {
        leases.at(-1)!.release();
        leases.pop();
      }
      owned.delete(owner);
    },
  };
  owned.add(owner);
  try {
    for (const root of runtimeProtectionRoots(proof))
      leases.push(acquireArtifactAccess({ root: realpathSync(root), mode: 'shared' }));
    const terminalRoot =
      proof.kind === 'native.candidate' ? join(proof.root, 'terminal') : proof.root;
    if (proof.kind === 'native.candidate') files.push(retainWindowsNativeRuntimeFiles(proof.root));
    files.push(retainWindowsTerminalRuntimeFiles(terminalRoot));
    verifyRuntimeProtection(proof, actual);
    for (const pin of files) pin.verify();
    return Object.freeze({
      arguments: windowsTerminalRuntimeArguments(terminalRoot),
      release: owner.release,
    });
  } catch (error) {
    if (windowsRuntimePinCloseUnknown(error))
      throw Object.assign(new AggregateError([error], 'paired_artifact_close_unknown'), {
        code: 'paired_artifact_close_unknown',
      });
    try {
      owner.release();
    } catch (cleanupError) {
      throw Object.assign(
        new AggregateError([error, cleanupError], 'paired_artifact_close_unknown'),
        {
          code: 'paired_artifact_close_unknown',
        },
      );
    }
    throw error;
  }
}
