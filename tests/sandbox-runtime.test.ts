import { describe, expect, test } from 'bun:test';
import { createSandboxExecutor, resolveSandboxRuntime } from '../src/core/sandbox';

describe('resolveSandboxRuntime', () => {
  test('resolves disabled sandbox to none without detecting backend', () => {
    let detected = false;

    const runtime = resolveSandboxRuntime({
      enabled: false,
      detectBackend: () => {
        detected = true;
        return 'seatbelt';
      },
    });

    expect(runtime).toEqual({ enabled: false, backend: 'none', available: false });
    expect(detected).toBe(false);
  });

  test('resolves enabled sandbox using detected backend', () => {
    const runtime = resolveSandboxRuntime({
      enabled: true,
      detectBackend: () => 'seatbelt',
    });

    expect(runtime).toEqual({ enabled: true, backend: 'seatbelt', available: true });
  });

  test('marks enabled sandbox unavailable when no backend is detected', () => {
    const runtime = resolveSandboxRuntime({
      enabled: true,
      detectBackend: () => 'none',
    });

    expect(runtime).toEqual({ enabled: true, backend: 'none', available: false });
  });
});

describe('sandbox invocation admission', () => {
  test('fails closed when an enabled Unix sandbox backend is unavailable', async () => {
    const executor = createSandboxExecutor(
      { enabled: true, workspace: process.cwd() },
      { platform: 'linux', detectBackend: () => 'none' },
    );

    const result = await executor({ workspace: process.cwd(), command: 'echo unsafe' });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('admission denied');
  });

  test('rechecks the backend for every invocation', async () => {
    let calls = 0;
    const executor = createSandboxExecutor(
      { enabled: true, workspace: process.cwd() },
      {
        platform: 'linux',
        detectBackend: () => {
          calls += 1;
          return 'none';
        },
      },
    );

    await executor({ workspace: process.cwd(), command: 'first' });
    await executor({ workspace: process.cwd(), command: 'second' });

    expect(calls).toBe(2);
  });

  test('admits the explicit Windows unsandboxed Bash boundary', async () => {
    const executor = createSandboxExecutor(
      { enabled: true, workspace: process.cwd() },
      {
        platform: 'win32',
        detectBackend: () => 'none',
        unsandboxedExecutor: async (input) => ({
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'controlled bash',
          stderr: '',
        }),
      },
    );

    const result = await executor({ workspace: process.cwd(), command: 'echo allowed' });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('controlled bash');
  });
});
