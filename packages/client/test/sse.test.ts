import { expect, test } from 'bun:test';
import {
  parseCursorSequence,
  readSSE,
  SSEParseError,
  SSEParser,
  validateCursorBounds,
} from '../src/sse';

const encoder = new TextEncoder();

test('arbitrary byte splits preserve UTF-8, BOM, mixed newlines and multiline data', () => {
  const parser = new SSEParser();
  const bytes = encoder.encode(
    '\uFEFF: heartbeat\r\nid: store:9007199254740993\r\nevent: change\rdata: 你好\ndata: second\r\n\r\n',
  );
  const events = [...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte)));
  expect(events).toEqual([
    {
      event: 'change',
      data: '你好\nsecond',
      id: 'store:9007199254740993',
      lastEventId: 'store:9007199254740993',
    },
  ]);
  expect(parser.finish()).toEqual([]);
});

test('ready does not acquire an inherited explicit id or an applied business cursor', () => {
  const parser = new SSEParser();
  const events = parser.push(
    encoder.encode('id: 1\ndata: first\n\nevent: ready\ndata: ready\n\n: heartbeat\n\n'),
  );
  expect(events).toHaveLength(2);
  expect(events[1]).toEqual({ event: 'ready', data: 'ready', lastEventId: '1' });
  expect(events[1]).not.toHaveProperty('id');
});

test('null id is ignored; empty id resets transport state; retry accepts only safe decimal integers', () => {
  const retry: number[] = [];
  const parser = new SSEParser({ onRetry: (milliseconds) => retry.push(milliseconds) });
  const events = parser.push(
    encoder.encode(
      'id: stable\n\nid: invalid\0id\ndata\n\nid:\nretry: 1200\nretry: -3\nretry: 1.5\nretry: 9007199254740993\ndata: reset\n\n',
    ),
  );
  expect(events[0]).toEqual({ event: 'message', data: '', lastEventId: 'stable' });
  expect(events[1]).toEqual({ event: 'message', data: 'reset', id: '', lastEventId: '' });
  expect(retry).toEqual([1200]);
});

test('EOF does not publish an unterminated event', () => {
  const parser = new SSEParser();
  expect(parser.push(encoder.encode('data: complete\n\ndata: unfinished\n'))).toHaveLength(1);
  expect(parser.finish()).toEqual([]);
});

test('local parser byte limit rejects oversized events and resets between complete events', () => {
  const parser = new SSEParser({ maxEventBytes: 9 });
  expect(parser.push(encoder.encode('data: 好\n\ndata: 好\n\n'))).toHaveLength(2);
  expect(() => parser.push(encoder.encode('data: 好好'))).toThrow(SSEParseError);
});

test('stream abort releases the observation reader and rejects with its original reason', async () => {
  const controller = new AbortController();
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
    },
  });
  const iterator = readSSE(body, { signal: controller.signal });
  const pending = iterator.next();
  const reason = new Error('dispose observation');
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancellations).toBe(1);
  expect(body.locked).toBe(false);
});

test('early return releases reader; complete stream parses chunked events', async () => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: one\n\ndata: two\n\n'));
    },
    cancel() {
      cancellations++;
    },
  });
  for await (const event of readSSE(body)) {
    expect(event.data).toBe('one');
    break;
  }
  expect(cancellations).toBe(1);
  expect(body.locked).toBe(false);
});

test('cursor bounds preserve signed 64-bit values and reject future, expired and malformed cursors', () => {
  expect(parseCursorSequence('9007199254740993')).toBe(9007199254740993n);
  expect(parseCursorSequence('9223372036854775807')).toBe(9223372036854775807n);
  expect(validateCursorBounds({ sequence: '0', replayFloor: '0', lastChangeCursor: '0' })).toBe(
    'valid',
  );
  expect(
    validateCursorBounds({ sequence: '1000000', replayFloor: '0', lastChangeCursor: '100' }),
  ).toBe('ahead');
  expect(validateCursorBounds({ sequence: '1', replayFloor: '2', lastChangeCursor: '100' })).toBe(
    'expired',
  );
  expect(
    validateCursorBounds({
      sequence: '9007199254740993',
      replayFloor: '0',
      lastChangeCursor: '9007199254740994',
    }),
  ).toBe('valid');
  for (const value of ['-1', '01', '1.0', ' 1', '9223372036854775808', ''])
    expect(() => parseCursorSequence(value)).toThrow(RangeError);
});

test('real loopback fetch streams UTF-8 SSE without buffering the entire response', async () => {
  let sawHeader = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      sawHeader = request.headers.get('authorization') === 'Bearer fixture-only';
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: ready\ndata: ready\n\n'));
            controller.enqueue(encoder.encode('id: store:9007199254740993\ndata: 真实网络\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/events`, {
      headers: { authorization: 'Bearer fixture-only' },
    });
    const events = [];
    for await (const event of readSSE(response.body!)) events.push(event);
    expect(sawHeader).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).not.toHaveProperty('id');
    expect(events[1]?.data).toBe('真实网络');
    expect(events[1]?.id).toBe('store:9007199254740993');
  } finally {
    await server.stop(true);
  }
});
