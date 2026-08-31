import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('current release entrypoints', () => {
  test('CLI release entrypoint does not import legacy companion or migration owners', () => {
    const source = readFileSync('scripts/release/entrypoints/cli.ts', 'utf8');
    expect(source).not.toContain('local-coordinator-client');
    expect(source).not.toContain('migrate-run-store');
    expect(source).not.toContain('migrate-single-store');
    expect(source).not.toContain('web-recover');
  });

  test('stable launcher enters its main without relying on standalone import.meta.main', () => {
    const source = readFileSync('scripts/release/entrypoints/launcher.ts', 'utf8');
    expect(source).toContain('await main().catch');
    expect(source).not.toContain('import.meta.main');
  });

  test('developer Server and TUI build Web assets before the Service-owned preflight', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const source = readFileSync('scripts/development/ensure-web.ts', 'utf8');
    expect(manifest.scripts?.server).toBe('bun run scripts/development/ensure-web.ts');
    expect(manifest.scripts?.['web:dev']).toBe('bun run scripts/development/ensure-web.ts');
    expect(source.indexOf("'build'")).toBeLessThan(source.indexOf("'agent', 'web'"));
    expect(source).not.toContain('preflightWebGatewayStaticAssets');
    expect(manifest.scripts?.tui).toContain('apps/kite-web build');
    expect(manifest.scripts?.tui).toContain('entrypoints/tui.ts');
  });
});
