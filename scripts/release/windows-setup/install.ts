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
import { setupProgress } from './progress';

declare const __KITE_SETUP_CANDIDATE__: string;

const [archivePath, sha256, location, registered] = process.argv.slice(2);
if (!archivePath || !sha256 || !location || process.argv.length > 6) {
  reportSetupFailure(Error('native_setup_arguments_invalid'));
  process.exit(1);
}
const progress = setupProgress();
progress.phase('location');
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
const archiveProgress = {
  onArchiveFileChecked(completed: number, total: number) {
    if (completed === 0) progress.phase('archive');
    progress.count('archive', completed, total);
  },
  onArchiveWrite: () => progress.phase('write'),
  onArchiveFileWritten: (completed: number, total: number) =>
    progress.count('write', completed, total),
};
const install = () =>
  installWindowsNativeBundle({
    archivePath,
    sha256,
    prefix: destination.prefix,
    embeddedCandidateId: __KITE_SETUP_CANDIDATE__,
    onUnpack: () => progress.phase('decode'),
    onPublish: () => progress.phase('publish'),
    ...archiveProgress,
  });
const removing = () => progress.phase('replace');
let hashed = 0;
const removalProgress = {
  onVerify: () => progress.phase('verify'),
  onFileHashed: () => progress.count('verify', ++hashed),
  onEntryRemoved: (completed: number, total: number) => progress.count('replace', completed, total),
};
try {
  const result =
    destination.replacing === location
      ? replaceDirectInstallation()
      : destination.replacing
        ? replaceWindowsNativeBundle(destination.replacing, install, removing, removalProgress)
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
    progress.phase('decode');
    const bundle = unpackNativeBundle({
      archivePath: archivePath!,
      sha256: sha256!,
      destination: stage.destination,
      ...archiveProgress,
    });
    stage.accept(bundle);
    if (bundle.digest !== __KITE_SETUP_CANDIDATE__) throw Error('native_windows_candidate_changed');
    uninstallWindowsNativeBundle(location!, removing, removalProgress);
    privateDirectory(location!);
    privateDirectory(dirname(destination.prefix));
    progress.phase('publish');
    return installWindowsNativeBundle({ bundleRoot: bundle.root, prefix: destination.prefix });
  } finally {
    stage.release();
  }
}
