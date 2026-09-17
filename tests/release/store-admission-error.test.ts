import { describe, expect, test } from 'bun:test';
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

  test('incomplete identity and release selection remain protected failures', () => {
    for (const reason of [
      'legacy_process_inspection_incomplete',
      'release_selection_busy_or_unsafe',
      'installed_selection_or_process_unverified',
      'other_distribution_unknown',
      'source_identity_mismatch',
      'unsupported_platform',
    ]) {
      const error = storeAdmissionFailure('Store', reason);
      expect(error).not.toBeInstanceOf(KiteSessionStoreOpenError);
    }
  });
});
