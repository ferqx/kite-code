import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  KITE_HOME_STORE_FORMAT_EPOCH,
  KITE_SESSION_STORE_FORMAT_EPOCH,
} from '@kite-ai/runtime-storage-sqlite';

const source = (path: string): string => readFileSync(path, 'utf8');

describe('KASD App Server/Session decoupling transition baseline', () => {
  test('freezes the current single-Service Store and process owners before fencing work', () => {
    expect(KITE_HOME_STORE_FORMAT_EPOCH).toBe('kite-home-single-service-v1-2026-08-30');
    expect(source('packages/runtime-storage-sqlite/src/kite-home-runtime-file.ts')).toContain(
      "expectedBasename = 'kite.sqlite'",
    );
    expect(source('apps/kite-service/src/bootstrap.ts')).toContain(
      "databasePath: join(kiteHomeRoot, 'kite.sqlite')",
    );
    expect(source('apps/kite-service/src/workspace-worker/runtime-composition.ts')).toContain(
      'options.ownerLock.acquire(workerIdentity)',
    );
  });

  test('admits the completed KASD-01 exact Store and multi-connection owner', () => {
    expect(KITE_SESSION_STORE_FORMAT_EPOCH).toBe('kite-session-app-server-2026-09-02');
    expect(source('packages/runtime-storage-sqlite/src/kite-session-runtime-file.ts')).toContain(
      "'store_upgrade_required'",
    );
    const authority = source(
      'packages/runtime-storage-sqlite/src/kite-session-execution-authority.ts',
    );
    expect(authority).toContain('controllerGeneration');
    expect(authority).toContain("status: 'recovery_required'");
    expect(source('packages/runtime-storage-sqlite/src/kite-session-mutation.ts')).toContain(
      'createKiteSessionMutationPort',
    );
    expect(source('packages/runtime-storage-sqlite/src/kite-session-effects.ts')).toContain(
      'assertDispatchable',
    );
    const owner = source('packages/runtime-storage-sqlite/src/kite-session-runtime-storage.ts');
    expect(owner).toContain('new AsyncLocalStorage<KiteSessionExecutionHandle>()');
    expect(owner).toContain('createForkTargetAuthorityInTransaction');
    expect(owner).toContain('markGenerationUnknownInTransaction');
  });

  test('keeps the legacy standalone Service outside the default TUI and CLI Runtime path', () => {
    const composition = source('scripts/release/single-service-native-client.ts');
    expect(composition).toContain("serviceTopology?: 'shared' | 'standalone'");
    expect(composition).toContain('createStandaloneRuntimeHome()');
    expect(composition).not.toContain('kite-session.sqlite');
    expect(source('scripts/release/entrypoints/tui.ts')).not.toContain(
      'createManagedLocalSingleServiceComposition',
    );
  });

  test('routes default TUI and CLI Runtime work through the paired App Server', () => {
    expect(source('apps/kite-service/src/executable.ts')).toContain('runKiteAppServerMain');
    expect(source('apps/kite-service/src/app-server.ts')).toContain("'kite-session.sqlite'");
    const tui = source('scripts/release/entrypoints/tui.ts');
    const cli = source('scripts/release/entrypoints/cli.ts');
    expect(tui).toContain('createManagedLocalAppServerComposition');
    expect(tui).not.toContain('discoverWeb');
    expect(cli).toContain('runtimeConnector: appServer.connector');
    expect(source('scripts/release/app-server-client.ts')).toContain('sourceKiteSessionStorePath');
  });

  test('binds the accepted decision and active plan without changing current authority', () => {
    expect(
      source('docs/adr/0166-decouple-app-server-process-from-durable-session-authority.md'),
    ).toContain('状态：accepted');
    const plan = source('docs/space/plans/2026-09-02-app-server-session-decoupling.md');
    expect(plan).toContain('状态：active');
    expect(plan).toContain('kite-session-app-server-2026-09-02');
    expect(plan).toContain('kite-source-runtime-profile\\0');
    expect(plan).toContain('| KASD-01 | completed |');
    expect(plan).toContain('| KASD-02 | completed |');
    expect(plan).toContain('| KASD-03 | in_progress |');
    expect(
      source('docs/space/plans/2026-08-30-kite-home-and-local-runtime-simplification.md'),
    ).toContain('状态：superseded');
  });
});
