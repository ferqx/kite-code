import { describe, expect, spyOn, test } from 'bun:test';
import { resolveSandboxRuntime } from '@kite-ai/builtin-runtime/sandbox';

describe('resolveSandboxRuntime', () => {
  test('default discovery never launches a backend usability probe', () => {
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(() => {
      throw new Error('pre-lifecycle process probe');
    });
    try {
      expect(() => resolveSandboxRuntime({ enabled: true })).not.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

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
