import { rejectRetiredEntrypoint } from '../development/retired-entrypoints';

export type { InstallMarker } from './historical-install-oss-candidate';
export let ACTIVE_RELEASE_POINTER_FILE: typeof import('./historical-install-oss-candidate').ACTIVE_RELEASE_POINTER_FILE;
export let defaultInstallPrefix: typeof import('./historical-install-oss-candidate').defaultInstallPrefix;
export let installOssCandidate: typeof import('./historical-install-oss-candidate').installOssCandidate;
export let rollbackOssCandidate: typeof import('./historical-install-oss-candidate').rollbackOssCandidate;
export let uninstallOssCandidate: typeof import('./historical-install-oss-candidate').uninstallOssCandidate;
export let readInstallStatus: typeof import('./historical-install-oss-candidate').readInstallStatus;

if (import.meta.main) rejectRetiredEntrypoint('release');
else {
  ({
    ACTIVE_RELEASE_POINTER_FILE,
    defaultInstallPrefix,
    installOssCandidate,
    rollbackOssCandidate,
    uninstallOssCandidate,
    readInstallStatus,
  } = require('./historical-install-oss-candidate'));
}
