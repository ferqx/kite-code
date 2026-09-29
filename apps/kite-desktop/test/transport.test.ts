import { expect, test } from 'bun:test';
import {
  RendererConnection,
  type ServiceProcessCarrier,
} from '../electron/runtime/renderer-connection';
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

test('history cancellation crosses the renderer bridge without detaching the connection', async () => {
  const sent: string[] = [];
  const service: ServiceProcessCarrier = {
    finished: false,
    async send(frame) {
      sent.push(frame);
    },
    async receive() {
      return new Promise<string>(() => undefined);
    },
    async waitForReceiver() {},
    async close() {},
  };
  const renderer = new RendererConnection(service, 'test');
  await renderer.attach(info.connectionId);
  let detaches = 0;
  const bridge: DesktopRuntimeBridge = {
    runtimeSend: (_id, frame) => renderer.send(info.connectionId, frame),
    runtimeReceive: (_id) => renderer.receive(info.connectionId),
    async runtimeDetach() {
      detaches++;
    },
  };
  const connection = await desktopTransport(info, bridge).connect();
  await connection.send({
    jsonrpc: '2.0',
    id: 'history-1',
    method: 'history/load_session',
    params: { sessionId: 'session-1' },
  });
  const wireId = JSON.parse(sent.at(-1)!).id;
  await connection.send({
    jsonrpc: '2.0',
    method: 'history/cancel',
    params: { requestId: 'history-1' },
  });
  expect(JSON.parse(sent.at(-1)!)).toEqual({
    jsonrpc: '2.0',
    method: 'history/cancel',
    params: { requestId: wireId },
  });
  await connection.send({
    jsonrpc: '2.0',
    id: 'history-2',
    method: 'history/load_session',
    params: { sessionId: 'session-2' },
  });
  expect(JSON.parse(sent.at(-1)!).params.sessionId).toBe('session-2');
  expect(detaches).toBe(0);
  await connection.close();
  expect(detaches).toBe(1);
});
