import { basename, dirname } from 'node:path';
import { loadWindowsAccess } from './windows-access';

export interface WindowsNativeHandoff {
  readonly launcherPipe: string;
  readonly mainPipe: string;
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
}): { close(): void; verify(): void } {
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
  return Object.freeze({ close: () => lease.release(), verify: () => lease.verify() });
}
