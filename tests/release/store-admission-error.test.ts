import { describe, expect, test } from 'bun:test';
import {
  encodeServiceStartupDiagnostic,
  parseServiceStartupDiagnostic,
} from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { KiteSessionStoreOpenError } from '@kite-ai/runtime-storage-sqlite';
import { storeAdmissionFailure } from '../../scripts/release/entrypoints/store-admission-error';

describe('Service Store admission errors', () => {
  test('observed old writer is a retryable, path-free busy diagnostic', () => {
    for (const scope of ['Installed Store', 'Paired Desktop Store', 'Store'] as const) {
      const error = storeAdmissionFailure(scope, 'legacy_process_busy');
      expect(error).toBeInstanceOf(KiteSessionStoreOpenError);
      expect((error as KiteSessionStoreOpenError).code).toBe('store_busy');
      if (scope !== 'Store') expect(error.message).not.toContain(scope);
      expect(error.message).not.toContain('legacy_process_busy');
    }
  });

  test('incomplete identity and release selection retain finite, non-retryable reasons', () => {
    for (const reason of [
      'legacy_process_inspection_incomplete',
      'release_selection_busy_or_unsafe',
      'installed_parent_unverified',
      'installed_process_inspection_incomplete',
      'desktop_identity_mismatch',
      'paired_manifest_mismatch',
      'desktop_parent_unverified',
      'source_identity_mismatch',
      'unsupported_platform',
    ] as const) {
      const error = storeAdmissionFailure('Store', reason);
      expect(error).toBeInstanceOf(KiteSessionStoreOpenError);
      expect(error.code).toBe('store_admission_failed');
      expect(error.admissionReason).toBe(reason);
      expect(parseServiceStartupDiagnostic(encodeServiceStartupDiagnostic(error)!)).toMatchObject({
        code: 'store_admission_failed',
        admissionReason: reason,
      });
    }
    const unknown = storeAdmissionFailure('Store', '/private/secret');
    expect(unknown.admissionReason).toBe('admission_unverified');
    expect(unknown.message).not.toContain('/private/secret');
  });
});
