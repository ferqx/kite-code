#!/usr/bin/env bun

import { dirname, resolve } from 'node:path';
import {
  acquireInstalledKiteStoreAdmission,
  reviewPairedDesktopStoreAdmission,
  reviewSourceKiteStoreAdmission,
} from '@kite-ai/kite-local-runtime/service';
import {
  encodeServiceStartupDiagnostic,
  encodeServiceStartupProgress,
} from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { runKiteServiceMain } from '../../../apps/kite-service/src/executable';
import { sourceServiceBuildIdentity } from '../local-service-client';
import { storeAdmissionFailure } from './store-admission-error';

await runKiteServiceMain(undefined, {
  onStoreStartupProgress(stage) {
    process.stderr.write(encodeServiceStartupProgress(stage));
  },
  assertRetiredStoreWritersStopped(databasePath) {
    if (
      process.env.KITE_STANDALONE_EXECUTABLE === '1' &&
      !process.env.KITE_DESKTOP_PAIRED_MANIFEST_SHA256
    ) {
      const result = acquireInstalledKiteStoreAdmission({
        canonicalKiteHome: dirname(databasePath),
        runtimeRoot: process.env.KITE_CODE_HOME ?? '',
      });
      if (!result.admitted) throw storeAdmissionFailure('Installed Store', result.reason);
      return result.lease;
    }
    if (process.env.KITE_STANDALONE_EXECUTABLE === '1') {
      const result = reviewPairedDesktopStoreAdmission({
        canonicalKiteHome: dirname(databasePath),
        runtimeRoot: process.env.KITE_CODE_HOME ?? '',
        ...(process.env.KITE_DESKTOP_SOURCE_ROOT
          ? { sourceRepositoryRoot: process.env.KITE_DESKTOP_SOURCE_ROOT }
          : {}),
      });
      if (!result.admitted) throw storeAdmissionFailure('Paired Desktop Store', result.reason);
      return;
    }
    const repositoryRoot = resolve(import.meta.dir, '../../..');
    const result = reviewSourceKiteStoreAdmission({
      repositoryRoot,
      canonicalKiteHome: dirname(databasePath),
      runtimeRoot: process.env.KITE_CODE_HOME ?? '',
      expectedSourceBuildId: sourceServiceBuildIdentity(repositoryRoot),
    });
    if (!result.admitted) throw storeAdmissionFailure('Store', result.reason);
  },
}).catch((error: unknown) => {
  process.stderr.write(encodeServiceStartupDiagnostic(error) ?? '[kite-service] service failed\n');
  process.exitCode = 1;
});
