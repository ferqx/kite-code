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

  test('developer Web startup builds and preflights assets before single-Service ensure', () => {
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
