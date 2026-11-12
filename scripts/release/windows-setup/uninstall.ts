import { WindowsInstallationFilesInUseError } from '../../../packages/agent/src/platform/windows-installation-removal';
import {
  uninstallWindowsNativeBundle,
  WindowsNativeCandidateInUseError,
} from '../windows-native-install';
import { reportSetupFailure } from './failure';

try {
  const prefix = process.argv[2];
  if (!prefix || process.argv.length !== 3) throw Error('native_setup_arguments_invalid');
  console.log('KITE_SETUP_PHASE verify');
  const deadline = performance.now() + 5_500;
  let waiting = false;
  for (;;) {
    try {
      uninstallWindowsNativeBundle(prefix, () => console.log('KITE_SETUP_PHASE remove'));
      break;
    } catch (error) {
      // These failures occur before file removal and confirm that acquisition was unwound.
      if (
        !(
          error instanceof WindowsNativeCandidateInUseError ||
          error instanceof WindowsInstallationFilesInUseError
        ) ||
        performance.now() >= deadline
      )
        throw error;
      if (!waiting) console.log('KITE_SETUP_PHASE wait');
      waiting = true;
      await Bun.sleep(350);
    }
  }
  console.log('KITE_DESKTOP_UNINSTALL_OK');
} catch (error) {
  reportSetupFailure(error);
  process.exitCode = 1;
}
