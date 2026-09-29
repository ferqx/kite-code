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
    id: 'desktop-native-unsubscribe-1',
    method: 'runtime/unsubscribe',
    params: { subscriptionId: 'subscription-1' },
  });
});

test('request-id cancellation is translated and its late subscribe ack cannot restore a stream', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  await connection.send(
    1,
    JSON.stringify({ jsonrpc: '2.0', id: 'child', method: 'runtime/subscribe', params: {} }),
  );
  const wireRequestId = JSON.parse(service.sent.at(-1)!).id;
  await connection.send(
    1,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'cancel-child',
      method: 'runtime/unsubscribe',
      params: { subscribeRequestId: 'child' },
    }),
  );
  expect(JSON.parse(service.sent.at(-1)!)).toEqual({
    jsonrpc: '2.0',
    id: JSON.stringify([1, 'cancel-child']),
    method: 'runtime/unsubscribe',
    params: { subscribeRequestId: wireRequestId },
  });

  service.feed({
    jsonrpc: '2.0',
    id: wireRequestId,
    result: { subscriptionId: 'late-child' },
  });
  service.feed({
    jsonrpc: '2.0',
    id: JSON.stringify([1, 'cancel-child']),
    result: { unsubscribed: true },
  });
  expect(JSON.parse(await connection.receive(1))).toMatchObject({
    id: 'child',
    result: { subscriptionId: 'late-child' },
  });
  expect(JSON.parse(await connection.receive(1))).toMatchObject({
    id: 'cancel-child',
    result: { unsubscribed: true },
  });
  expect(service.sent.map((frame) => JSON.parse(frame))).toContainEqual({
    jsonrpc: '2.0',
    id: 'desktop-native-unsubscribe-1',
    method: 'runtime/unsubscribe',
    params: { subscriptionId: 'late-child' },
  });
  service.feed({
    jsonrpc: '2.0',
    method: 'runtime/subscription',
    params: { subscriptionId: 'late-child', message: {} },
  });
  await connection.send(
    1,
    JSON.stringify({ jsonrpc: '2.0', id: 'next-query', method: 'runtime/query', params: {} }),
  );
  service.feed({
    jsonrpc: '2.0',
    id: JSON.stringify([1, 'next-query']),
    result: { status: 'ok' },
  });
  expect(JSON.parse(await connection.receive(1))).toMatchObject({ id: 'next-query' });
  await connection.attach(2);
  expect(
    service.sent.filter((frame) => JSON.parse(frame).method === 'runtime/unsubscribe'),
  ).toHaveLength(2);
});

test('history cancellation accepts only a valid notification and targets the host-scoped request', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  await connection.send(
    1,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'history-1',
      method: 'history/load_session',
      params: { sessionId: 'session-1' },
    }),
  );
  const wireId = JSON.parse(service.sent.at(-1)!).id;
  await connection.send(
    1,
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'history/cancel',
      params: { requestId: 'history-1' },
    }),
  );
  expect(JSON.parse(service.sent.at(-1)!)).toEqual({
    jsonrpc: '2.0',
    method: 'history/cancel',
    params: { requestId: wireId },
  });
  const sent = service.sent.length;
  await expect(
    connection.send(
      1,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'history/cancel',
        params: { requestId: 'history-1', extra: true },
      }),
    ),
  ).rejects.toThrow('无效的协议消息');
  await expect(
    connection.send(
      1,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'runtime/query',
        params: {},
      }),
    ),
  ).rejects.toThrow('协议请求缺少身份');
  await connection.attach(2);
  await expect(
    connection.send(
      1,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'history/cancel',
        params: { requestId: 'history-1' },
      }),
    ),
  ).rejects.toThrow('页面连接已被替换');
  expect(service.sent).toHaveLength(sent);
});

test('renderer reattach cancels pending subscribe by its host-scoped request id', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  await connection.send(
    1,
    JSON.stringify({ jsonrpc: '2.0', id: 'same', method: 'runtime/subscribe', params: {} }),
  );
  const oldWireId = JSON.parse(service.sent.at(-1)!).id;
  await connection.attach(2);
  expect(JSON.parse(service.sent.at(-1)!)).toEqual({
    jsonrpc: '2.0',
    id: 'desktop-native-unsubscribe-1',
    method: 'runtime/unsubscribe',
    params: { subscribeRequestId: oldWireId },
  });
  await connection.send(
    2,
    JSON.stringify({ jsonrpc: '2.0', id: 'same', method: 'runtime/subscribe', params: {} }),
  );
  const newWireId = JSON.parse(service.sent.at(-1)!).id;
  expect(newWireId).not.toBe(oldWireId);
  service.feed({ jsonrpc: '2.0', id: oldWireId, result: { subscriptionId: 'stale' } });
  service.feed({ jsonrpc: '2.0', id: newWireId, result: { subscriptionId: 'live' } });
  expect(JSON.parse(await connection.receive(2))).toMatchObject({
    id: 'same',
    result: { subscriptionId: 'live' },
  });
  expect(service.sent.map((frame) => JSON.parse(frame))).toContainEqual({
    jsonrpc: '2.0',
    id: 'desktop-native-unsubscribe-2',
    method: 'runtime/unsubscribe',
    params: { subscriptionId: 'stale' },
  });
  await connection.attach(3);
  expect(service.sent.map((frame) => JSON.parse(frame))).toContainEqual({
    jsonrpc: '2.0',
    id: 'desktop-native-unsubscribe-3',
    method: 'runtime/unsubscribe',
    params: { subscriptionId: 'live' },
  });
});

test('request-id cancellation detaches an already acknowledged subscription', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  await connection.send(
    1,
    JSON.stringify({ jsonrpc: '2.0', id: 'child', method: 'runtime/subscribe', params: {} }),
  );
  const wireRequestId = JSON.parse(service.sent.at(-1)!).id;
  service.feed({ jsonrpc: '2.0', id: wireRequestId, result: { subscriptionId: 'child-stream' } });
  expect(JSON.parse(await connection.receive(1))).toMatchObject({ id: 'child' });
  await connection.send(
    1,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'cancel-child',
      method: 'runtime/unsubscribe',
      params: { subscribeRequestId: 'child' },
    }),
  );
  await connection.attach(2);
  expect(service.sent.map((frame) => JSON.parse(frame))).toContainEqual({
    jsonrpc: '2.0',
    id: JSON.stringify([1, 'cancel-child']),
    method: 'runtime/unsubscribe',
    params: { subscribeRequestId: wireRequestId },
  });
  expect(
    service.sent.filter((frame) => JSON.parse(frame).id === 'desktop-native-unsubscribe-1'),
  ).toHaveLength(0);
});

test('successful cancellation retires a pending subscribe even without its reply', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  for (let index = 0; index < 100; index++) {
    await connection.send(
      1,
      JSON.stringify({
        jsonrpc: '2.0',
        id: `child-${index}`,
        method: 'runtime/subscribe',
        params: {},
      }),
    );
    await connection.send(
      1,
      JSON.stringify({
        jsonrpc: '2.0',
        id: `cancel-${index}`,
        method: 'runtime/unsubscribe',
        params: { subscribeRequestId: `child-${index}` },
      }),
    );
    service.feed({
      jsonrpc: '2.0',
      id: JSON.stringify([1, `cancel-${index}`]),
      result: { unsubscribed: true },
    });
    expect(JSON.parse(await connection.receive(1))).toMatchObject({
      id: `cancel-${index}`,
      result: { unsubscribed: true },
    });
  }
  await connection.attach(2);
  expect(service.sent).toHaveLength(200);
});

test('reattach preserves initialize received while the old receiver is being cancelled', async () => {
  const service = new FakeService();
  const connection = new RendererConnection(service, 'server-v1');
  await connection.attach(1);
  await connection.send(
    1,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'old-init',
      method: 'initialize',
      params: { protocolVersion: 2 },
    }),
  );
  const abandoned = connection.receive(1).catch((error) => error);
  await Bun.sleep(0);
  const attaching = connection.attach(2);
  await Promise.resolve();
  service.feed({
    jsonrpc: '2.0',
    id: 'desktop-native-initialize',
    result: { protocolVersion: 2, serverInfo: { version: 'server-v1', instanceId: 'same' } },
  });
  await attaching;
  await abandoned;
  await connection.send(
    2,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'new-init',
      method: 'initialize',
      params: { protocolVersion: 2 },
    }),
  );
  const receiving = connection.receive(2).catch((error) => error);
  const result = await Promise.race([receiving, Bun.sleep(100).then(() => 'timeout')]);
  await connection.attach(0);
  await receiving;
  expect(result).not.toBe('timeout');
  expect(JSON.parse(result)).toMatchObject({
    id: 'new-init',
    result: { serverInfo: { instanceId: 'same' } },
  });
  expect(service.sent).toHaveLength(1);
});
