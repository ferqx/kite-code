import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KITE_LIFECYCLE_SCHEMA, requestKiteLifecycle } from '@kite-ai/kite-local-runtime/client';
import { serveKiteLifecycleOrRuntime } from '../src/carrier/daemon-lifecycle';

test('lifecycle is selected before Runtime decoding and rejects unknown versions without dispatch', async () => {
  if (process.platform === 'win32') return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-carrier-')));
  const path = join(root, 'control.sock');
  let runtimeCalls = 0;
  let controlCalls = 0;
  const server = createServer((socket) => {
    void serveKiteLifecycleOrRuntime(
      socket,
      async (request) => {
        controlCalls += 1;
        return {
          schema: KITE_LIFECYCLE_SCHEMA,
          requestId: request.requestId,
          operation: 'shutdown',
          outcome: 'instance_changed',
        };
      },
      async () => {
        runtimeCalls += 1;
        socket.destroy();
      },
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve));
    chmodSync(path, 0o600);
    await expect(
      requestKiteLifecycle(
        {
          kind: 'unix',
          root,
          socket: path,
          lifecycleReservation: join(root, 'lock'),
          homeDigest: 'test',
        },
        { operation: 'shutdown', expectedInstanceId: 'old', mode: 'if_idle' },
      ),
    ).resolves.toMatchObject({ outcome: 'instance_changed' });
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      let data = '';
      socket.on('connect', () =>
        socket.write(
          `${JSON.stringify({
            schema: 'kite.lifecycle.v999',
            requestId: randomUUID(),
            operation: 'status',
          })}\n`,
        ),
      );
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(JSON.parse(response)).toMatchObject({ operation: 'error', code: 'unsupported' });
    expect(controlCalls).toBe(1);
    expect(runtimeCalls).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
