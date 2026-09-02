import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createKiteHomeIdentity,
  kiteHomeRuntimeDigest,
  resolveKiteAppServerDaemonEndpoint,
  resolveKiteLocalRuntimeEndpoint,
} from '../../src/service';

describe('single Service runtime endpoint contract', () => {
  test('isolates POSIX endpoints by canonical Kite home digest', () => {
    const runtimeParent = '/run/user/501';
    const first = createKiteHomeIdentity('/Users/test/.kite-code');
    const second = createKiteHomeIdentity('/tmp/other-kite-home');
    const firstEndpoint = resolveKiteLocalRuntimeEndpoint({
      home: first,
      platform: 'darwin',
      runtimeParent,
    });
    const secondEndpoint = resolveKiteLocalRuntimeEndpoint({
      home: second,
      platform: 'linux',
      runtimeParent,
    });
    expect(firstEndpoint.kind).toBe('unix');
    expect(secondEndpoint.kind).toBe('unix');
    if (firstEndpoint.kind !== 'unix' || secondEndpoint.kind !== 'unix') return;
    expect(firstEndpoint.homeDigest).toBe(kiteHomeRuntimeDigest(first));
    expect(firstEndpoint.root).toBe(
      join(runtimeParent, 'kite-code', 'v1', kiteHomeRuntimeDigest(first)),
    );
    expect(firstEndpoint.socket).toBe(join(firstEndpoint.root, 'service.sock'));
    expect(firstEndpoint.lifecycleReservation).toBe(join(firstEndpoint.root, 'service.lock'));
    expect(secondEndpoint.root).not.toBe(firstEndpoint.root);
  });

  test('uses one path-free named pipe identity on Windows', () => {
    const home = createKiteHomeIdentity('/validated/windows/kite-home');
    const endpoint = resolveKiteLocalRuntimeEndpoint({ home, platform: 'win32' });
    expect(endpoint).toEqual({
      kind: 'named_pipe',
      homeDigest: kiteHomeRuntimeDigest(home),
      pipeName: `\\\\.\\pipe\\kite-service-v1-${kiteHomeRuntimeDigest(home)}`,
    });
    expect(JSON.stringify(endpoint)).not.toContain('validated');
  });

  test('keeps the explicit App Server daemon endpoint distinct from legacy Service', () => {
    const home = createKiteHomeIdentity('/Users/test/.kite-code');
    const runtimeParent = '/run/user/501';
    const daemon = resolveKiteAppServerDaemonEndpoint({
      home,
      platform: 'darwin',
      runtimeParent,
    });
    const service = resolveKiteLocalRuntimeEndpoint({
      home,
      platform: 'darwin',
      runtimeParent,
    });
    expect(daemon).toEqual({
      kind: 'unix',
      homeDigest: kiteHomeRuntimeDigest(home),
      root: service.kind === 'unix' ? service.root : '',
      socket:
        service.kind === 'unix' ? join(service.root, 'app-server.sock') : 'unexpected-service-kind',
      lifecycleReservation:
        service.kind === 'unix' ? join(service.root, 'app-server.lock') : 'unexpected-service-kind',
    });
    expect(resolveKiteAppServerDaemonEndpoint({ home, platform: 'win32' })).toEqual({
      kind: 'named_pipe',
      homeDigest: kiteHomeRuntimeDigest(home),
      pipeName: `\\\\.\\pipe\\kite-app-server-v1-${kiteHomeRuntimeDigest(home)}`,
    });
  });

  test('requires an explicit verified POSIX runtime parent', () => {
    const home = createKiteHomeIdentity('/Users/test/.kite-code');
    expect(() => resolveKiteLocalRuntimeEndpoint({ home, platform: 'darwin' })).toThrow(
      'OS runtime parent must be a non-empty absolute path',
    );
    expect(() =>
      resolveKiteLocalRuntimeEndpoint({
        home,
        platform: 'linux',
        runtimeParent: 'relative',
      }),
    ).toThrow('OS runtime parent must be a non-empty absolute path');
  });
});
