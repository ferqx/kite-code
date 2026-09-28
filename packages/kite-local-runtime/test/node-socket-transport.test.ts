import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import { createNodeSocketRuntimeClientTransport } from '../src/client';
import type { KiteLocalRuntimeEndpoint } from '../src/service';

describe('Node socket Runtime client transport', () => {
  test.each([
    ['malformed JSON', '{not-json}\n', 'socket_malformed_json'],
    ['an overlong unterminated line', 'x'.repeat(33), 'socket_overlong_line'],
  ] as const)('fails closed on %s', async (_label, payload, expectedDiagnostic) => {
    const fixture = endpointFixture();
    const server = createServer((socket) => socket.write(payload));
    await listen(server, fixture.endpoint);
    const diagnostics: string[] = [];
    const connection = await createNodeSocketRuntimeClientTransport({
      endpoint: fixture.endpoint,
      maxLineBytes: 32,
      onDiagnostic: (code) => diagnostics.push(code),
    }).connect();
    try {
      await expect(connection.messages()[Symbol.asyncIterator]().next()).rejects.toThrow(
        'App Server daemon connection failed.',
      );
      expect(diagnostics).toContain(expectedDiagnostic);
    } finally {
      await connection.close('test');
      await close(server);
      fixture.cleanup();
    }
  });

  test('returns a rejected Promise for invalid outbound logical messages', async () => {
    const fixture = endpointFixture();
    const server = createServer();
    await listen(server, fixture.endpoint);
    const connection = await createNodeSocketRuntimeClientTransport({
      endpoint: fixture.endpoint,
    }).connect();
    try {
      await expect(
        connection.send({ invalid: true } as unknown as RuntimeProtocolMessage),
      ).rejects.toThrow('Socket Runtime refused an invalid message.');
    } finally {
      await connection.close('test');
      await close(server);
      fixture.cleanup();
    }
  });

  test.each([
    300, 1_000,
  ])('drains %d responses from one socket write with a bounded queue', async (count) => {
    const fixture = endpointFixture();
    let resolvePeer!: (socket: import('node:net').Socket) => void;
    const peer = new Promise<import('node:net').Socket>((resolve) => {
      resolvePeer = resolve;
    });
    const server = createServer((socket) => resolvePeer(socket));
    await listen(server, fixture.endpoint);
    const diagnostics: string[] = [];
    const connection = await createNodeSocketRuntimeClientTransport({
      endpoint: fixture.endpoint,
      maxQueuedMessages: 1,
      onDiagnostic: (code) => diagnostics.push(code),
    }).connect();
    const socket = await peer;
    try {
      const messages = connection.messages()[Symbol.asyncIterator]();
      const receiving = (async () => {
        const ids: string[] = [];
        let timerRan = false;
        for (let index = 0; index < count; index++) {
          const item = await messages.next();
          expect(item.done).toBe(false);
          ids.push((item.value as { id: string }).id);
          if (count === 1_000 && index === 0)
            setImmediate(() => {
              timerRan = true;
            });
          if (count === 1_000 && index === 500) expect(timerRan).toBe(true);
        }
        return ids;
      })();
      socket.write(
        Array.from(
          { length: count },
          (_, index) =>
            `${JSON.stringify({ jsonrpc: '2.0', id: `bulk-${index}`, result: { status: 'ok' } })}\n`,
        ).join(''),
      );
      socket.end();
      expect(await receiving).toEqual(Array.from({ length: count }, (_, index) => `bulk-${index}`));
      await expect(messages.next()).rejects.toThrow('App Server daemon connection failed.');
      expect(diagnostics).toEqual(['socket_connection_closed']);
    } finally {
      await connection.close();
      socket.destroy();
      await close(server);
      fixture.cleanup();
    }
  });
});

function endpointFixture(): {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly cleanup: () => void;
} {
  if (process.platform === 'win32') {
    return {
      endpoint: {
        kind: 'named_pipe',
        homeDigest: 'test',
        pipeName: `\\\\.\\pipe\\kite-node-socket-test-${randomUUID()}`,
      },
      cleanup: () => undefined,
    };
  }
  const root = mkdtempSync(join(tmpdir(), 'kite-node-socket-'));
  chmodSync(root, 0o700);
  return {
    endpoint: {
      kind: 'unix',
      homeDigest: 'test',
      root,
      socket: join(root, 'app-server.sock'),
      lifecycleReservation: join(root, 'app-server.lock'),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function listen(server: Server, endpoint: KiteLocalRuntimeEndpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint.kind === 'unix' ? endpoint.socket : endpoint.pipeName, resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
