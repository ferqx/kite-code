import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  ownsHistoricalStoreFormat,
  violatesActiveDocumentationVersion,
  violatesHistoricalProductionEntity,
  violatesVersionedProductionPath,
} from '../../../scripts/pre-release-architecture-policy';

const storageSource = 'packages/runtime-storage-sqlite/src/';

describe('pre-release architecture historical format policy', () => {
  test('admits only exact Store 9–14 maintenance owners', () => {
    for (const name of [
      'kite-session-store9-conversion.ts',
      'kite-session-store10-to11.ts',
      'kite-session-store11-conversion.ts',
      'kite-session-store11-to12.ts',
      'kite-session-store12-to13.ts',
      'kite-session-store13-to14.ts',
    ]) {
      const path = `${storageSource}${name}`;
      expect(ownsHistoricalStoreFormat(path)).toBe(true);
      expect(violatesVersionedProductionPath(path)).toBe(false);
      expect(
        violatesHistoricalProductionEntity(path, 'convertKiteSessionStore13CandidateTo14'),
      ).toBe(false);
    }
    expect(
      violatesHistoricalProductionEntity(
        `${storageSource}kite-home-store.ts`,
        'KITE_SESSION_STORE13_DDL',
      ),
    ).toBe(false);
    expect(
      violatesHistoricalProductionEntity(
        `${storageSource}kite-session-runtime-file.ts`,
        'KiteSessionStoreCompatibility',
      ),
    ).toBe(false);
  });

  test('admits the exact retired-process admission owners', () => {
    expect(
      violatesHistoricalProductionEntity(
        'packages/kite-local-runtime/src/service/legacy-store-processes.ts',
        'LegacyKiteProcessIdentity',
      ),
    ).toBe(false);
    expect(
      violatesHistoricalProductionEntity(
        'packages/kite-local-runtime/src/service/installed-store-admission.ts',
        'InstalledLegacyProcessBusyError',
      ),
    ).toBe(false);
  });

  test('keeps versioned paths and entities out of ordinary production owners', () => {
    expect(violatesVersionedProductionPath('apps/kite-service/src/runtime/store13-reader.ts')).toBe(
      true,
    );
    expect(violatesVersionedProductionPath(`${storageSource}kite-session-store14-to15.ts`)).toBe(
      true,
    );
    expect(
      violatesHistoricalProductionEntity(
        'apps/kite-service/src/runtime/session.ts',
        'SessionStore14',
      ),
    ).toBe(true);
    expect(
      violatesHistoricalProductionEntity(`${storageSource}log-query.ts`, 'LegacyLogReader'),
    ).toBe(true);
    expect(
      violatesHistoricalProductionEntity(
        'apps/kite-service/src/runtime/session.ts',
        'SessionCompat',
      ),
    ).toBe(true);
  });

  test('admits exact active Store contract owners while rejecting other active owners', () => {
    for (const path of [
      'docs/active/private-artifact-storage.md',
      'docs/active/sqlite-runtime-log-query.md',
    ]) {
      expect(violatesActiveDocumentationVersion(path, 'Store11 → Store14')).toBe(false);
      expect(violatesActiveDocumentationVersion(path, 'State27')).toBe(true);
    }
    expect(violatesActiveDocumentationVersion('docs/active/other.md', 'Store14')).toBe(true);
    expect(violatesActiveDocumentationVersion('docs/active/other.md', 'State27')).toBe(true);
  });

  test('the repository architecture gate passes', () => {
    const root = resolve(import.meta.dir, '../../..');
    const result = Bun.spawnSync(['bun', 'run', 'scripts/check-pre-release-architecture.ts'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('pre-release architecture gate passed');
  });
});
