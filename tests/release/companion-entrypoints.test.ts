import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('current release entrypoints', () => {
  test('Web startup stops at the first failed step and preserves its exit code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-web-start-'));
    try {
      mkdirSync(join(root, 'scripts/development'), { recursive: true });
      mkdirSync(join(root, 'apps/kite-web'), { recursive: true });
      copyFileSync(
        'scripts/development/ensure-web.ts',
        join(root, 'scripts/development/ensure-web.ts'),
      );
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ scripts: { agent: 'bun step.ts' } }),
      );
      writeFileSync(
        join(root, 'apps/kite-web/package.json'),
        JSON.stringify({ scripts: { build: 'bun ../../step.ts build' } }),
      );
      writeFileSync(
        join(root, 'step.ts'),
        `
        const step = process.argv[2];
        console.log('STEP:' + step);
        if (step === process.env.FAIL_STEP) process.exit(7);
      `,
      );
      for (const [failure, steps] of [
        ['build', ['build']],
        ['server', ['build', 'server']],
        ['web', ['build', 'server', 'web']],
        ['', ['build', 'server', 'web']],
      ] as const) {
        const child = Bun.spawn(
          [process.execPath, join(root, 'scripts/development/ensure-web.ts')],
          {
            env: { ...process.env, FAIL_STEP: failure },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [output, , exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(failure ? 7 : 0);
        expect(output.trim().split('\n')).toEqual(steps.map((step) => `STEP:${step}`));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI release entrypoint does not import legacy companion or migration owners', () => {
    const source = readFileSync('scripts/release/entrypoints/cli.ts', 'utf8');
    expect(source).not.toContain('local-coordinator-client');
    expect(source).not.toContain('migrate-run-store');
    expect(source).not.toContain('migrate-single-store');
    expect(source).not.toContain('web-recover');
    expect(source).toContain('createManagedLocalAppServerComposition');
    expect(source).toContain('runtimeConnector: connector');
    expect(source).toContain('createManagedLocalAppServerDaemon');
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

  test('release entrypoints contain no previous-build Service replacement path', () => {
    const source = readFileSync('scripts/release/entrypoints/cli.ts', 'utf8');
    expect(source).not.toContain('clientForBuild');
    expect(source).not.toContain('canReplaceInstalledBuild');
    expect(source).not.toContain("command.startsWith('service-')");
  });
});
