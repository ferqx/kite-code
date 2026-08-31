import { describe, expect, test } from 'bun:test';
import {
  createWebGatewayControlLink,
  KITE_WEB_CONTROL_AUTHORIZATION_SCHEME,
  KITE_WEB_CONTROL_RESPONSE_SCHEMA_,
  KITE_WEB_NATIVE_MINT_PATH,
  KITE_WEB_NATIVE_STOP_PATH,
} from '../../src/web-gateway';

const origin = 'http://127.0.0.1:43123';
const credential = 'c'.repeat(43);

describe('Web Gateway native control link', () => {
  test('uses only the exact native credential envelope for mint and stop', async () => {
    const requests: Request[] = [];
    const link = createWebGatewayControlLink({
      origin,
      credential,
      expectedInstanceId: 'gateway-instance-1',
      expectedBuildId: 'gateway-build-1',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const operation = request.url.endsWith(KITE_WEB_NATIVE_MINT_PATH) ? 'mint_launch' : 'stop';
        return controlResponse({
          schema: KITE_WEB_CONTROL_RESPONSE_SCHEMA_,
          operation,
          gatewayInstanceId: 'gateway-instance-1',
          buildId: 'gateway-build-1',
          origin,
          ...(operation === 'mint_launch' ? { launchUrl: origin } : {}),
        });
      },
    });

    await expect(link.mintLaunchUrl()).resolves.toBe(origin);
    await expect(link.stop()).resolves.toBeUndefined();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      KITE_WEB_NATIVE_MINT_PATH,
      KITE_WEB_NATIVE_STOP_PATH,
    ]);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe(
        `${KITE_WEB_CONTROL_AUTHORIZATION_SCHEME} ${credential}`,
      );
      expect(request.headers.get('cookie')).toBeNull();
      expect(request.headers.get('origin')).toBeNull();
      expect(new URL(request.url).search).toBe('');
      expect(await request.text()).toBe('{}');
    }
  });

  test('fails closed on stale identity, unknown fields, and oversized responses', async () => {
    for (const body of [
      {
        schema: KITE_WEB_CONTROL_RESPONSE_SCHEMA_,
        operation: 'mint_launch',
        gatewayInstanceId: 'old-gateway',
        buildId: 'gateway-build-1',
        origin,
        launchUrl: `${origin}/#${'a'.repeat(43)}`,
      },
      {
        schema: KITE_WEB_CONTROL_RESPONSE_SCHEMA_,
        operation: 'mint_launch',
        gatewayInstanceId: 'gateway-instance-1',
        buildId: 'gateway-build-1',
        origin,
        launchUrl: `${origin}/#${'a'.repeat(43)}`,
        rawEndpoint: 'ws://127.0.0.1:1/rpc',
      },
    ]) {
      const link = createWebGatewayControlLink({
        origin,
        credential,
        expectedInstanceId: 'gateway-instance-1',
        expectedBuildId: 'gateway-build-1',
        fetch: async () => controlResponse(body),
      });
      await expect(link.mintLaunchUrl()).rejects.toThrow('unavailable');
    }

    const oversized = createWebGatewayControlLink({
      origin,
      credential,
      expectedInstanceId: 'gateway-instance-1',
      expectedBuildId: 'gateway-build-1',
      fetch: async () =>
        new Response('x', {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': '2049',
          },
        }),
    });
    await expect(oversized.mintLaunchUrl()).rejects.toThrow('unavailable');
  });
});

function controlResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
