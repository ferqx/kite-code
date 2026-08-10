import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { nativeSandboxSmokeEnabled } from './native-sandbox-policy';

const smokeFile = resolve(import.meta.dir, 'native-sandbox.test.ts');

describe('native sandbox smoke lifecycle', () => {
  test('enables only the explicit native smoke switch', () => {
    expect(nativeSandboxSmokeEnabled({})).toBe(false);
    expect(nativeSandboxSmokeEnabled({ KITE_RUN_NATIVE_SANDBOX_SMOKE: '0' })).toBe(false);
    expect(nativeSandboxSmokeEnabled({ KITE_RUN_NATIVE_SANDBOX_SMOKE: '1' })).toBe(true);
  });

  test('default discovery skips the whole suite without constructing fixtures', () => {
    const env = { ...process.env };
    delete env.KITE_RUN_NATIVE_SANDBOX_SMOKE;

    const result = Bun.spawnSync(
      ['bun', 'test', '--parallel=1', '--max-concurrency=1', smokeFile],
      {
        cwd: resolve(import.meta.dir, '../../..'),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

    expect(result.exitCode, output).toBe(0);
    expect(output).toContain('(skip) TUI PTY native sandbox smoke');
    expect(output).toContain('0 fail');
    expect(output).not.toContain('Mock model fixture incomplete');
  });
});
