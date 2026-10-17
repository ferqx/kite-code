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
type ActualRuntime = { entrypoint: string; executable: string; buildId: string };
const admissions = new WeakMap<
  object,
  {
    proof: RuntimeProtection;
    actual: ActualRuntime;
    roots: readonly string[];
    borrowers: Set<object>;
    live: boolean;
    verify(): void;
  }
>();

/** Trusted composition within this process. JSON or a copied owner cannot grant admission. */
export function borrowWindowsPairedArtifact(
  access: ReturnType<typeof retainWindowsPairedArtifact>,
  value: RuntimeProtection,
  actual: ActualRuntime,
) {
  const proof = parseRuntimeProtection(value),
    state = admissions.get(access);
  if (
    !state?.live ||
    proof.kind !== state.proof.kind ||
    proof.root !== state.proof.root ||
    proof.manifestSha256 !== state.proof.manifestSha256 ||
    actual.entrypoint !== state.actual.entrypoint ||
    actual.executable !== state.actual.executable ||
    actual.buildId !== state.actual.buildId
  )
    throw Error('paired_artifact_admission_invalid');
  // Directory pins prevent replacement, but do not prevent new children.
  // Recheck the complete closed inventory and original bytes before borrowing.
  state.verify();
  const borrower = {};
  state.borrowers.add(borrower);
  return Object.freeze({
    roots: state.roots,
    release() {
      state.borrowers.delete(borrower);
    },
  });
}

/** Parent admission is independent of the child Service's own artifact lease. */
export function retainWindowsPairedArtifact(
  value: RuntimeProtection,
  actual: ActualRuntime,
): { readonly arguments: readonly string[]; release(): void } {
  const proof = parseRuntimeProtection(value);
  const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
  const files: ReturnType<typeof retainWindowsTerminalRuntimeFiles>[] = [];
  const state = {
    proof,
    actual: Object.freeze({ ...actual }),
    roots: runtimeProtectionRoots(proof),
    borrowers: new Set<object>(),
    live: true,
    verify() {
      verifyRuntimeProtection(proof, state.actual, {
        ...(proof.kind === 'native.candidate' ? { outer: files[0]! } : {}),
        terminal: files.at(-1)!,
      });
    },
  };
  const owner = {
    release() {
      if (state.borrowers.size) throw Error('paired_artifact_in_use');
      state.live = false;
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
    const terminalFiles = retainWindowsTerminalRuntimeFiles(terminalRoot);
    files.push(terminalFiles);
    state.verify();
    const access = Object.freeze({
      arguments: windowsTerminalRuntimeArguments(terminalRoot),
      release: owner.release,
    });
    admissions.set(access, state);
    return access;
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
