import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('current release entrypoints', () => {
  test('CLI release entrypoint does not import legacy companion or migration owners', () => {
    const source = readFileSync('scripts/release/entrypoints/cli.ts', 'utf8');
    expect(source).not.toContain('local-coordinator-client');
    expect(source).not.toContain('migrate-run-store');
    expect(source).not.toContain('migrate-single-store');
    expect(source).not.toContain('web-recover');
    expect(source).toContain('runtimeConnector: appServer.connector');
  });

  test('stable launcher enters its main without relying on standalone import.meta.main', () => {
    const source = readFileSync('scripts/release/entrypoints/launcher.ts', 'utf8');
    expect(source).toContain('await main().catch');
    expect(source).not.toContain('import.meta.main');
  });

  test('developer Server builds Web assets while default TUI stays stdio-only', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const source = readFileSync('scripts/development/ensure-web.ts', 'utf8');
    expect(manifest.scripts?.server).toBe('bun run scripts/development/ensure-web.ts');
    expect(manifest.scripts?.['web:dev']).toBe('bun run scripts/development/ensure-web.ts');
    expect(source.indexOf("'build'")).toBeLessThan(source.indexOf("'agent', 'web'"));
    expect(source).not.toContain('preflightWebGatewayStaticAssets');
    expect(manifest.scripts?.tui).toBe('bun run scripts/release/entrypoints/tui.ts');
    expect(manifest.scripts?.['tui:fresh']).toBeUndefined();
    const tui = readFileSync('scripts/release/entrypoints/tui.ts', 'utf8');
    expect(tui).toContain('createManagedLocalAppServerComposition');
    expect(tui).toContain('connectRuntime: appServer.connector');
    expect(tui).not.toContain('createManagedLocalSingleServiceComposition');
    expect(tui).not.toContain('discoverWeb');
    expect(tui).not.toContain('manager.restart(');
  });

  test('release composition carries executable mode and previous-build clients into lifecycle', () => {
    const source = readFileSync('scripts/release/single-service-native-client.ts', 'utf8');
    expect(source).toContain('clientForBuild: (buildId) =>');
    expect(source).toContain('canReplaceInstalledBuild');
    expect(source).not.toContain('canReplaceSourceBuild');
    expect(source).toContain('executableMode: options.executable.mode');
  });
});
