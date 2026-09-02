import { describe, expect, test } from 'bun:test';
import {
  RELEASE_STATUS_REQUEST_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { createProtocolKiteAppControlClient } from '../src/client/protocol-app-control';

describe('Protocol Kite App Control client', () => {
  test('uses the closed method and exact request/response codecs', async () => {
    const calls: unknown[] = [];
    const client = createProtocolKiteAppControlClient({
      requestAppControl: async (method, request) => {
        calls.push({ method, request });
        return {
          schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
          revision: 'release-1',
          active: true,
          production: false,
          capabilities: [],
          execution: { admitted: false },
        };
      },
    });

    await expect(
      client.getReleaseStatus({ schema: RELEASE_STATUS_REQUEST_SCHEMA_ }),
    ).resolves.toMatchObject({ schema: RELEASE_STATUS_RESPONSE_SCHEMA_, revision: 'release-1' });
    expect(calls).toEqual([
      {
        method: 'app/release/status',
        request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_ },
      },
    ]);

    await expect(client.getReleaseStatus({ schema: 'wrong' } as never)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
