import {
  type KiteSessionStoreAdmissionReason,
  KiteSessionStoreOpenError,
} from '@kite-ai/runtime-storage-sqlite';

type AdmissionScope = 'Installed Store' | 'Paired Desktop Store' | 'Store';

const ADMISSION_REASONS = new Set<KiteSessionStoreAdmissionReason>([
  'unsupported_platform',
  'desktop_identity_mismatch',
  'paired_manifest_mismatch',
  'desktop_parent_unverified',
  'installed_identity_mismatch',
  'release_selection_busy_or_unsafe',
  'installed_parent_unverified',
  'installed_process_inspection_incomplete',
  'source_identity_mismatch',
  'source_build_mismatch',
  'source_parent_unverified',
  'legacy_process_inspection_incomplete',
]);

/** Only an observed live legacy writer is known to be a temporary admission failure. */
export function storeAdmissionFailure(
  scope: AdmissionScope,
  reason: string,
): KiteSessionStoreOpenError {
  if (reason === 'legacy_process_busy')
    return new KiteSessionStoreOpenError(
      'store_busy',
      'A Kite client is still using the session Store. Retry after it exits.',
    );
  const admissionReason: KiteSessionStoreAdmissionReason = ADMISSION_REASONS.has(
    reason as KiteSessionStoreAdmissionReason,
  )
    ? (reason as KiteSessionStoreAdmissionReason)
    : 'admission_unverified';
  return new KiteSessionStoreOpenError(
    'store_admission_failed',
    `${scope} writer admission is unavailable: ${admissionReason}.`,
    { admissionReason },
  );
}
