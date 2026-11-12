import { dirname } from 'node:path';
import { privateDirectory } from '../../../packages/agent/src/platform/windows-path-security';
import { createWindowsNativeArchiveScratch, unpackNativeBundle } from '../native-archive';
import {
  installWindowsNativeBundle,
  replaceWindowsNativeBundle,
  uninstallWindowsNativeBundle,
} from '../windows-native-install';
import { reportSetupFailure } from './failure';
import { hideSetupCoordination, prepareSetupLocation } from './install-location';

declare const __KITE_SETUP_CANDIDATE__: string;

const [archivePath, sha256, location, registered] = process.argv.slice(2);
if (!archivePath || !sha256 || !location || process.argv.length > 6) {
  reportSetupFailure(Error('native_setup_arguments_invalid'));
  process.exit(1);
}
const destination = (() => {
  try {
    return prepareSetupLocation(location, {
      candidate: __KITE_SETUP_CANDIDATE__,
      ...(registered ? { registered } : {}),
    });
  } catch (error) {
    reportSetupFailure(error);
    process.exit(3);
  }
})();
const install = () =>
  installWindowsNativeBundle({
    archivePath,
    sha256,
    prefix: destination.prefix,
    embeddedCandidateId: __KITE_SETUP_CANDIDATE__,
    onUnpack: () => console.log('KITE_SETUP_PHASE unpack'),
    onPublish: () => console.log('KITE_SETUP_PHASE publish'),
  });
const removing = () => console.log('KITE_SETUP_PHASE replace');
try {
  const result =
    destination.replacing === location
      ? replaceDirectInstallation()
      : destination.replacing
        ? replaceWindowsNativeBundle(destination.replacing, install, removing)
        : install();
  hideSetupCoordination(result.root);
  if (destination.replacing) hideSetupCoordination(destination.replacing);
  console.log(`KITE_DESKTOP_SETUP_OK ${result.candidateId} ${destination.layout}`);
} catch (error) {
  reportSetupFailure(error);
  process.exitCode = 1;
}

function replaceDirectInstallation() {
  const stage = createWindowsNativeArchiveScratch(location!);
  try {
    const bundle = unpackNativeBundle({
      archivePath: archivePath!,
      sha256: sha256!,
      destination: stage.destination,
    });
    stage.accept(bundle);
    if (bundle.digest !== __KITE_SETUP_CANDIDATE__) throw Error('native_windows_candidate_changed');
    uninstallWindowsNativeBundle(location!, removing);
    privateDirectory(location!);
    privateDirectory(dirname(destination.prefix));
    return installWindowsNativeBundle({ bundleRoot: bundle.root, prefix: destination.prefix });
  } finally {
    stage.release();
  }
}
