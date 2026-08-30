import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const companions = [
  {
    path: 'scripts/release/entrypoints/coordinator.ts',
    main: 'runKiteCoordinatorMain',
    factory: 'createProductionKiteCoordinatorComposition',
  },
  {
    path: 'scripts/release/entrypoints/worker.ts',
    main: 'runWorkspaceWorkerMain',
    factory: 'createProductionWorkspaceWorkerRuntime',
  },
  {
    path: 'scripts/release/entrypoints/gateway.ts',
    main: 'runWebGatewayMain',
    factory: 'createProductionWebGatewayCarrier',
  },
] as const;

describe('managed companion release entrypoints', () => {
  for (const companion of companions) {
    test(`${companion.path} delegates to its exact main with its production factory`, () => {
      const source = readFileSync(companion.path, 'utf8');
      expect(source).toContain(companion.main);
      expect(source).toContain(companion.factory);
      expect(source).toContain('process.argv.slice(2)');
      expect(source).toContain('environment: process.env');
      expect(source).not.toContain("throw new Error('not implemented')");
    });
  }

  test('CLI binds the formal migration command only to the release maintenance owner', () => {
    const source = readFileSync('scripts/release/entrypoints/cli.ts', 'utf8');
    expect(source).toContain("command === 'maintenance-migrate-run-store'");
    expect(source).toContain('runStoreMaintenance: localCoordinator.maintenance');
    expect(source).not.toContain('inspectMaintenanceBarrier');
  });

  test('stable launcher enters its main without relying on standalone import.meta.main', () => {
    const source = readFileSync('scripts/release/entrypoints/launcher.ts', 'utf8');
    expect(source).toContain('await main().catch');
    expect(source).not.toContain('import.meta.main');
  });

  test('developer Web startup builds and preflights assets before Gateway ensure', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const source = readFileSync('scripts/development/ensure-web.ts', 'utf8');
    expect(manifest.scripts?.['web:dev']).toBe('bun run scripts/development/ensure-web.ts');
    expect(source.indexOf("'build'")).toBeLessThan(
      source.lastIndexOf('preflightWebGatewayStaticAssets'),
    );
    expect(source.lastIndexOf('preflightWebGatewayStaticAssets')).toBeLessThan(
      source.indexOf("'agent', 'web'"),
    );
  });
});
