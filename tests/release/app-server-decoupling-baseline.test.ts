import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KITE_HOME_STORE_FORMAT_EPOCH } from '@kite-ai/runtime-storage-sqlite';

const source = (path: string): string => readFileSync(path, 'utf8');

describe('KASD-00 App Server/Session decoupling baseline', () => {
  test('freezes the current single-Service Store and process owners before fencing work', () => {
    expect(KITE_HOME_STORE_FORMAT_EPOCH).toBe('kite-home-single-service-v1-2026-08-30');
    expect(source('packages/runtime-storage-sqlite/src/kite-home-runtime-file.ts')).toContain(
      "basename(path) !== 'kite.sqlite'",
    );
    expect(source('apps/kite-service/src/bootstrap.ts')).toContain(
      "databasePath: join(kiteHomeRoot, 'kite.sqlite')",
    );
    expect(source('apps/kite-service/src/workspace-worker/runtime-composition.ts')).toContain(
      'options.ownerLock.acquire(workerIdentity)',
    );
  });

  test('keeps the source standalone Store as an explicit unshipped transition', () => {
    const composition = source('scripts/release/single-service-native-client.ts');
    expect(composition).toContain("serviceTopology?: 'shared' | 'standalone'");
    expect(composition).toContain('createStandaloneRuntimeHome()');
    expect(composition).not.toContain('kite-session.sqlite');
  });

  test('does not prematurely add the future Store, fencing API, or App Server entrypoint', () => {
    const production = [
      source('packages/runtime-storage-sqlite/src/kite-home-runtime-storage.ts'),
      source('apps/kite-service/src/executable.ts'),
      source('scripts/release/entrypoints/tui.ts'),
    ].join('\n');
    expect(production).not.toContain('kite-session.sqlite');
    expect(production).not.toContain('sessionMutation');
    expect(production).not.toContain('app-server');
  });

  test('binds the accepted decision and active plan without changing current authority', () => {
    expect(
      source('docs/adr/0166-decouple-app-server-process-from-durable-session-authority.md'),
    ).toContain('状态：accepted');
    const plan = source('docs/space/plans/2026-09-02-app-server-session-decoupling.md');
    expect(plan).toContain('状态：active');
    expect(plan).toContain('kite-session-app-server-2026-09-02');
    expect(plan).toContain('kite-source-runtime-profile\\0');
    expect(
      source('docs/space/plans/2026-08-30-kite-home-and-local-runtime-simplification.md'),
    ).toContain('状态：superseded');
  });
});
