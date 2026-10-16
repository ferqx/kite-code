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

test('Native attach generation and history epoch changes discard same-session and inactive snapshots', async () => {
  for (const change of ['generation', 'epoch'] as const) {
    let blocked = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = {
      async request(request) {
        if (request.method === 'messages.close') return null;
        if (request.method !== 'messages') throw Error('unexpected');
        if (blocked) await gate;
        return {
          messages: [{ id: request.sessionId, sessionId: request.sessionId, seq: '1' }],
          highWaterSeq: '1',
          nextAfterSeq: null,
        };
      },
    } as NativeBridge;
    const reader = new NativeHistory(bridge, () => {});
    reader.select(1, selection('inactive', '1'));
    await until(() => reader.state.phase === 'complete');
    reader.preview('active');
    reader.select(1, selection('active', '1'));
    await until(() => reader.state.phase === 'complete');
    blocked = true;
    reader.select(
      change === 'generation' ? 2 : 1,
      selection('active', '1'),
      change === 'epoch' ? 1 : 0,
    );
    expect(reader.state.messages).toEqual([]);
    reader.preview('inactive');
    expect(reader.state.messages).toEqual([]);
    reader.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reader.state.messages).toEqual([]);
  }
});

test('Native confirmed Store removal clears published and inactive history and rejects a pending old page', async () => {
  let blocked = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closed: string[] = [];
  const bridge = {
    async request(request) {
      if (request.method === 'messages.close') {
        closed.push(request.readId);
        return null;
      }
      if (request.method !== 'messages') throw Error('unexpected');
      if (blocked) await gate;
      return {
        messages: [{ id: request.sessionId, sessionId: request.sessionId, seq: '1' }],
        highWaterSeq: '1',
        nextAfterSeq: null,
      };
    },
  } as NativeBridge;
  let publications = 0;
  const reader = new NativeHistory(bridge, () => publications++);
  reader.select(1, selection('inactive', '1'));
  await until(() => reader.state.phase === 'complete');
  reader.preview('active');
  reader.select(1, selection('active', '1'));
  await until(() => reader.state.phase === 'complete');
  reader.evictStore('foreign');
  expect(reader.state.messages[0]?.id).toBe('active');
  blocked = true;
  reader.select(1, { ...selection('active', '1'), viewGeneration: 2 });
  reader.evictStore('store');
  expect(reader.state.messages).toEqual([]);
  reader.preview('inactive');
  expect(reader.state.messages).toEqual([]);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reader.state.messages).toEqual([]);
  expect(closed.length).toBeGreaterThan(0);
  reader.clear();
  reader.dispose();
  const afterDispose = publications;
  reader.select(1, selection('active', '1'));
  reader.preview('inactive');
  expect(reader.state.messages).toEqual([]);
  expect(publications).toBe(afterDispose);
});

test('Native close pauses only history and same-revision selection resumes full calibration', async () => {
  let reads = 0;
  let block = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = {
    async request(request) {
      if (request.method === 'messages.close') return null;
      if (request.method !== 'messages') throw Error('unexpected');
      const read = ++reads;
      if (block) await gate;
      return {
        messages: [{ id: 'm', sessionId: 's', seq: '1', content: `read-${read}` }],
        highWaterSeq: '1',
        nextAfterSeq: null,
      };
    },
  } as NativeBridge;
  const reader = new NativeHistory(bridge, () => {});
  const current = selection('s', '1');
  reader.select(1, current);
  await until(() => reader.state.phase === 'complete');
  reader.select(1, current);
  expect(reads).toBe(1);
  reader.close();
  expect(reader.state.messages[0]?.content).toBe('read-1');
  block = true;
  reader.select(1, current);
  expect(reads).toBe(2);
  expect(reader.state.messages[0]?.content).toBe('read-1');
  reader.close();
  block = false;
  reader.select(1, current);
  await until(() => reader.state.phase === 'complete');
  expect(reads).toBe(3);
  expect(reader.state.messages[0]?.content).toBe('read-3');
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reader.state.messages[0]?.content).toBe('read-3');
  reader.dispose();
});

test('Native same-high-water full calibration replaces vanished records only at EOF, while failure preserves prior reading beyond its prefix', async () => {
  for (const failed of [false, true]) {
    const original = { id: 'first', sessionId: 's', seq: '1', content: 'old body' } as Message;
    const removed = {
      id: 'removed',
      sessionId: 's',
      seq: '2',
      content: 'previous tail',
    } as Message;
    const updated = { ...original, content: 'rewritten body at the same seq' };
    let recalibrating = false;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = {
      async request(request) {
        if (request.method === 'messages.close') return null;
        if (request.method !== 'messages') throw Error('unexpected');
        if (!recalibrating)
          return { messages: [original, removed], highWaterSeq: '2', nextAfterSeq: null };
        if (request.afterSeq === '0')
          return { messages: [updated], highWaterSeq: '2', nextAfterSeq: '1' };
        entered = true;
        await gate;
        if (failed) throw Error('last_page_failed');
        return { messages: [], highWaterSeq: '2', nextAfterSeq: null };
      },
    } as NativeBridge;
    const reader = new NativeHistory(bridge, () => {});
    reader.select(1, selection('s', '2'));
    await until(() => reader.state.phase === 'complete');
    recalibrating = true;
    reader.select(1, { ...selection('s', '2'), viewGeneration: 2 });
    await until(() => entered);
    expect(reader.state.messages).toEqual([original, removed]);
    release();
    await until(() => reader.state.phase === (failed ? 'unavailable' : 'complete'));
    expect(reader.state.messages).toEqual(failed ? [updated, removed] : [updated]);
    reader.dispose();
  }
});

test('Native context selection changes recalibrate the complete session timeline rather than filtering it to the new Model context', async () => {
  const original = {
    id: 'first',
    sessionId: 's',
    seq: '1',
    content: 'old context turn',
  } as Message;
  let reads = 0;
  const bridge = {
    async request(request) {
      if (request.method === 'messages.close') return null;
      if (request.method !== 'messages') throw Error('unexpected');
      reads++;
      return { messages: [original], highWaterSeq: '1', nextAfterSeq: null };
    },
  } as NativeBridge;
  const reader = new NativeHistory(bridge, () => {});
  const initial = selection('s', '1');
  reader.select(1, { ...initial, session: { ...initial.session, contextSelectionId: 'before' } });
  await until(() => reader.state.phase === 'complete');
  reader.select(1, {
    ...initial,
    viewGeneration: 2,
    session: { ...initial.session, contextSelectionId: 'after-rewind' },
  });
  expect(reader.state.messages).toEqual([original]);
  await until(() => reader.state.phase === 'complete');
  expect(reader.state.messages).toEqual([original]);
  expect(reads).toBe(2);
  reader.dispose();
});
