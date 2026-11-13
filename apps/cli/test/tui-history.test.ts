import { type AgentClient, ClientError, type Message, type SessionView } from '@kite-ai/client';
import { expect, test } from '#kite-test';
import { createTuiHistoryReader } from '../host/tui-history';

const message = (id: string, seq: string, content = id) =>
  ({
    id,
    seq,
    content,
    sessionId: 'session',
    runId: null,
    role: 'assistant',
    status: 'complete',
  }) as Message;
const view = (cursor: string) =>
  ({
    storeId: 'store',
    snapshotCursor: cursor,
    session: { id: 'session', nextSeq: '400' },
  }) as SessionView;
const signal = () => new AbortController().signal;

test('complete baseline then same-seq update and removal use changes without rescanning history', async () => {
  let scans = 0;
  const queries: unknown[] = [];
  const client = {
    serverInfo: { capabilities: ['message_changes'] },
    async listMessages() {
      scans++;
      return [message('a', '1'), message('b', '2')];
    },
    async listMessageChanges(_id: string, query: unknown) {
      queries.push(query);
      return {
        highWaterSeq: '400',
        nextCursor: '2',
        nextAfterSeq: null,
        messages: [message('a', '1', 'updated')],
        removedIds: ['b'],
      };
    },
  } as unknown as AgentClient;
  const reader = createTuiHistoryReader(client, 'store');
  expect(await reader.read(view('1'), signal())).toHaveLength(2);
  expect(await reader.read(view('2'), signal())).toEqual([message('a', '1', 'updated')]);
  expect(await reader.read(view('2'), signal())).toEqual([message('a', '1', 'updated')]);
  expect(scans).toBe(1);
  expect(queries).toHaveLength(1);
});

test('failed second page preserves baseline and cursor for retry', async () => {
  let fail = true;
  const cursors: string[] = [];
  const client = {
    serverInfo: { capabilities: ['message_changes'] },
    async listMessages() {
      return [message('a', '1')];
    },
    async listMessageChanges(_id: string, query: { afterSeq: string; afterCursor: string }) {
      cursors.push(query.afterCursor);
      if (query.afterSeq === '0')
        return {
          highWaterSeq: '400',
          nextCursor: '2',
          nextAfterSeq: '200',
          messages: [message('a', '1', 'new')],
          removedIds: [],
        };
      if (fail) throw Error('page_failed');
      return {
        highWaterSeq: '400',
        nextCursor: '2',
        nextAfterSeq: null,
        messages: [message('b', '201')],
        removedIds: [],
      };
    },
  } as unknown as AgentClient;
  const reader = createTuiHistoryReader(client, 'store');
  await reader.read(view('1'), signal());
  await expect(reader.read(view('2'), signal())).rejects.toThrow('page_failed');
  fail = false;
  expect(await reader.read(view('2'), signal())).toEqual([
    message('a', '1', 'new'),
    message('b', '201'),
  ]);
  expect(cursors).toEqual(['1', '1', '1', '1']);
});

test('expired cursor rebuilds full baseline; reset prevents late pages from supplying an epoch', async () => {
  let scans = 0;
  let release: (() => void) | undefined;
  const client = {
    serverInfo: { capabilities: ['message_changes'] },
    async listMessages() {
      scans++;
      return [message('a', '1')];
    },
    async listMessageChanges() {
      throw new ClientError('cursor_expired');
    },
  } as unknown as AgentClient;
  const reader = createTuiHistoryReader(client, 'store');
  await reader.read(view('1'), signal());
  await reader.read(view('2'), signal());
  expect(scans).toBe(2);
  client.listMessageChanges = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      highWaterSeq: '400',
      nextCursor: '3',
      nextAfterSeq: null,
      messages: [],
      removedIds: [],
    } as never;
  };
  const pending = reader.read(view('3'), signal());
  reader.reset();
  release!();
  await expect(pending).rejects.toThrow('history_identity_mismatch');
  await reader.read(view('3'), signal());
  expect(scans).toBe(3);
});

test('admitted service without changes retains full reread including same-seq edits', async () => {
  let scans = 0;
  const client = {
    serverInfo: { capabilities: [] },
    async listMessages() {
      return [message('a', '1', String(++scans))];
    },
  } as unknown as AgentClient;
  const reader = createTuiHistoryReader(client, 'store');
  expect((await reader.read(view('1'), signal()))[0]!.content).toBe('1');
  expect((await reader.read(view('2'), signal()))[0]!.content).toBe('2');
});

test('baseline reaches EOF beyond one page and a failed rebuild does not replace saved facts', async () => {
  let fail = false;
  let scans = 0;
  const client = {
    serverInfo: { capabilities: ['message_changes'] },
    async listMessages(_id: string, query: { afterSeq: string }) {
      scans++;
      if (query.afterSeq === '0')
        return Array.from({ length: 200 }, (_, i) => message(`m${i + 1}`, String(i + 1)));
      if (fail) throw Error('baseline_page_failed');
      return [message('last', '201')];
    },
    async listMessageChanges() {
      throw new ClientError('cursor_expired');
    },
  } as unknown as AgentClient;
  const reader = createTuiHistoryReader(client, 'store');
  expect(await reader.read(view('1'), signal())).toHaveLength(201);
  fail = true;
  await expect(reader.read(view('2'), signal())).rejects.toThrow('baseline_page_failed');
  expect(await reader.read(view('1'), signal())).toHaveLength(201);
  expect(scans).toBe(4);
});

test('registered event cursor reads deltas without a View and never regresses a newer complete baseline', async () => {
  let views = 0,
    scans = 0,
    changes = 0;
  const client = {
    serverInfo: { capabilities: ['message_changes'] },
    listMessages: async () => {
      scans++;
      return [message('a', '1')];
    },
    listMessageChanges: async () => {
      changes++;
      return {
        highWaterSeq: '400',
        nextCursor: '5',
        nextAfterSeq: null,
        messages: [message('a', '1', 'new')],
        removedIds: [],
      };
    },
  } as unknown as AgentClient;
  const reader = createTuiHistoryReader(client, 'store');
  await reader.read(view('1'), signal());
  const readView = async () => {
    views++;
    return view('5');
  };
  expect(await reader.readAtCursor('session', '5', readView, signal())).toEqual({
    cursor: '5',
    messages: [message('a', '1', 'new')],
  });
  expect(await reader.readAtCursor('session', '3', readView, signal())).toEqual({
    cursor: '5',
    messages: [message('a', '1', 'new')],
  });
  expect({ views, scans, changes }).toEqual({ views: 0, scans: 1, changes: 1 });
});

test('expired event cursor takes a new fixed View baseline; changed page watermarks never replace saved facts', async () => {
  let expire = true,
    views = 0;
  const client = {
    serverInfo: { capabilities: ['message_changes'] },
    listMessages: async () => [message('a', '1')],
    listMessageChanges: async (_id: string, query: { afterSeq: string }) => {
      if (expire) throw new ClientError('cursor_expired');
      return {
        highWaterSeq: query.afterSeq === '0' ? '400' : '401',
        nextCursor: '9',
        nextAfterSeq: query.afterSeq === '0' ? '200' : null,
        messages: [],
        removedIds: [],
      };
    },
  } as unknown as AgentClient;
  const reader = createTuiHistoryReader(client, 'store');
  await reader.read(view('1'), signal());
  const readView = async () => {
    views++;
    return view('7');
  };
  expect((await reader.readAtCursor('session', '5', readView, signal())).cursor).toBe('7');
  expect(views).toBe(1);
  expire = false;
  await expect(reader.readAtCursor('session', '9', readView, signal())).rejects.toThrow(
    'history_cursor_invalid',
  );
  expect((await reader.readAtCursor('session', '7', readView, signal())).messages).toEqual([
    message('a', '1'),
  ]);
  expect(views).toBe(1);
});
