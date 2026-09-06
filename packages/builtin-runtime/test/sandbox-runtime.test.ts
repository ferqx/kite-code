import { describe, expect, spyOn, test } from 'bun:test';
import {
  buildPolicyProvenReadOnlyEnv,
  resolveSandboxRuntime,
} from '@kite-ai/builtin-runtime/sandbox';

describe('policy-proven read-only environment', () => {
  test('neutralizes POSIX user configuration without enabling an empty external diff', () => {
    const env = buildPolicyProvenReadOnlyEnv('/workspace', {
      platform: 'darwin',
      env: {
        HOME: '/Users/example',
        XDG_CONFIG_HOME: '/Users/example/.config',
        PATH: '/usr/bin:/bin',
      },
      canonicalize: (path) => path,
    });

    expect(env.HOME).toBe('/nonexistent');
    expect(env.XDG_CONFIG_HOME).toBe('/nonexistent');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env).not.toHaveProperty('GIT_EXTERNAL_DIFF');
  });
});

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
