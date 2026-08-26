import { describe, expect, test } from 'bun:test';
import { createKiteServiceEnvironment } from '@kite-ai/kite-service';

describe('Kite Service neutral environment', () => {
  test('constructs explicit env and neutral cwd without ambient project values', () => {
    const result = createKiteServiceEnvironment({
      homeRoot: '/Users/test/.kite',
      stateRoot: '/Users/test/.kite/runtime-service/v1',
      source: {
        KITE_CODE_HOME: '/workspace/evil-home',
        PATH: '/usr/bin',
        HOME: '/Users/test',
        USERPROFILE: '/workspace/evil-profile',
        NODE_ENV: 'test',
        PWD: '/workspace/project',
        KITE_TEST_WORKSPACE: '/workspace/project',
        NODE_OPTIONS: '--require=malicious-loader',
        OPENAI_API_KEY: 'secret',
      },
      allowedKeys: ['OPENAI_API_KEY'],
      systemHome: '/Users/test',
      userProfile: '/Users/test',
    });

    expect(result.cwd).toBe('/Users/test/.kite/runtime-service/v1/neutral-cwd');
    expect(result.env).toMatchObject({
      KITE_CODE_HOME: '/Users/test/.kite',
      PATH: '/usr/bin',
      HOME: '/Users/test',
      USERPROFILE: '/Users/test',
      NODE_ENV: 'production',
      OPENAI_API_KEY: 'secret',
    });
    expect(result.env).not.toHaveProperty('PWD');
    expect(result.env).not.toHaveProperty('KITE_TEST_WORKSPACE');
    expect(result.env).not.toHaveProperty('NODE_OPTIONS');
    expect(() =>
      createKiteServiceEnvironment({
        homeRoot: '/tmp/home',
        stateRoot: '/tmp/state',
        allowedKeys: ['NODE_OPTIONS'],
      }),
    ).toThrow();
  });

  test('ignores ambient home and NODE_ENV in favor of trusted explicit identity', () => {
    const result = createKiteServiceEnvironment({
      homeRoot: '/trusted/kite-home',
      stateRoot: '/trusted/kite-home/runtime-service/v1',
      systemHome: '/trusted/os-home',
      userProfile: '/trusted/profile',
      nodeEnvironment: 'development',
      source: {
        HOME: '/workspace/evil-home',
        USERPROFILE: '/workspace/evil-profile',
        NODE_ENV: 'test',
      },
    });

    expect(result.env).toMatchObject({
      KITE_CODE_HOME: '/trusted/kite-home',
      HOME: '/trusted/os-home',
      USERPROFILE: '/trusted/profile',
      NODE_ENV: 'development',
    });
  });

  test('requires absolute roots and safe neutral directory names', () => {
    expect(() =>
      createKiteServiceEnvironment({ homeRoot: 'relative', stateRoot: '/tmp/state' }),
    ).toThrow();
    expect(() =>
      createKiteServiceEnvironment({
        homeRoot: '/tmp/home',
        stateRoot: '/tmp/state',
        neutralDirectoryName: '../project',
      }),
    ).toThrow();
    expect(() =>
      createKiteServiceEnvironment({
        homeRoot: '/tmp/home',
        stateRoot: '/tmp/state',
        source: { PATH: '/bin\nmalicious' },
      }),
    ).toThrow();
  });

  test('does not mutate the caller environment object', () => {
    const source = { PATH: '/bin' };
    const result = createKiteServiceEnvironment({
      homeRoot: '/tmp/home',
      stateRoot: '/tmp/state',
      source,
    });
    expect(source).toEqual({ PATH: '/bin' });
    expect(() => {
      (result.env as Record<string, string>).PATH = '/tmp';
    }).toThrow();
  });
});
