import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  AgentClient,
  BackgroundExecutionItem,
  Command,
  Execution,
  Message,
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
    sourceRequests: boolean[] = [],
    current = { generation: 1, storeId: 'store', subjectId: 'user' },
    selected = { rootSessionId: 'root', viewSelection: 1 };
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
    listAllBackgroundExecutions: async (options: {
      rootSessionId?: string;
      includeSourceTool?: boolean;
    }) => {
      sourceRequests.push(options.includeSourceTool === true);
      calls.push('GET directory');
      return structuredClone(
        items.filter(
          (item) => !options.rootSessionId || item.rootSession.id === options.rootSessionId,
        ),
      );
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
    getRun: async (id: string) => {
      calls.push(`GET run ${id}`);
      const run = items.flatMap((item) => [item.run, item.childRun]).find((run) => run?.id === id);
      if (!run) throw Error('fixture_run_missing');
      return structuredClone(run);
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
  const environment = new NativeBackground(port, () => ({ ...current, ...selected }), {
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
      const owner = 'surface' in request && request.surface === 'environment' ? environment : main;
      switch (request.method) {
        case 'background.open':
          return owner.open(request.readId);
        case 'background.next':
          return owner.next(request.readId);
        case 'background.close':
          owner.close(request.readId);
          return null;
        case 'background.output.open':
          return owner.outputOpen(request);
        case 'background.output.next':
          return owner.outputNext(request.readId);
        case 'background.output.close':
          owner.outputClose(request.readId);
          return null;
        case 'background.child.open':
          return owner.childOpen(request);
        case 'background.child.read':
          return owner.childRead(request);
        case 'background.child.close':
          owner.childClose(request.readId);
          return null;
        case 'background.stop':
          return owner.stop(request.observationId, request.executionId, request.commandId);
        default:
          throw Error('unexpected_operation');
      }
    },
  };
  return { main, environment, bridge, port, calls, current, selected, sourceRequests };
}

test('selected environment exhausts the original root independently of the open global overview, and old selection loses control', async () => {
  const items = Array.from({ length: 206 }, (_, i) => backgroundItem(i + 1)),
    foreign = backgroundItem(207);
  foreign.rootSession = { ...foreign.rootSession, id: 'other', rootSessionId: 'other' };
  foreign.session = { ...foreign.session, id: 'other', rootSessionId: 'other' };
  foreign.execution = { ...foreign.execution, sessionId: 'other', rootSessionId: 'other' };
  const f = fixture([...items, foreign]);
  try {
    const global = await f.main.open('global');
    const read = () =>
      readNativeBackground({
        bridge: f.bridge,
        generation: 1,
        storeId: 'store',
        signal: new AbortController().signal,
        isCurrent: () => true,
        environment: { rootSessionId: 'root', viewSelection: 1 },
      });
    const selected = await read();
    expect(f.sourceRequests).toEqual([false, true]);
    expect(selected.items.map((item) => item.execution.id)).toEqual(
      items.map((item) => item.execution.id),
    );
    expect(f.main.next('global').observationId).toBe(global.observationId);
    await f.environment.stop(selected.observationId, items[205]!.execution.id, 'exact-stop');
    expect(f.calls.filter((call) => call.startsWith('POST'))).toEqual(['POST exact-stop']);
    f.selected.viewSelection = 2;
    await expect(
      f.environment.stop(selected.observationId, items[0]!.execution.id, 'late-stop'),
    ).rejects.toMatchObject({ code: 'background_observation_changed' });
    await expect(read()).rejects.toMatchObject({ code: 'background_page_invalid' });
    expect(f.calls.filter((call) => call.startsWith('POST'))).toEqual(['POST exact-stop']);
    expect(() =>
      decodeNativeRequest({
        method: 'background.open',
        generation: 1,
        readId: 'wrong',
        surface: 'other',
      }),
    ).toThrow('invalid_native_request');
  } finally {
    f.environment.release();
    f.main.release();
  }
});
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

test('live child tail reuses only stable verified rows and resets on context replacement', async () => {
  const item = backgroundItem(1, true),
    f = fixture([item]);
  const rows = [
    {
      id: 'stable',
      sessionId: 'child',
      runId: 'completed-child-run',
      seq: '1',
      status: 'complete' as const,
      role: 'user' as const,
      content: 'stable',
    },
    {
      id: 'active',
      sessionId: 'child',
      runId: 'original-child-run',
      seq: '2',
      status: 'incomplete' as const,
      role: 'assistant' as const,
      content: 'first',
    },
  ];
  let context = 'context';
  const after: string[] = [];
  f.port.getRun = async (id) => {
    expect(id).toBe('completed-child-run');
    return { ...item.childRun!, id, status: 'completed', isActive: false, finishedAt: 2 };
  };
  f.port.getView = async () =>
    ({
      storeId: 'store',
      session: { ...item.childSession!, contextSelectionId: context, nextSeq: '2' },
      runs: [{ ...item.childRun!, carrierExecutionId: item.execution.id }],
      executions: [],
    }) as never;
  f.port.listMessages = async (_id, options) => {
    after.push(options!.afterSeq!);
    return structuredClone(rows.filter((row) => BigInt(row.seq) > BigInt(options!.afterSeq!)));
  };
  const read = async (previous?: Awaited<ReturnType<typeof readNativeBackgroundChild>>) => {
    const page = await f.environment.open(crypto.randomUUID());
    f.environment.close(page.readId);
    return readNativeBackgroundChild({
      bridge: f.bridge,
      generation: 1,
      storeId: 'store',
      observationId: page.observationId,
      item,
      signal: new AbortController().signal,
      isCurrent: () => true,
      environment: { rootSessionId: 'root', viewSelection: 1 },
      incremental: !!previous,
      previous,
    });
  };
  try {
    const initial = await read();
    rows[1]!.content = 'second prefix';
    const updated = await read(initial);
    expect(after).toEqual(['0', '1']);
    expect(updated.messages.map((row) => row.content)).toEqual(['stable', 'second prefix']);
    context = 'new-context';
    rows[0]!.content = 'replaced stable';
    const replaced = await read(updated);
    expect(after).toEqual(['0', '1', '0']);
    expect(replaced.messages[0]!.content).toBe('replaced stable');
  } finally {
    f.environment.release();
  }
});

test('selected live child accepts a newer verified active Model prefix without declaring the message complete', async () => {
  const item = backgroundItem(1, true),
    f = fixture([item]);
  const content = 'updated 中文🙂 prefix';
  const output = { complete: false, content, reasoning: '', toolCalls: [] };
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
    status: 'running',
    snapshotCursor: '1',
    bodyHash: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    bodyBytes: String(Buffer.byteLength(JSON.stringify(output))),
    contentBytes: String(Buffer.byteLength(content)),
    reasoningBytes: '0',
    output,
  };
  f.port.getView = async () =>
    ({
      storeId: 'store',
      session: { ...item.childSession!, nextSeq: '1' },
      runs: [{ ...item.childRun!, carrierExecutionId: item.execution.id }],
      executions: [],
    }) as never;
  f.port.listMessages = async () => [
    {
      id: 'active',
      sessionId: 'child',
      runId: 'original-child-run',
      seq: '1',
      status: 'incomplete',
      role: 'assistant',
      content: 'old',
      outputBody: {
        kind: 'model_output',
        executionId: 'child-model',
        complete: false,
        contentBytes: '3',
        reasoningBytes: '0',
        toolCallCount: 0,
      },
    },
  ];
  f.port.getModelOutput = async () => snapshot;
  try {
    const directory = await f.environment.open('live-directory');
    f.environment.close(directory.readId);
    const body = await readNativeBackgroundChild({
      bridge: f.bridge,
      generation: 1,
      storeId: 'store',
      observationId: directory.observationId,
      item,
      signal: new AbortController().signal,
      isCurrent: () => true,
      environment: { rootSessionId: 'root', viewSelection: 1 },
    });
    expect(body.messages[0]!.content).toBe(content);
    expect(body.messages[0]!.status).toBe('incomplete');
    expect(body.messages[0]!.outputBody!.contentBytes).toBe(snapshot.contentBytes);
    expect(body.modelOutputs[0]!.snapshot.output.complete).toBe(false);
    const fixed = await f.main.open('fixed-directory');
    f.main.close(fixed.readId);
    await expect(
      readNativeBackgroundChild({
        bridge: f.bridge,
        generation: 1,
        storeId: 'store',
        observationId: fixed.observationId,
        item,
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ).rejects.toMatchObject({ code: 'background_child_history_mismatch' });
  } finally {
    f.environment.release();
    f.main.release();
  }
});

test('incremental child IPC cursor is environment-only, exact and bounded', () => {
  const request = {
    method: 'background.child.open' as const,
    generation: 1,
    observationId: 1,
    executionId: 'job-1',
    readId: 'read',
    surface: 'environment' as const,
    cursor: { afterSeq: '1', contextSelectionId: 'context' },
  };
  expect(decodeNativeRequest(request)).toEqual(request);
  expect(() => decodeNativeRequest({ ...request, surface: undefined })).toThrow(
    'invalid_native_request',
  );
  for (const cursor of [
    { afterSeq: '-1', contextSelectionId: 'context' },
    { afterSeq: '9223372036854775808', contextSelectionId: 'context' },
    { afterSeq: '1', contextSelectionId: '' },
    { afterSeq: '1', contextSelectionId: 'context', extra: true },
  ])
    expect(() => decodeNativeRequest({ ...request, cursor })).toThrow('invalid_native_request');
  expect(() => decodeNativeRequest({ ...request, method: 'background.output.open' })).toThrow(
    'invalid_native_request',
  );
});

function pendingChildDirectoryFixture() {
  const item = backgroundItem(1, true),
    f = fixture([item]);
  const rows = [
    {
      id: 'child-original',
      sessionId: 'child',
      runId: 'original-child-run',
      seq: '1',
      role: 'user' as const,
      status: 'complete' as const,
      content: 'original bounded assignment',
    },
    {
      id: 'child-active',
      sessionId: 'child',
      runId: 'original-child-run',
      seq: '2',
      role: 'assistant' as const,
      status: 'incomplete' as const,
      content: 'current verified child prefix 雪🙂',
    },
  ];
  f.port.getView = async (sessionId) => {
    f.calls.push(`GET child-view ${sessionId}`);
    return {
      storeId: 'store',
      session: { ...item.childSession!, nextSeq: '2' },
      runs: [{ ...item.childRun!, carrierExecutionId: item.execution.id }],
      executions: [],
    } as never;
  };
  f.port.listMessages = async (sessionId, options) => {
    f.calls.push(`GET child-messages ${sessionId}/${options!.afterSeq}/${options!.upperSeq}`);
    return structuredClone(rows.filter((row) => BigInt(row.seq) > BigInt(options!.afterSeq!)));
  };
  let release!: () => void,
    reject!: (cause: Error) => void,
    entered = false;
  const gate = new Promise<BackgroundExecutionItem[]>((resolve, fail) => {
    release = () => resolve(structuredClone([item]));
    reject = fail;
  });
  return {
    ...f,
    item,
    rows,
    release: () => release(),
    reject: () => reject(Error('owned_directory_failed')),
    async start() {
      const original = await f.environment.open('original-directory');
      expect(original.complete).toBe(true);
      f.environment.close(original.readId);
      f.port.listAllBackgroundExecutions = async () => {
        entered = true;
        return gate;
      };
      const pending = f.environment.open('pending-directory').catch((cause: unknown) => cause);
      await Bun.sleep(0);
      expect(entered).toBe(true);
      return { original, pending };
    },
    async oldChild(observationId: number) {
      return readNativeBackgroundChild({
        bridge: f.bridge,
        generation: 1,
        storeId: 'store',
        observationId,
        item,
        signal: new AbortController().signal,
        isCurrent: () => true,
        environment: { rootSessionId: 'root', viewSelection: 1 },
      });
    },
  };
}

test('pending same-scope directory permits only fresh exact child readonly from its prior complete observation', async () => {
  const f = pendingChildDirectoryFixture();
  const { original, pending } = await f.start();
  try {
    await expect(
      f.environment.stop(original.observationId, f.item.execution.id, 'stale-stop'),
    ).rejects.toMatchObject({ code: 'background_observation_changed' });
    await expect(
      f.environment.outputOpen({
        observationId: original.observationId,
        executionId: f.item.execution.id,
        readId: 'stale-output',
      }),
    ).rejects.toMatchObject({ code: 'background_observation_changed' });
    const child = await f.oldChild(original.observationId);
    expect(child.messages).toEqual(f.rows);
    expect(child.upperSeq).toBe('2');
    expect(child.item.execution.id).toBe(f.item.execution.id);
    expect(child.item.childRun!.id).toBe('original-child-run');
    expect(f.calls).toContain(`GET exact ${f.item.execution.id}`);
    expect(f.calls).toContain('GET execution parent-tool');
    expect(f.calls).toContain('GET child-view child');
    expect(f.calls).toContain('GET child-messages child/0/2');
    expect(f.calls.every((call) => call.startsWith('GET'))).toBe(true);
  } finally {
    f.release();
    await pending;
    f.environment.release();
    f.main.release();
  }
});

for (const boundary of ['failed', 'closed', 'new-scope'] as const) {
  test(`prior child readonly candidate is revoked when pending directory is ${boundary}`, async () => {
    const f = pendingChildDirectoryFixture();
    const { original, pending } = await f.start();
    try {
      if (boundary === 'failed') f.reject();
      else {
        if (boundary === 'closed') f.environment.close('pending-directory');
        if (boundary === 'new-scope') f.selected.viewSelection++;
        f.release();
      }
      const result = await pending;
      if (boundary === 'failed') expect(result).toBeInstanceOf(Error);
      await expect(f.oldChild(original.observationId)).rejects.toMatchObject({
        code: 'background_observation_changed',
      });
      await expect(
        f.environment.stop(original.observationId, f.item.execution.id, 'stale-stop'),
      ).rejects.toMatchObject({ code: 'background_observation_changed' });
      expect(f.calls.some((call) => call.startsWith('PREPARE') || call.startsWith('POST'))).toBe(
        false,
      );
    } finally {
      f.release();
      await pending;
      f.environment.release();
      f.main.release();
    }
  });
}

for (const handoff of ['published', 'closed'] as const) {
  test(`exact child readonly survives completed directory ${handoff} before renderer commits its new observation`, async () => {
    const f = pendingChildDirectoryFixture();
    const { original, pending } = await f.start();
    try {
      f.release();
      const replacement = (await pending) as Awaited<ReturnType<typeof f.environment.open>>;
      expect(replacement.complete).toBe(true);
      expect(replacement.observationId).not.toBe(original.observationId);
      if (handoff === 'closed') f.environment.close(replacement.readId);
      const before = f.calls.filter((call) => call === `GET exact ${f.item.execution.id}`).length;
      const child = await f.oldChild(original.observationId);
      expect(child.messages).toEqual(f.rows);
      expect(child.upperSeq).toBe('2');
      expect(child.item.execution.id).toBe(f.item.execution.id);
      expect(child.item.childRun!.id).toBe('original-child-run');
      expect(f.calls.filter((call) => call === `GET exact ${f.item.execution.id}`)).toHaveLength(
        before + 2,
      );
      await expect(
        f.environment.stop(original.observationId, f.item.execution.id, 'handoff-stop'),
      ).rejects.toMatchObject({ code: 'background_observation_changed' });
      await expect(
        f.environment.outputOpen({
          observationId: original.observationId,
          executionId: f.item.execution.id,
          readId: 'handoff-output',
        }),
      ).rejects.toMatchObject({ code: 'background_observation_changed' });
      expect(f.calls.every((call) => call.startsWith('GET'))).toBe(true);
      f.environment.close(replacement.readId);
      const next = await f.environment.open('next-directory');
      f.environment.close(next.readId);
      await expect(f.oldChild(original.observationId)).rejects.toMatchObject({
        code: 'background_observation_changed',
      });
      expect((await f.oldChild(replacement.observationId)).messages).toEqual(f.rows);
      f.environment.release();
      await expect(f.oldChild(replacement.observationId)).rejects.toMatchObject({
        code: 'background_observation_changed',
      });
    } finally {
      f.release();
      await pending;
      f.environment.release();
      f.main.release();
    }
  });
}

for (const boundary of ['identity', 'scope'] as const) {
  test(`completed previous child observation cannot bypass fresh ${boundary}`, async () => {
    const f = pendingChildDirectoryFixture();
    const { original, pending } = await f.start();
    try {
      f.release();
      const replacement = (await pending) as Awaited<ReturnType<typeof f.environment.open>>;
      f.environment.close(replacement.readId);
      if (boundary === 'scope') f.selected.viewSelection++;
      else
        f.port.listBackgroundExecutions = async () =>
          ({
            items: [
              { ...f.item, execution: { ...f.item.execution, childSessionId: 'different-child' } },
            ],
          }) as never;
      await expect(f.oldChild(original.observationId)).rejects.toMatchObject({
        code:
          boundary === 'identity'
            ? 'background_identity_mismatch'
            : 'background_observation_changed',
      });
      expect(f.calls.some((call) => call.startsWith('GET child-messages'))).toBe(false);
      expect(f.calls.some((call) => call.startsWith('PREPARE') || call.startsWith('POST'))).toBe(
        false,
      );
    } finally {
      f.release();
      await pending;
      f.environment.release();
      f.main.release();
    }
  });
}

for (const corruption of ['none', 'foreign run', 'foreign tool'] as const) {
  test(`environment child presentation reuses exact historical Run and tool facts with ${corruption}`, async () => {
    const item = backgroundItem(1, true),
      f = fixture([item]);
    const oldRun = {
      ...item.childRun!,
      id: 'old-child-run',
      status: 'completed' as const,
      isActive: false,
      finishedAt: 2,
    };
    const currentRun = { ...item.childRun!, carrierExecutionId: item.execution.id };
    const askContent = JSON.stringify({ answer: 'Use blue', answers: { q1: 'blue' } });
    const rows: Message[] = [
      {
        id: 'old-request',
        seq: '1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'list-call', name: 'files.list', arguments: '{}' }],
      },
      {
        id: 'old-result',
        seq: '2',
        role: 'tool',
        content: 'listed original directory',
        toolCallId: 'list-call',
        sourceIds: ['list-execution'],
      },
      {
        id: 'question-request',
        seq: '3',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'ask-call',
            name: 'ask_user',
            arguments: JSON.stringify({ questions: [{ question: 'Which color?' }] }),
          },
        ],
      },
      {
        id: 'question-result',
        seq: '4',
        role: 'tool',
        content: askContent,
        toolCallId: 'ask-call',
        sourceIds: ['ask-execution'],
      },
    ].map((row, index) => ({
      ...row,
      sessionId: 'child',
      runId: index < 2 ? oldRun.id : currentRun.id,
      status: 'complete',
    })) as Message[];
    const tool = (id: string, runId: string, definitionId: string, content: string): Execution =>
      ({
        ...item.execution,
        id,
        sessionId: 'child',
        runId,
        kind: 'tool',
        definitionId,
        definitionVersion: '1',
        status: 'succeeded',
        resultRevision: '7',
        result: { outcome: 'succeeded', content },
      }) as Execution;
    const listExecution = tool('list-execution', oldRun.id, 'files.list', rows[1]!.content),
      askExecution = tool('ask-execution', currentRun.id, 'ask_user', askContent);
    f.port.getView = async () =>
      ({
        storeId: 'store',
        session: { ...item.childSession!, nextSeq: '4' },
        runs: [currentRun],
        executions: [askExecution],
      }) as never;
    f.port.listMessages = async (_id, options) =>
      structuredClone(rows.filter((row) => BigInt(row.seq) > BigInt(options!.afterSeq!)));
    const getExecution = f.port.getExecution;
    f.port.getExecution = async (id, options) => {
      const execution =
        id === listExecution.id ? listExecution : id === askExecution.id ? askExecution : undefined;
      if (!execution) return getExecution(id, options);
      f.calls.push(`GET execution ${id}`);
      return structuredClone(
        corruption === 'foreign tool' && id === listExecution.id
          ? { ...execution, sessionId: 'another-child' }
          : execution,
      );
    };
    const getRun = f.port.getRun;
    f.port.getRun = async (id, options) => {
      if (id !== oldRun.id) return getRun(id, options);
      f.calls.push(`GET run ${id}`);
      return structuredClone(
        corruption === 'foreign run' ? { ...oldRun, sessionId: 'another-child' } : oldRun,
      );
    };
    try {
      const page = await f.environment.open('presentation-directory');
      f.environment.close(page.readId);
      const reading = readNativeBackgroundChild({
        bridge: f.bridge,
        generation: 1,
        storeId: 'store',
        observationId: page.observationId,
        item,
        signal: new AbortController().signal,
        isCurrent: () => true,
        environment: { rootSessionId: 'root', viewSelection: 1 },
      });
      if (corruption !== 'none') {
        await expect(reading).rejects.toMatchObject({
          code:
            corruption === 'foreign run'
              ? 'background_child_history_mismatch'
              : 'tool_message_identity_mismatch',
        });
      } else {
        const body = await reading;
        expect(body.session.id).toBe('child');
        expect(body.session.rootSessionId).toBe('root');
        expect(body.item.execution.id).toBe(item.execution.id);
        expect(body.presentation!.runs.map((run) => run.id).sort()).toEqual(
          [oldRun.id, currentRun.id].sort(),
        );
        expect(body.presentation!.runs.find((run) => run.id === oldRun.id)!.status).toBe(
          'completed',
        );
        expect(body.presentation!.runs.find((run) => run.id === currentRun.id)!.status).toBe(
          'running',
        );
        expect(body.presentation!.tools).toMatchObject([
          {
            messageId: 'old-result',
            executionId: listExecution.id,
            definitionId: 'files.list',
            definitionVersion: '1',
            status: 'succeeded',
            resultRevision: '7',
            target: '.',
          },
          {
            messageId: 'question-result',
            executionId: askExecution.id,
            definitionId: 'ask_user',
            ask: {
              questions: [{ id: 'q1', question: 'Which color?' }],
              summary: 'Use blue',
              answers: { q1: 'blue' },
            },
          },
        ]);
        expect(body.presentation!.executions).toHaveLength(1);
        expect(body.presentation!.executions[0]!.id).toBe(askExecution.id);
        expect(body.presentation!.executions[0]).not.toHaveProperty('result');
        expect(body.presentation!.executions[0]).not.toHaveProperty('childSessionId');
        const refreshedDirectory = await f.environment.open('presentation-refresh');
        f.environment.close(refreshedDirectory.readId);
        const refreshed = await readNativeBackgroundChild({
          bridge: f.bridge,
          generation: 1,
          storeId: 'store',
          observationId: refreshedDirectory.observationId,
          item,
          signal: new AbortController().signal,
          isCurrent: () => true,
          environment: { rootSessionId: 'root', viewSelection: 1 },
          incremental: true,
          previous: body,
        });
        expect(refreshed.messages).toEqual(body.messages);
        expect(refreshed.presentation!.tools).toEqual(body.presentation!.tools);
        expect(refreshed.presentation!.runs.map((run) => run.id).sort()).toEqual(
          [oldRun.id, currentRun.id].sort(),
        );
      }
      expect(f.calls.filter((call) => call === `GET run ${oldRun.id}`)).toHaveLength(1);
      expect(f.calls.every((call) => call.startsWith('GET'))).toBe(true);
    } finally {
      f.environment.release();
      f.main.release();
    }
  });
}

for (const scenario of [
  'run unavailable',
  'tool unavailable',
  'active Run retires',
  'incomplete Tool',
] as const) {
  test(`child presentation preserves readable history and recalibrates ${scenario}`, async () => {
    const item = backgroundItem(1, true),
      f = fixture([item]);
    let first = true;
    const run = {
      ...item.childRun!,
      status: scenario === 'active Run retires' ? 'running' : 'completed',
      isActive: scenario === 'active Run retires',
      finishedAt: scenario === 'active Run retires' ? null : 2,
    };
    const rows: Message[] = [
      { id: 'user', role: 'user', content: 'Read the original child file' },
      {
        id: 'request',
        role: 'assistant',
        content: 'Original request',
        toolCalls: [
          { id: 'read-call', name: 'files.read', arguments: '{"path":"original-child.txt"}' },
        ],
      },
      {
        id: 'receipt',
        role: 'tool',
        content: 'Original file result',
        sourceIds: ['read-execution'],
        toolCallId: 'read-call',
      },
    ].map((row, index) => ({
      ...row,
      sessionId: 'child',
      runId: run.id,
      seq: String(index + 1),
      status: scenario === 'incomplete Tool' && index === 2 ? 'incomplete' : 'complete',
    })) as Message[];
    const execution = {
      ...item.execution,
      id: 'read-execution',
      sessionId: 'child',
      runId: run.id,
      kind: 'tool',
      definitionId: 'files.read',
      definitionVersion: '3',
      status: 'succeeded',
      resultRevision: '1',
      result: { outcome: 'succeeded', content: rows[2]!.content },
    } as Execution;
    f.port.getView = async () =>
      ({
        storeId: 'store',
        session: { ...item.childSession!, nextSeq: '3' },
        runs: scenario === 'active Run retires' && first ? [structuredClone(run)] : [],
        executions: [],
      }) as never;
    const cursors: string[] = [];
    f.port.listMessages = async (_id, options) => {
      cursors.push(options!.afterSeq!);
      return structuredClone(rows.filter((row) => BigInt(row.seq) > BigInt(options!.afterSeq!)));
    };
    f.port.getRun = async (id) => {
      f.calls.push(`GET run ${id}`);
      if (first && scenario === 'run unavailable') throw Error('temporary_run_read_failure');
      expect(id).toBe(run.id);
      return structuredClone(run) as never;
    };
    const getExecution = f.port.getExecution;
    f.port.getExecution = async (id, options) => {
      if (id !== execution.id) return getExecution(id, options);
      f.calls.push(`GET execution ${id}`);
      if (first && scenario === 'tool unavailable') throw Error('temporary_execution_read_failure');
      return structuredClone(execution);
    };
    const read = async (previous?: Awaited<ReturnType<typeof readNativeBackgroundChild>>) => {
      const directory = await f.environment.open(crypto.randomUUID());
      f.environment.close(directory.readId);
      return readNativeBackgroundChild({
        bridge: f.bridge,
        generation: 1,
        storeId: 'store',
        observationId: directory.observationId,
        item,
        signal: new AbortController().signal,
        isCurrent: () => true,
        environment: { rootSessionId: 'root', viewSelection: 1 },
        incremental: !!previous,
        previous,
      });
    };
    try {
      const initial = await read();
      expect(initial.messages.map((message) => message.content)).toEqual(
        rows.map((message) => message.content),
      );
      if (scenario.endsWith('unavailable')) {
        expect(initial.presentation!.unavailable).toBe(true);
        expect(initial.presentation!.tools).toEqual([]);
      } else if (scenario === 'active Run retires') {
        expect(initial.presentation!.runs[0]).toMatchObject({
          id: run.id,
          isActive: true,
          status: 'running',
        });
      } else {
        expect(initial.messages[2]!.status).toBe('incomplete');
        expect(initial.presentation!.tools).toEqual([]);
      }
      first = false;
      run.status = 'completed';
      run.isActive = false;
      run.finishedAt = 2;
      rows[2]!.status = 'complete';
      const recovered = await read(initial);
      expect(recovered.messages).toEqual(rows);
      expect(recovered.presentation!.unavailable).toBeUndefined();
      expect(recovered.presentation!.runs).toMatchObject([
        { id: run.id, status: 'completed', isActive: false },
      ]);
      expect(recovered.presentation!.tools).toMatchObject([
        {
          messageId: 'receipt',
          executionId: execution.id,
          status: 'succeeded',
          target: 'original-child.txt',
        },
      ]);
      // Failed metadata forces a full read. Active Runs and unresolved requests remain in the tail.
      expect(cursors).toEqual(['0', scenario === 'incomplete Tool' ? '1' : '0']);
      expect(f.calls.filter((call) => call === `GET run ${run.id}`).length).toBeGreaterThan(0);
      expect(f.calls.every((call) => call.startsWith('GET'))).toBe(true);
    } finally {
      f.environment.release();
      f.main.release();
    }
  });
}
