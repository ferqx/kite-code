import { basename, dirname, join } from 'node:path';
import { windowsTerminalRuntimeArguments } from '@kite-ai/service/runtime-assets';
import type { RuntimeProtection } from '@kite-ai/service/runtime-protection';
import { loadWindowsAccess } from './windows-access';

export interface WindowsNativeHandoff {
  readonly launcherPipe: string;
  readonly mainPipe: string;
}
export interface WindowsNativeCandidateAccess {
  close(): void;
  verify(): void;
}
const admissions = new WeakMap<
  WindowsNativeCandidateAccess,
  {
    root: string;
    id: string;
    borrowers: Set<object>;
    closed: boolean;
    lease: ReturnType<ReturnType<typeof loadWindowsAccess>['candidateShared']>;
  }
>();

/** Same Main process only. A copied object or metadata cannot substitute its original native lease. */
export function retainWindowsNativePairedArtifact(
  access: WindowsNativeCandidateAccess,
  proof: RuntimeProtection,
  actual: { entrypoint: string; executable: string; buildId: string },
) {
  const state = admissions.get(access);
  if (
    !state ||
    state.closed ||
    proof.kind !== 'native.candidate' ||
    proof.root !== state.root ||
    proof.manifestSha256 !== state.id ||
    actual.buildId !== `native-${state.id}` ||
    actual.executable !== join(state.root, 'terminal/runtime/bun.exe') ||
    actual.entrypoint !== join(state.root, 'terminal/node_modules/@kite-ai/service/main.js')
  )
    unavailable();
  access.verify();
  const borrower = {};
  state.borrowers.add(borrower);
  return Object.freeze({
    arguments: windowsTerminalRuntimeArguments(join(state.root, 'terminal')),
    release() {
      state.borrowers.delete(borrower);
    },
  });
}
function unavailable(): never {
  throw Object.assign(Error('native_windows_bootstrap_unqualified'), {
    code: 'native_windows_bootstrap_unqualified',
  });
}
/** Addresses select the private read-only certificate endpoints; kernel facts authorize the handoff. */
export function parseWindowsNativeHandoff(argv: readonly string[]): WindowsNativeHandoff {
  const parameters = argv.filter((arg) => arg.startsWith('--kite-native-handoff'));
  if (parameters.length !== 1 || !parameters[0]!.startsWith('--kite-native-handoff='))
    unavailable();
  let value: unknown;
  try {
    value = JSON.parse(parameters[0]!.slice('--kite-native-handoff='.length));
  } catch {
    unavailable();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'launcherPipe,mainPipe' ||
    typeof Reflect.get(value, 'launcherPipe') !== 'string' ||
    typeof Reflect.get(value, 'mainPipe') !== 'string' ||
    !/^\\\\\.\\pipe\\kite-native-launch-[0-9a-f]{32}$/.test(Reflect.get(value, 'launcherPipe')) ||
    !/^\\\\\.\\pipe\\kite-native-main-[0-9a-f]{32}$/.test(Reflect.get(value, 'mainPipe'))
  )
    unavailable();
  return Object.freeze({
    launcherPipe: Reflect.get(value, 'launcherPipe'),
    mainPipe: Reflect.get(value, 'mainPipe'),
  });
}
export function acquireWindowsNativeCandidate(input: {
  root: string;
  windowsAsset: { path: string; sha256: string };
  files: readonly (readonly [string, string, string])[];
  handoff: WindowsNativeHandoff;
}): WindowsNativeCandidateAccess {
  const prefix = dirname(dirname(input.root)),
    id = basename(input.root);
  if (basename(dirname(input.root)) !== 'releases' || !/^[0-9a-f]{64}$/.test(id)) unavailable();
  const lease = loadWindowsAccess(input.windowsAsset).candidateShared(
    input.root,
    prefix,
    id,
    input.files,
    input.handoff,
  );
  // The native factory has already verified both certificates, original files and independent SH.
  const state = { root: input.root, id, borrowers: new Set<object>(), closed: false, lease };
  const access = Object.freeze({
    close() {
      if (state.closed) return;
      if (state.borrowers.size) throw Error('native_windows_candidate_in_use');
      lease.release();
      state.closed = true;
    },
    verify() {
      if (state.closed) unavailable();
      lease.verify();
    },
  });
  admissions.set(access, state);
  return access;
}
