import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CoordinatorCatalog,
  CoordinatorRegistry,
  CoordinatorSessionMetadata,
} from '@kite-ai/kite-local-runtime/coordinator';
import type { KiteCoordinatorProcessEnvironment } from '../../src/coordinator/main';
import {
  coordinatorCompanionName,
  createProductionKiteCoordinatorComposition,
  syncCoordinatorDirectory,
} from '../../src/coordinator/production';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Coordinator composition', () => {
  test('pins source and installed companions to the explicit build-owned root and identity', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/coordinator/production.ts'),
      'utf8',
    );

    expect(coordinatorCompanionName('worker')).toBe(
      process.platform === 'win32' ? 'kite-worker.exe' : 'kite-worker',
    );
    expect(coordinatorCompanionName('gateway')).toBe(
      process.platform === 'win32' ? 'kite-web-gateway.exe' : 'kite-web-gateway',
    );

    expect(source).toContain(
      "environment.companionRoot,\n    'scripts',\n    'release',\n    'entrypoints',\n    'worker.ts'",
    );
    expect(source).toMatch(/environment\.companionRoot,\s*'bin', `kite-worker\$\{suffix\}`/u);
    expect(source).toContain(
      "environment.companionRoot,\n    'scripts',\n    'release',\n    'entrypoints',\n    'gateway.ts'",
    );
    expect(source).toMatch(/environment\.companionRoot,\s*'bin', `kite-web-gateway\$\{suffix\}`/u);
    expect(source).toContain('sourceBuildId: environment.buildId');
    expect(source).toContain('installedBuildId: environment.buildId');
    expect(source).toContain('cwd: ({ workspace }) => workspace.canonicalPath');

    expect(source).not.toContain('process.cwd()');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('process.env.PATH');
    expect(source).not.toContain('import.meta.dir');
  });

  test('rejects active-layout drift before creating production process composition', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-production-home-')));
    const coordinationHome = realpathSync(
      mkdtempSync(join(tmpdir(), 'kite-coordinator-production-coordination-')),
    );
    roots.push(home, coordinationHome);
    mkdirSync(join(home, 'layouts', 'generation-other'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, 'active-layout'),
      JSON.stringify({ schema: 'kite.runtime-active-layout.v1', generation: 'generation-other' }) +
        '\n',
      { mode: 0o600 },
    );
    chmodSync(join(home, 'active-layout'), 0o600);

    const environment = productionEnvironment(home, coordinationHome);
    await expect(createProductionKiteCoordinatorComposition(environment)).rejects.toThrow(
      'active layout generation changed',
    );
    expect(() => readFileSync(join(home, 'active-layout'), 'utf8')).not.toThrow();
    expect(() => readFileSync(join(coordinationHome, 'managed-process-cwd'), 'utf8')).toThrow();
  });

  test('injects one shared registry into Worker, Gateway, and Coordinator composition', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/coordinator/production.ts'),
      'utf8',
    );
    const registryCreation = source.indexOf('const registry = createCoordinatorRegistry();');
    const workerRegistration = source.indexOf('registry.registerWorker(value)', registryCreation);
    const gatewayRegistration = source.indexOf(
      'registry.ensureWebGateway(value)',
      registryCreation,
    );
    const compositionRegistry = source.indexOf('    registry,', gatewayRegistration);

    expect(registryCreation).toBeGreaterThanOrEqual(0);
    expect(workerRegistration).toBeGreaterThan(registryCreation);
    expect(gatewayRegistration).toBeGreaterThan(workerRegistration);
    expect(compositionRegistry).toBeGreaterThan(gatewayRegistration);
    expect(source.match(/createCoordinatorRegistry\(/gu)).toHaveLength(1);
  });

  test('release Coordinator entrypoint injects the production factory explicitly', () => {
    const entrypoint = readFileSync(
      join(import.meta.dir, '../../../../scripts/release/entrypoints/coordinator.ts'),
      'utf8',
    );

    expect(entrypoint).toContain(
      "import { createProductionKiteCoordinatorComposition } from '../../../apps/kite-service/src/coordinator/production';",
    );
    expect(entrypoint).toContain(
      'await runKiteCoordinatorMain(process.argv.slice(2), {\n  environment: process.env,\n  createComposition: createProductionKiteCoordinatorComposition,\n});',
    );
    expect(entrypoint).not.toContain('runKiteServiceMain');
  });

  test('folds authenticated Worker outbox pages into Catalog and registry with cursor CAS', async () => {
    const sessions: CoordinatorSessionMetadata[] = [];
    const cursors = new Map<string, string>();
    const catalog = {
      listSessions: () => [...sessions],
      upsertSession(metadata: CoordinatorSessionMetadata) {
        sessions.splice(
          0,
          sessions.length,
          ...sessions.filter((entry) => entry.sessionId !== metadata.sessionId),
          metadata,
        );
      },
      outboxCursor: (scope: string) => cursors.get(scope),
      advanceOutboxCursor(scope: string, expected: string | undefined, next: string) {
        if (cursors.get(scope) !== expected) return false;
        cursors.set(scope, next);
        return true;
      },
    } as unknown as CoordinatorCatalog;
    const mirrored: CoordinatorSessionMetadata[] = [];
    const registry = {
      upsertSessionMetadata(metadata: CoordinatorSessionMetadata) {
        mirrored.push(metadata);
      },
    } as unknown as CoordinatorRegistry;
    const requested: number[] = [];
    await syncCoordinatorDirectory(
      {
        listKnownScopes: async () => ['scope-sync'],
        async readDirectoryOutbox({ cursor }) {
          requested.push(cursor ?? 0);
          return cursor === 0
            ? {
                entries: [
                  {
                    sessionId: 'session-sync',
                    workerScopeId: 'scope-sync',
                    revision: 4,
                    updatedAt: 1_787_952_000_000,
                    tombstone: false,
                  },
                ],
                nextCursor: 7,
                hasMore: true,
              }
            : { entries: [], hasMore: false };
        },
      },
      { catalog, registry },
    );
    expect(requested).toEqual([0, 7]);
    expect(cursors.get('scope-sync')).toBe('7');
    expect(sessions).toEqual(mirrored);
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-sync',
      workerScopeId: 'scope-sync',
      directoryRevision: '4',
      tombstone: false,
    });
    expect(JSON.stringify(sessions)).not.toContain('/');
  });
});

function productionEnvironment(
  home: string,
  coordinationHome: string,
): KiteCoordinatorProcessEnvironment {
  return {
    home,
    coordinationHome,
    catalogPath: join(home, 'layouts', 'generation-requested', 'catalog.sqlite'),
    layoutGeneration: 'generation-requested',
    buildId: 'build-production-test',
    executableMode: 'source',
    companionRoot: join(home, 'companion-root'),
    webStaticRoot: join(home, 'web-static'),
    readinessFd: 3,
    peerOsIdentity: {
      kind: 'posix_uid',
      uid: typeof process.getuid === 'function' ? process.getuid() : 1,
    },
    processStartIdentity: 'process-start-production-test',
    instanceId: 'coordinator-production-test',
  };
}
