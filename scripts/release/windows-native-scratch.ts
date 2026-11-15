import {
  retainWindowsInstallationRemoval,
  WindowsInstallationFilesInUseError,
} from '../../packages/agent/src/platform/windows-installation-removal';

export class WindowsNativeScratchInUseError extends Error {
  constructor(cause: WindowsInstallationFilesInUseError) {
    super('native_windows_scratch_in_use', { cause });
  }
}

export function retainWindowsNativeScratchRemoval(
  input: Parameters<typeof retainWindowsInstallationRemoval>[0],
) {
  const deadline = performance.now() + 5_500;
  for (;;) {
    try {
      return retainWindowsInstallationRemoval(input);
    } catch (error) {
      // A plain sharing conflict confirms acquisition unwound before any deletion.
      if (!(error instanceof WindowsInstallationFilesInUseError)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new WindowsNativeScratchInUseError(error);
      Bun.sleepSync(Math.min(350, remaining));
    }
  }
}
