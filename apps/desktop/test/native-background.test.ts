import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  AgentClient,
  BackgroundExecutionItem,
  Command,
  ModelOutputSnapshot,
} from '@kite-ai/client';
import { NativeBackground } from '../electron/background';
import { NativeCallerJournal } from '../electron/caller-journal';
import { decodeNativeRequest } from '../electron/native-ipc';
import { readNativeBackground, readNativeBackgroundChild } from '../src/native-background';
import type { NativeBridge } from '../src/native-bridge';
import { readNativeJobOutput } from '../src/native-job-output';
import { backgroundItem } from './background-item.fixture';
import { memoryPrivateData } from './private-data.fixture';

function fixture(items: BackgroundExecutionItem[]) {
  const calls: string[] = [],
    current = { generation: 1, storeId: 'store', subjectId: 'user' };
  const port = {
    serverInfo: {
      storeId: 'store',
      subjectId: 'user',
      capabilities: ['sessions', 'model_outputs'],
    },
    verifyConnection: async () => {
      calls.push('GET server');
      return port.serverInfo;
    },
    listAllBackgroundExecutions: async () => {
      calls.push('GET directory');
      return structuredClone(items);
    },
    listBackgroundExecutions: async (input: { executionId: string }) => {
      calls.push(`GET exact ${input.executionId}`);
      return {
        items: structuredClone(items.filter((item) => item.execution.id === input.executionId)),
      };
    },
    getExecution: async (id: string) => {
      calls.push(`GET execution ${id}`);
      return id === 'parent-tool'
        ? {
            id,
            kind: 'tool',
            sessionId: 'root',
            originStoreId: 'store',
            rootWorkCommandId: 'start',
            rootWorkSeq: '1',
            parentExecutionId: null,
            childSessionId: null,
          }
        : items.find((item) => item.execution.id === id)!.execution;
    },
    listExecutionOutput: async (
      id: string,
      options: { afterSeq: string; upperSeq?: string; limit: number },
    ) => {
      calls.push(`GET output ${id}`);
      const first = Number(options.afterSeq),
        upper = Number(options.upperSeq ?? '301'),
        end = Math.min(upper, first + options.limit);
      return {
        highWaterSeq: options.upperSeq ? '305' : '301',
        items: Array.from({ length: end - first }, (_, i) => ({
          executionId: id,
          seq: String(first + i + 1),
          throughSeq: String(first + i + 1),
          stream: i % 2 ? 'stdout' : 'stderr',
          content: `${'原文中🙂'.repeat(300)}-${first + i + 1}`,
          droppedBytes: '0',
        })),
      };
    },
  } as unknown as AgentClient;
  const main = new NativeBackground(port, () => current, {
    prepare: async (item, commandId) => {
      calls.push(`PREPARE ${item.execution.id}/${commandId}`);
    },
    submit: async (commandId) => {
      calls.push(`POST ${commandId}`);
      return { id: commandId, status: 'applied' } as Command;
    },
  });
  const bridge: NativeBridge = {
    watch: () => () => undefined,
    request: async (request) => {
      decodeNativeRequest(request);
      switch (request.method) {
        case 'background.open':
          return main.open(request.readId);
        case 'background.next':
          return main.next(request.readId);
        case 'background.close':
          main.close(request.readId);
          return null;
        case 'background.output.open':
          return main.outputOpen(request);
        case 'background.output.next':
          return main.outputNext(request.readId);
        case 'background.output.close':
          main.outputClose(request.readId);
          return null;
        case 'background.child.open':
          return main.childOpen(request);
        case 'background.child.read':
          return main.childRead(request);
        case 'background.child.close':
          main.childClose(request.readId);
          return null;
        default:
          throw Error('unexpected_operation');
      }
    },
  };
  return { main, bridge, port, calls, current };
}
test('complete Main/renderer background directory and pinned original output survive a new overview observation without truncation or mutations', async () => {
  const items = Array.from({ length: 241 }, (_, i) => backgroundItem(i + 1)),
    f = fixture(items);
  try {
    const facts = await readNativeBackground({
      bridge: f.bridge,
      generation: 1,
      storeId: 'store',
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    expect(facts.items.map((item) => item.execution.id)).toEqual(
      items.map((item) => item.execution.id),
    );
    let changed = false;
    const bridge: NativeBridge = {
      ...f.bridge,
      request: async (request) => {
        const value = await f.bridge.request(request);
        if (request.method === 'background.output.open' && !changed) {
          changed = true;
          await readNativeBackground({
            bridge: f.bridge,
            generation: 1,
            storeId: 'store',
            signal: new AbortController().signal,
            isCurrent: () => true,
          });
        }
        return value;
      },
    };
    const output = await readNativeJobOutput({
      bridge,
      scope: {
        generation: 1,
        viewSelection: facts.observationId,
        historyEpoch: 0,
        storeId: 'store',
        originStoreId: 'store',
        sessionId: 'root',
        workspaceId: 'w',
        executionId: 'job-1',
      },
      background: true,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    expect(output.items).toHaveLength(301);
    expect(output.highWaterSeq).toBe('301');
    expect(output.items.at(-1)!.content.endsWith('-301')).toBe(true);
    expect(f.calls.some((call) => call.startsWith('POST') || call.startsWith('PREPARE'))).toBe(
      false,
    );
    await expect(f.main.stop(facts.observationId, 'job-1', 'old-stop')).rejects.toMatchObject({
      code: 'background_observation_changed',
    });
  } finally {
    f.main.release();
  }
});
test('fresh original identity and current lifecycle are required for stop, and only the explicit original target enters cancellation', async () => {
  const items = [backgroundItem(), backgroundItem(2)],
    f = fixture(items);
  try {
    let page = await f.main.open('first');
    f.main.close('first');
    items[0]!.execution.ownerGeneration = '2';
    await expect(f.main.stop(page.observationId, 'job-1', 'stale')).rejects.toMatchObject({
      code: 'background_stop_unavailable',
    });
    expect(f.calls.some((call) => call.startsWith('POST') || call.startsWith('PREPARE'))).toBe(
      false,
    );
    page = await f.main.open('second');
    f.main.close('second');
    await f.main.stop(page.observationId, 'job-1', 'exact-stop');
    expect(f.calls.filter((call) => call.startsWith('PREPARE') || call.startsWith('POST'))).toEqual(
      ['PREPARE job-1/exact-stop', 'POST exact-stop'],
    );
    expect(items[1]!.execution.status).toBe('running');
    items[0]!.execution.childSessionId = 'foreign';
    await expect(
      f.main.outputOpen({
        observationId: page.observationId,
        executionId: 'job-1',
        readId: 'foreign',
      }),
    ).rejects.toMatchObject({ code: 'background_identity_mismatch' });
  } finally {
    f.main.release();
  }
});
test('restored Native history pins original output provenance and refuses fresh stop even when old lifecycle says running', async () => {
  const item = backgroundItem();
  item.execution.originStoreId = 'original-store';
  item.run!.originStoreId = 'original-store';
  const f = fixture([item]);
  try {
    const facts = await readNativeBackground({
      bridge: f.bridge,
      generation: 1,
      storeId: 'store',
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    expect(facts.items[0]!.execution.originStoreId).toBe('original-store');
    const output = await readNativeJobOutput({
      bridge: f.bridge,
      scope: {
        generation: 1,
        viewSelection: facts.observationId,
        historyEpoch: 0,
        storeId: 'store',
        originStoreId: 'original-store',
        sessionId: 'root',
        workspaceId: 'w',
        executionId: item.execution.id,
      },
      background: true,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    expect(output.items).toHaveLength(301);
    expect(output.items.at(-1)!.content.endsWith('-301')).toBe(true);
    await expect(
      f.main.stop(facts.observationId, item.execution.id, 'restore-stop'),
    ).rejects.toMatchObject({ code: 'background_stop_unavailable' });
    expect(f.calls.every((call) => call.startsWith('GET'))).toBe(true);
  } finally {
    f.main.release();
  }
});
for (const originStoreId of ['store', 'original-store']) {
  test(`child read preserves ${originStoreId} carrier Run, exhausts messages and verifies complete Unicode Model output under current Store`, async () => {
    const item = backgroundItem(1, true),
      f = fixture([item]),
      text = `${'完整子消息中文🙂'.repeat(16000)}END`,
      output = { complete: true, content: text, reasoning: '', toolCalls: [] };
    item.execution.originStoreId = originStoreId;
    item.run!.originStoreId = originStoreId;
    item.childRun!.originStoreId = originStoreId;
    const getExecution = f.port.getExecution;
    f.port.getExecution = async (id, options) =>
      id === 'child-model'
        ? ({
            id,
            kind: 'model',
            sessionId: 'child',
            runId: 'original-child-run',
            originStoreId,
          } as never)
        : { ...(await getExecution(id, options)), originStoreId };
    const snapshot: ModelOutputSnapshot = {
      storeId: 'store',
      sessionId: 'child',
      rootSessionId: 'root',
      runId: 'original-child-run',
      executionId: 'child-model',
      originCommandId: 'child-start-job-1',
      rootWorkCommandId: 'start',
      rootWorkSeq: '1',
      attempt: 1,
      status: 'succeeded',
      bodyHash: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
      bodyBytes: String(Buffer.byteLength(JSON.stringify(output))),
      contentBytes: String(Buffer.byteLength(text)),
      reasoningBytes: '0',
      snapshotCursor: '1',
      output,
    };
    const messages = Array.from({ length: 205 }, (_, i) => ({
      id: `m-${i + 1}`,
      sessionId: 'child',
      runId: 'original-child-run',
      seq: String(i + 1),
      status: 'complete' as const,
      role: 'user' as const,
      content: `原消息-${i + 1}`,
    }));
    const modelMessage = {
      ...messages.at(-1)!,
      role: 'assistant' as const,
      content: 'preview',
      originMessage: {
        storeId: originStoreId,
        sessionId: 'child',
        messageId: 'source-message',
        runId: 'original-child-run',
      },
      outputBody: {
        kind: 'model_output' as const,
        executionId: snapshot.executionId,
        complete: true,
        contentBytes: snapshot.contentBytes,
        reasoningBytes: '0',
        toolCallCount: 0,
      },
    };
    const all = [...messages.slice(0, -1), modelMessage];
    f.port.getView = async () =>
      ({
        storeId: 'store',
        session: item.childSession,
        runs: [{ id: 'newer-child-run' }],
        executions: [],
      }) as never;
    const bounds: string[] = [];
    f.port.listMessages = async (_id, options) => {
      bounds.push(options!.upperSeq!);
      return all.filter((m) => BigInt(m.seq) > BigInt(options!.afterSeq!)).slice(0, options!.limit);
    };
    f.port.getModelOutput = async (_sessionId, _executionId, options) => {
      expect(options!.expectedStoreId).toBe('store');
      return snapshot;
    };
    try {
      const page = await f.main.open('directory');
      f.main.close('directory');
      let chunks = 0;
      const bridge: NativeBridge = {
        ...f.bridge,
        request: async (request) => {
          const result = await f.bridge.request(request);
          if (result && 'readId' in result && result.kind === 'background.child.chunk') {
            expect(Buffer.from(result.data, 'base64').length).toBeLessThanOrEqual(65536);
            chunks++;
          }
          return result;
        },
      };
      const body = await readNativeBackgroundChild({
        bridge,
        generation: 1,
        storeId: 'store',
        observationId: page.observationId,
        item,
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      expect(body.messages).toHaveLength(205);
      expect(body.modelOutputs[0]!.snapshot.output.content).toBe(text);
      expect(body.item.childRun!.id).toBe('original-child-run');
      expect(bounds).toEqual(['210', '210']);
      expect(chunks).toBeGreaterThan(5);
      expect(() => f.main.childRead({ readId: 'missing', offset: 0, limit: 1 })).toThrow(
        'background_read_missing',
      );
      expect(f.calls.every((call) => call.startsWith('GET'))).toBe(true);
    } finally {
      f.main.release();
    }
  });
}
test('closed Native observations reject authority injection and releasing a held original directory prevents late publication', async () => {
  expect(() =>
    decodeNativeRequest({
      method: 'background.output.open',
      generation: 1,
      observationId: 1,
      executionId: 'job',
      readId: 'read',
      sessionId: 'arbitrary',
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'background.child.read',
      generation: 1,
      readId: 'read',
      offset: 0,
      limit: 65537,
    }),
  ).toThrow('invalid_native_request');
  const f = fixture([backgroundItem()]);
  let resolve!: (value: BackgroundExecutionItem[]) => void;
  f.port.listAllBackgroundExecutions = async () =>
    new Promise((done) => {
      resolve = done;
    });
  const read = f.main.open('held').catch((cause) => cause);
  await Bun.sleep(0);
  f.main.release();
  resolve([backgroundItem()]);
  expect(await read).toMatchObject({ code: 'background_observation_changed' });
  await expect(f.main.stop(1, 'job-1', 'late')).rejects.toMatchObject({
    code: 'background_observation_changed',
  });
  expect(f.calls.some((call) => call.startsWith('POST'))).toBe(false);
});
test('an authenticated observed descendant Job uses the original actual Session journal; ordinary child prepare stays read-only and cold submit only looks up original', async () => {
  const item = backgroundItem(),
    data = memoryPrivateData();
  item.session = { ...item.session, id: 'child', parentSessionId: 'root' };
  item.execution.sessionId = 'child';
  let posts = 0,
    lookups = 0;
  const request = {
    kind: 'execution.cancel' as const,
    expectedStoreId: 'store',
    commandId: 'stop',
    executionId: item.execution.id,
  };
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'user' },
    getView: async (id: string) => ({
      storeId: 'store',
      session: id === 'root' ? item.rootSession : item.session,
    }),
    getExecution: async () => item.execution,
    getCommand: async (id: string) => {
      if (id === item.execution.originCommandId)
        return { id, sessionId: 'child', originStoreId: 'store', subjectId: 'user' };
      lookups++;
      throw Error('original_response_missing');
    },
    cancelExecution: async (sessionId: string, original: unknown) => {
      posts++;
      expect(sessionId).toBe('child');
      expect(original).toEqual(request);
      expect(data.callers()[0]!.intent.request).toEqual(request);
      throw Error('original_response_missing');
    },
  } as unknown as AgentClient;
  const warm = new NativeCallerJournal(client, data);
  await expect(warm.prepare('child', request)).rejects.toThrow('caller_scope_unavailable');
  await warm.prepareBackgroundStop(item, 'stop');
  await expect(warm.submit('stop')).rejects.toThrow('original_response_missing');
  expect(data.callers()[0]).toMatchObject({
    phase: 'unknown',
    intent: { scope: { sessionId: 'child', workspaceId: 'w', storeId: 'store' } },
  });
  const cold = new NativeCallerJournal(client, data);
  await expect(cold.submit('stop')).rejects.toThrow('original_response_missing');
  expect(posts).toBe(1);
  expect(lookups).toBe(1);
});
