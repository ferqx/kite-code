import { expect, test } from 'bun:test';
import {
  RendererConnection,
  type ServiceProcessCarrier,
} from '../electron/runtime/renderer-connection';

interface FakeReader {
  resolve: (frame: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

class FakeService implements ServiceProcessCarrier {
  readonly sent: string[] = [];
  finished = false;
  #frames: string[] = [];
  #reader?: FakeReader;

  async send(frame: string): Promise<void> {
    this.sent.push(frame);
  }

  receive(signal?: AbortSignal): Promise<string> {
    if (this.#reader) return Promise.reject(new Error('同一连接只能有一个消息消费者。'));
    const frame = this.#frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      const reader: FakeReader = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        reader.abort = () => {
          if (this.#reader === reader) this.#reader = undefined;
          reject(new Error('页面连接已被替换。'));
        };
        signal.addEventListener('abort', reader.abort, { once: true });
      }
      this.#reader = reader;
    });
  }

  async waitForReceiver(): Promise<void> {
    while (this.#reader) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async close(): Promise<void> {
    this.finished = true;
  }

  feed(value: unknown): void {
    const frame = JSON.stringify(value);
    const reader = this.#reader;
    if (!reader) {
      this.#frames.push(frame);
      return;
    }
    this.#reader = undefined;
    if (reader.signal && reader.abort) reader.signal.removeEventListener('abort', reader.abort);
    reader.resolve(frame);
  }
}

test('renderer reload reuses initialize and fences reused request ids', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  await connection.send(
    1,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'abandoned',
      method: 'initialize',
      params: { protocolVersion: 2 },
    }),
  );
  expect(JSON.parse(service.sent[0]!).id).toBe('desktop-native-initialize');

  await connection.attach(2);
  await connection.send(
    2,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'renderer-init',
      method: 'initialize',
      params: { protocolVersion: 2 },
    }),
  );
  expect(service.sent).toHaveLength(1);
  service.feed({
    jsonrpc: '2.0',
    id: 'desktop-native-initialize',
    result: { protocolVersion: 2, serverInfo: { version: 'server-v1', instanceId: 'same' } },
  });
  expect(JSON.parse(await connection.receive(2))).toMatchObject({ id: 'renderer-init' });

  await connection.send(
    2,
    JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'runtime/query', params: {} }),
  );
  const oldWireId = JSON.parse(service.sent.at(-1)!).id;
  await connection.attach(3);
  await connection.send(
    3,
    JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'runtime/query', params: {} }),
  );
  const currentWireId = JSON.parse(service.sent.at(-1)!).id;
  expect(oldWireId).not.toBe(currentWireId);
  service.feed({ jsonrpc: '2.0', id: oldWireId, result: { stale: true } });
  service.feed({ jsonrpc: '2.0', id: currentWireId, result: { current: true } });
  expect(JSON.parse(await connection.receive(3))).toEqual({
    jsonrpc: '2.0',
    id: 'same-id',
    result: { current: true },
  });

  const sentBeforeCachedInitialize = service.sent.length;
  await connection.send(
    3,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'cached',
      method: 'initialize',
      params: { protocolVersion: 2 },
    }),
  );
  expect(service.sent).toHaveLength(sentBeforeCachedInitialize);
  expect(JSON.parse(await connection.receive(3))).toMatchObject({ id: 'cached' });
});

test('renderer reload cancels old receive and unsubscribes the old page', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  await connection.send(
    1,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'runtime/subscribe', params: {} }),
  );
  const subscriptionWireId = JSON.parse(service.sent.at(-1)!).id;
  service.feed({
    jsonrpc: '2.0',
    id: subscriptionWireId,
    result: { subscriptionId: 'subscription-1' },
  });
  expect(JSON.parse(await connection.receive(1)).id).toBe(1);

  const abandoned = connection.receive(1).then(
    () => undefined,
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await connection.attach(2);
  const abandonedResult = await abandoned;
  expect(abandonedResult).toBeInstanceOf(Error);
  expect((abandonedResult as Error).message).toBe('页面连接已被替换。');
  expect(service.sent.map((frame) => JSON.parse(frame))).toContainEqual({
    jsonrpc: '2.0',
    id: 'desktop-native-unsubscribe',
    method: 'runtime/unsubscribe',
    params: { subscriptionId: 'subscription-1' },
  });
});
