import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import type { NativeBridge, NativeSelection } from '../src/native-bridge';
import { type HistoryState, NativeHistory } from '../src/native-history';

const selection = (id = 's', upper = '5001') =>
  ({
    storeId: 'store',
    session: { id, nextSeq: upper },
    viewSelection: 1,
    viewGeneration: 1,
  }) as unknown as NativeSelection;
function until(predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(Error('history_fixture_timeout'));
      else setTimeout(poll, 1);
    };
    poll();
  });
}
test('Native automatically reads >4096 observed records and >8MiB multi-message history at one fixed high water without dropping the first page', async () => {
  const records = Array.from({ length: 5001 }, (_, i) => ({
    id: `m-${i + 1}`,
    sessionId: 's',
    seq: String(i + 1),
    content: `${'complete history paragraph '.repeat(90)}TAIL-${i + 1}`,
  })) as unknown as Message[];
  const uppers: string[] = [];
  let value!: HistoryState;
  const bridge = {
    async request(request) {
      if (request.method === 'messages.close') return null;
      if (request.method !== 'messages') throw Error('unexpected');
      uppers.push(request.upperSeq!);
      const page = records
        .filter((item) => BigInt(item.seq) > BigInt(request.afterSeq!))
        .slice(0, 200);
      return {
        messages: page,
        highWaterSeq: request.upperSeq!,
        nextAfterSeq: page.length === 200 ? page.at(-1)!.seq : null,
      };
    },
  } as NativeBridge;
  const reader = new NativeHistory(bridge, (state) => {
    value = state;
  });
  reader.select(1, selection());
  await until(() => value.phase === 'complete');
  expect(value.messages).toHaveLength(5001);
  expect(value.messages[0]?.id).toBe('m-1');
  expect(value.messages.at(-1)?.id).toBe('m-5001');
  expect(Buffer.byteLength(JSON.stringify(value.messages))).toBeGreaterThan(8 * 1048576);
  expect(new Set(uppers)).toEqual(new Set(['5001']));
  reader.close();
});
test('Native recalibration keeps the completed reading snapshot until its fixed high water completes or fails', async () => {
  for (const failed of [false, true]) {
    const original = { id: 'first', sessionId: 's', seq: '1', content: 'original text' } as Message;
    const updated = { ...original, content: 'updated text' };
    const last = { id: 'last', sessionId: 's', seq: '2', content: 'new text' } as Message;
    let recalibrating = false,
      entered = false,
      release!: () => void,
      value!: HistoryState;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = {
      async request(request) {
        if (request.method === 'messages.close') return null;
        if (request.method !== 'messages') throw Error('unexpected');
        if (!recalibrating) return { messages: [original], highWaterSeq: '1', nextAfterSeq: null };
        if (request.afterSeq === '0')
          return { messages: [updated], highWaterSeq: '2', nextAfterSeq: '1' };
        entered = true;
        await gate;
        if (failed) throw Error('owned_last_page_failed');
        return { messages: [last], highWaterSeq: '2', nextAfterSeq: null };
      },
    } as NativeBridge;
    const reader = new NativeHistory(bridge, (state) => {
      value = state;
    });
    reader.select(1, selection('s', '1'));
    await until(() => value.phase === 'complete');
    expect(value.messages).toEqual([original]);
    recalibrating = true;
    reader.select(1, { ...selection('s', '2'), viewGeneration: 2 });
    await until(() => entered);
    expect(value.phase).toBe('loading');
    expect(value.messages).toEqual([original]);
    release();
    await until(() => value.phase === (failed ? 'unavailable' : 'complete'));
    expect(value.messages).toEqual(failed ? [updated] : [updated, last]);
    expect(value.error).toBe(failed ? 'owned_last_page_failed' : undefined);
    reader.close();
  }
});
test('Native failed scan preserves read pages; switching aborts only its GET and rejects late old pages', async () => {
  let fail = true,
    release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let value!: HistoryState;
  const closed: string[] = [];
  const bridge = {
    async request(request) {
      if (request.method === 'messages.close') {
        closed.push(request.readId);
        return null;
      }
      if (request.method !== 'messages') throw Error('unexpected');
      if (request.sessionId === 'other')
        return { messages: [], highWaterSeq: '0', nextAfterSeq: null };
      if (request.afterSeq === '0')
        return {
          messages: [{ id: 'first', sessionId: 's', seq: '1' } as Message],
          highWaterSeq: '2',
          nextAfterSeq: '1',
        };
      if (fail) throw Error('owned_page_failed');
      entered = true;
      await gate;
      return {
        messages: [{ id: 'late', sessionId: 's', seq: '2' } as Message],
        highWaterSeq: '2',
        nextAfterSeq: null,
      };
    },
  } as NativeBridge;
  const reader = new NativeHistory(bridge, (state) => {
    value = state;
  });
  reader.select(1, selection('s', '2'));
  await until(() => value.phase === 'unavailable');
  expect(value.messages.map((m) => m.id)).toEqual(['first']);
  fail = false;
  reader.select(1, selection('s', '2'));
  await until(() => entered);
  reader.preview('other');
  reader.select(1, selection('other', '0'));
  await until(() => value.phase === 'complete');
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(value.messages).toEqual([]);
  expect(closed.length).toBeGreaterThanOrEqual(2);
  reader.preview('s');
  expect(value.messages.map((m) => m.id)).toEqual(['first']);
  reader.close();
});
test('Native switching away from an unfinished recalibration restores only the last published reading snapshot', async () => {
  const original = { id: 'first', sessionId: 's', seq: '1', content: 'original text' } as Message;
  const updated = { ...original, content: 'unpublished updated text' };
  let recalibrating = false,
    entered = false,
    release!: () => void,
    value!: HistoryState;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = {
    async request(request) {
      if (request.method === 'messages.close') return null;
      if (request.method !== 'messages') throw Error('unexpected');
      if (request.sessionId === 'other')
        return { messages: [], highWaterSeq: '0', nextAfterSeq: null };
      if (!recalibrating) return { messages: [original], highWaterSeq: '1', nextAfterSeq: null };
      if (request.afterSeq === '0')
        return { messages: [updated], highWaterSeq: '2', nextAfterSeq: '1' };
      entered = true;
      await gate;
      return { messages: [], highWaterSeq: '2', nextAfterSeq: null };
    },
  } as NativeBridge;
  const reader = new NativeHistory(bridge, (state) => {
    value = state;
  });
  reader.select(1, selection('s', '1'));
  await until(() => value.phase === 'complete');
  recalibrating = true;
  reader.select(1, { ...selection('s', '2'), viewGeneration: 2 });
  await until(() => entered);
  reader.preview('other');
  reader.select(1, selection('other', '0'));
  await until(() => value.phase === 'complete');
  reader.preview('s');
  expect(value.messages).toEqual([original]);
  reader.select(1, { ...selection('s', '2'), viewGeneration: 3 });
  expect(value.messages).toEqual([original]);
  reader.close();
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(value.messages).toEqual([original]);
});
