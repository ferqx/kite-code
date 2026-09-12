import { expect, test } from 'bun:test';
import type { DesktopRuntimeBridge } from '../src/transport';
import { desktopTransport } from '../src/transport';

const info = { connectionId: 7, workspace: '/project', expectedServerVersion: 'test' };
const message = {
  jsonrpc: '2.0' as const,
  id: 'init',
  method: 'initialize' as const,
  params: {
    protocolVersion: 2 as const,
    clientInfo: { name: 'test', version: '1', instanceId: 'test' },
  },
};

test('send failure detaches the renderer without stopping tasks or retrying an unknown mutation', async () => {
  const calls: string[] = [];
  const bridge: DesktopRuntimeBridge = {
    async runtimeSend() {
      calls.push('runtime_send');
      throw new Error('pipe broke');
    },
    async runtimeReceive() {
      throw new Error('not used');
    },
    async runtimeDetach() {
      calls.push('runtime_detach');
    },
  };
  const connection = await desktopTransport(info, bridge).connect();
  await expect(connection.send(message)).rejects.toThrow();
  await connection.close();
  expect(calls).toEqual(['runtime_send', 'runtime_detach']);
});

test('late receive from a closed connection cannot reach the client', async () => {
  let resolve!: (frame: string) => void;
  const pending = new Promise<string>((done) => {
    resolve = done;
  });
  const bridge: DesktopRuntimeBridge = {
    async runtimeSend() {},
    async runtimeReceive() {
      return pending;
    },
    async runtimeDetach() {},
  };
  const connection = await desktopTransport(info, bridge).connect();
  const iterator = connection.messages()[Symbol.asyncIterator]();
  const received = iterator.next();
  await connection.close();
  resolve(JSON.stringify(message));
  expect(await received).toEqual({ done: true, value: undefined });
});
