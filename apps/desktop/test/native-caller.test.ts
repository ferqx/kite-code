import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentClient, Message, ModelOutputSnapshot } from '@kite-ai/client';
import { canonicalCallerCommandRequest } from '@kite-ai/client';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { callerTextDigest } from '../electron/caller-journal';
import { NativeCaller } from '../electron/native-caller';
import { assertNativeSender, decodeNativeRequest, registerNativeIpc } from '../electron/native-ipc';
import { inspectNativeQuitWork } from '../electron/quit-settlement';
import { type NativeState, nativeChannel } from '../src/native-bridge';
import { memoryPrivateData } from './private-data.fixture';

function client() {
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    serverInfo: { storeId: 'store', subjectId: 'local-user', capabilities: [] },
    connect: async () => ({}),
    async observe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async getView(id: string) {
      return {
        storeId: 'store',
        snapshotCursor: '0',
        session: {
          id,
          workspaceId: 'w',
          rootSessionId: id,
          parentSessionId: null,
          title: id,
          nextSeq: '0',
          contextSelectionId: 'selection',
          controlRevision: '0',
          deletedAt: null,
        },
        runs: [],
        executions: [],
        messages: [],
      };
    },
    listWorkspaces: async () => [],
    listAllWorkspaces: async () => [],
    listAllSessions: async () => [],
    listSessions: async () => [],
    disposeNetwork() {},
    startRun: async () => {
      writes++;
    },
  } as unknown as AgentClient & { writes: number };
}
function authority() {
  const frame = { url: 'file:///private/tmp/native/index.html' };
  const contents = { mainFrame: frame };
  return {
    window: { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow,
    event: { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    frame,
  };
}
test('formal Native reads an observed restored Fork through the original Model provenance and current Store, without rebinding or writes', async () => {
  const connection = client(),
    content = 'original 雪🙂\r\ncomplete tail',
    output = { content, reasoning: '', toolCalls: [], complete: true },
    body = JSON.stringify(output),
    message: Message = {
      id: 'sealed-message',
      sessionId: 'fork',
      runId: null,
      seq: '1',
      status: 'complete',
      role: 'assistant',
      content: 'preview',
      originMessage: {
        storeId: 'original-store',
        sessionId: 's',
        messageId: 'original-message',
        runId: 'r',
      },
      outputBody: {
        kind: 'model_output',
        executionId: 'e',
        complete: true,
        contentBytes: String(Buffer.byteLength(content)),
        reasoningBytes: '0',
        toolCallCount: 0,
      },
    },
    snapshot: ModelOutputSnapshot = {
      storeId: 'store',
      sessionId: 's',
      rootSessionId: 's',
      runId: 'r',
      executionId: 'e',
      originCommandId: 'cmd',
      rootWorkCommandId: 'cmd',
      rootWorkSeq: '1',
      attempt: 1,
      status: 'succeeded',
      bodyHash: createHash('sha256').update(body).digest('hex'),
      bodyBytes: String(Buffer.byteLength(body)),
      contentBytes: message.outputBody!.contentBytes,
      reasoningBytes: '0',
      snapshotCursor: '1',
      output,
    };
  Object.assign(connection.serverInfo!, { capabilities: ['model_outputs'] });
  const originalView = connection.getView.bind(connection);
  connection.getView = async (id) => {
    const view = await originalView(id);
    return { ...view, session: { ...view.session, nextSeq: '1' } };
  };
  connection.verifyConnection = async () => connection.serverInfo!;
  connection.listMessages = async () => [message];
  const reads: string[] = [],
    signals: AbortSignal[] = [];
  let originStoreId = 'original-store';
  connection.getExecution = async (id, options) => {
    reads.push(`execution:${id}`);
    signals.push(options!.signal!);
    return {
      id,
      originStoreId,
      sessionId: 's',
      runId: 'r',
      kind: 'model',
      definitionId: 'model',
      definitionVersion: '1',
      status: 'succeeded',
      result: null,
      resultRevision: '1',
      cancelRequestedAt: null,
    };
  };
  connection.getModelOutput = async (sessionId, executionId, options) => {
    reads.push(`output:${sessionId}:${executionId}:${options!.expectedStoreId}`);
    signals.push(options!.signal!);
    return snapshot;
  };
  const caller = new NativeCaller(connection, () => {}, memoryPrivateData()),
    request = {
      method: 'modelOutput.open' as const,
      generation: 1,
      readId: 'full',
      expectedStoreId: 'store',
      sessionId: 'fork',
      messageId: message.id,
      executionId: 'e',
    };
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'fork' });
    await expect(caller.invoke(request)).rejects.toMatchObject({
      code: 'model_output_message_unavailable',
    });
    expect(reads).toEqual([]);
    await caller.invoke({
      method: 'messages',
      generation: 1,
      sessionId: 'fork',
      expectedStoreId: 'store',
      readId: 'history',
      afterSeq: '0',
      upperSeq: '1',
      limit: 32,
    });
    expect(await caller.invoke(request)).toMatchObject({
      kind: 'modelOutput.opened',
      storeId: 'store',
      sessionId: 's',
      executionId: 'e',
      bodyHash: snapshot.bodyHash,
    });
    const chunk = await caller.invoke({
      method: 'modelOutput.read',
      generation: 1,
      readId: 'full',
      offset: 0,
      limit: 65536,
    });
    if (!chunk || !('data' in chunk) || !('eof' in chunk) || chunk.kind !== 'modelOutput.chunk')
      throw Error('missing_full_body');
    expect(chunk.eof).toBe(true);
    expect(JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'))).toEqual(snapshot);
    expect(reads).toEqual(['execution:e', 'output:s:e:store']);
    expect(signals[0]).toBe(signals[1]);
    await caller.invoke({ method: 'modelOutput.close', generation: 1, readId: 'full' });
    expect(signals[0]!.aborted).toBe(true);
    originStoreId = 'wrong-origin';
    await expect(caller.invoke({ ...request, readId: 'wrong' })).rejects.toMatchObject({
      code: 'model_output_identity_mismatch',
    });
    expect(reads).toEqual(['execution:e', 'output:s:e:store', 'execution:e']);
    expect(message.originMessage!.storeId).toBe('original-store');
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});
test('quit inspection aborts only its complete directory/view GET when the service does not answer, preserving unknown work and zero writes', async () => {
  const port = client(),
    signals: AbortSignal[] = [];
  Object.assign(port, {
    async listAllSessions(options: { signal: AbortSignal }) {
      signals.push(options.signal);
      return [{ id: 's' }];
    },
    async getView(_id: string, options: { signal: AbortSignal }) {
      signals.push(options.signal);
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(Error('inspection_aborted')), {
          once: true,
        }),
      );
    },
  });
  const caller = new NativeCaller(port, () => {}, memoryPrivateData());
  try {
    expect(await inspectNativeQuitWork((signal) => caller.hasActiveWork(signal), 10)).toBe(true);
    expect(signals.length).toBe(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]!.aborted).toBe(true);
    expect(port.writes).toBe(0);
    expect(await inspectNativeQuitWork(async () => false, 10)).toBe(false);
    expect(
      await inspectNativeQuitWork(async () => {
        throw Error('query unavailable');
      }, 10),
    ).toBe(true);
  } finally {
    await caller.close();
  }
});
test('formal Native metadata port reads only messages observed through the current original history', async () => {
  const connection = client();
  const message: Message = {
    id: 'tool-message',
    sessionId: 's',
    runId: 'run',
    seq: '1',
    status: 'complete',
    role: 'tool',
    content: 'real_failure',
    sourceIds: ['execution'],
  };
  const originalView = connection.getView.bind(connection);
  connection.getView = async (id) => {
    const view = await originalView(id);
    return { ...view, session: { ...view.session, nextSeq: '1' } };
  };
  connection.verifyConnection = async () => connection.serverInfo!;
  connection.listMessages = async () => [message];
  const reads: string[] = [];
  let notify!: Parameters<AgentClient['observe']>[0]['onChange'];
  connection.observe = async (options) => {
    notify = options.onChange;
    await new Promise<void>((resolve) =>
      options.signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  let refreshStarted!: () => void, releaseRefresh: (() => void) | undefined;
  const refreshing = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  connection.getExecution = async (id) => {
    reads.push(id);
    return {
      id,
      originStoreId: 'store',
      sessionId: 's',
      runId: 'run',
      kind: 'tool',
      definitionId: 'custom.tool',
      definitionVersion: '1',
      status: 'failed',
      result: { outcome: 'failed', content: message.content },
      resultRevision: '1',
      cancelRequestedAt: null,
    };
  };
  connection.getRun = async (id) => ({
    id,
    originStoreId: 'store',
    originCommandId: 'command',
    sessionId: 's',
    status: 'failed',
    isActive: false,
    createdAt: 1000,
    finishedAt: 3000,
    reason: 'actual reason',
  });
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    const selected = (await caller.invoke({
      method: 'select',
      generation: 1,
      sessionId: 's',
    })) as NativeState;
    const request = {
      method: 'toolMessages.list' as const,
      generation: 1,
      viewSelection: selected.selection!.viewSelection!,
      historyEpoch: selected.historyEpoch!,
      readId: 'tools',
      messageIds: [message.id],
    };
    await expect(caller.invoke(request)).rejects.toMatchObject({
      code: 'tool_message_unavailable',
    });
    expect(reads).toEqual([]);
    await caller.invoke({
      method: 'messages',
      generation: 1,
      sessionId: 's',
      expectedStoreId: 'store',
      readId: 'history',
      afterSeq: '0',
      upperSeq: '1',
      limit: 32,
    });
    expect(await caller.invoke(request)).toMatchObject({
      kind: 'toolMessages.page',
      scope: {
        sessionId: 's',
        storeId: 'store',
        viewSelection: selected.selection!.viewSelection!,
      },
      entries: [{ messageId: message.id, executionId: 'execution', status: 'failed' }],
    });
    expect(reads).toEqual(['execution']);
    expect(
      await caller.invoke({ ...request, method: 'toolMessages.runs', readId: 'run-metadata' }),
    ).toMatchObject({
      kind: 'toolMessages.runs',
      runs: [{ id: 'run', status: 'failed', reason: 'actual reason' }],
    });
    connection.getView = async (id) => {
      refreshStarted();
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const view = await originalView(id);
      return { ...view, session: { ...view.session, nextSeq: '1' } };
    };
    await notify?.({
      cursor: '1',
      objectId: 'execution',
      sessionId: 's',
      type: 'execution.completed',
      revision: '1',
      payload: null,
    });
    await refreshing;
    // Metadata can finish against the retained same-identity view during an ordinary refresh.
    expect(await caller.invoke({ ...request, readId: 'during-refresh' })).toMatchObject({
      kind: 'toolMessages.page',
      entries: [{ executionId: 'execution', status: 'failed' }],
    });
    expect(
      await caller.invoke({
        ...request,
        method: 'toolMessages.runs',
        readId: 'run-during-refresh',
      }),
    ).toMatchObject({ kind: 'toolMessages.runs', runs: [{ id: 'run', status: 'failed' }] });
    releaseRefresh!();
    await caller.invoke({ method: 'state', generation: 1 });
    expect(
      await caller.invoke({ method: 'toolMessages.close', generation: 1, readId: 'tools' }),
    ).toBeNull();
    expect(connection.writes).toBe(0);
  } finally {
    releaseRefresh?.();
    await caller.close();
  }
});
test('Native history shrinks public response and IPC pages with the original cursor and high water; closing aborts only that read', async () => {
  const connection = client();
  const queries: { afterSeq?: string; upperSeq?: string; limit?: number }[] = [];
  let readSignal: AbortSignal | undefined;
  connection.listMessages = (async (_id, options) => {
    queries.push({
      afterSeq: options?.afterSeq,
      upperSeq: options?.upperSeq,
      limit: options?.limit,
    });
    readSignal = options?.signal;
    if (options!.limit! > 50)
      throw Object.assign(Error('oversized public response'), { code: 'response_too_large' });
    return Array.from({ length: options!.limit! }, (_, index) => ({
      id: `large-${index}`,
      sessionId: 's',
      seq: String(index + 1),
      content: 'x'.repeat(100000),
    }));
  }) as AgentClient['listMessages'];
  const originalView = connection.getView.bind(connection);
  connection.getView = (async (id) => {
    const view = await originalView(id);
    return { ...view, session: { ...view.session, nextSeq: '100' } };
  }) as AgentClient['getView'];
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    const page = await caller.invoke({
      method: 'messages',
      generation: 1,
      sessionId: 's',
      expectedStoreId: 'store',
      readId: 'large-history',
      afterSeq: '0',
      upperSeq: '100',
      limit: 200,
    });
    expect(queries).toEqual(
      [200, 100, 50, 25].map((limit) => ({ afterSeq: '0', upperSeq: '100', limit })),
    );
    expect(page).toMatchObject({ highWaterSeq: '100', nextAfterSeq: '25' });
    expect(page && 'messages' in page ? page.messages.length : -1).toBe(25);
    expect(readSignal?.aborted).toBe(false);
    await caller.invoke({ method: 'messages.close', generation: 1, readId: 'large-history' });
    expect(readSignal?.aborted).toBe(true);
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}
test('main IPC denies foreign/subframe senders and closed or oversized requests before client/startup; oversize reply stays local', async () => {
  const auth = authority();
  expect(() => assertNativeSender(auth.event, auth.window, auth.frame.url)).not.toThrow();
  expect(() =>
    assertNativeSender(
      { ...auth.event, senderFrame: { url: auth.frame.url } } as IpcMainInvokeEvent,
      auth.window,
      auth.frame.url,
    ),
  ).toThrow('native_sender_denied');
  expect(() =>
    assertNativeSender(auth.event, auth.window, 'file:///private/tmp/foreign.html'),
  ).toThrow('native_sender_denied');
  expect(() => decodeNativeRequest({ method: 'attach', token: 'hidden' })).toThrow(
    'invalid_native_request',
  );
  expect(() =>
    decodeNativeRequest({ method: 'messages', generation: 1, sessionId: 's', limit: 201 }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'submit',
      generation: 1,
      sessionId: 's',
      intent: { kind: 'run.start', subjectId: 'intruder' },
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'draft.write',
      generation: 1,
      sessionId: 's',
      revision: 0,
      content: 'x'.repeat(1048576),
    }),
  ).toThrow('native_request_too_large');
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>,
    calls = 0;
  const ipcMain = {
    handle(channel: string, value: typeof handler) {
      expect(channel).toBe(nativeChannel);
      handler = value;
    },
    removeHandler() {},
  } as unknown as IpcMain;
  const host = {
    invoke: async () => ({ content: 'x'.repeat(4 * 1048576), revision: 0 }),
  } as unknown as NativeCaller;
  registerNativeIpc({
    ipcMain,
    window: () => auth.window,
    rendererUrl: auth.frame.url,
    caller: async () => {
      calls++;
      return host;
    },
  });
  expect(await handler(auth.event, { method: 'attach', token: 'bad' })).toEqual({
    ok: false,
    code: 'invalid_native_request',
  });
  expect(calls).toBe(0);
  expect(await handler(auth.event, { method: 'attach' })).toEqual({
    ok: false,
    code: 'native_response_too_large',
  });
  expect(calls).toBe(1);
});
test('main-private drafts require exact selection/revision; detached or late generations cannot rebind; network disposal is not owned shutdown', async () => {
  const port = client(),
    events: number[] = [],
    caller = new NativeCaller(port, (event) => events.push(event.generation), memoryPrivateData());
  try {
    const first = await caller.invoke({ method: 'attach' });
    const generation = (first as { generation: number }).generation;
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(
      await caller.invoke({
        method: 'draft.write',
        generation,
        sessionId: 's',
        content: 'private body',
        revision: 0,
      }),
    ).toMatchObject({ content: 'private body', revision: 1 });
    expect(
      await code(
        caller.invoke({
          method: 'draft.write',
          generation,
          sessionId: 's',
          content: 'overwrite',
          revision: 0,
        }),
      ),
    ).toBe('draft_revision_conflict');
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    expect(await code(caller.invoke({ method: 'draft.read', generation, sessionId: 's' }))).toBe(
      'native_selection_changed',
    );
    expect(JSON.stringify(caller.state())).not.toContain('private body');
    caller.detach();
    expect(await code(caller.invoke({ method: 'state', generation }))).toBe(
      'native_generation_changed',
    );
    const next = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation: next.generation, sessionId: 's' });
    expect(
      await caller.invoke({ method: 'draft.read', generation: next.generation, sessionId: 's' }),
    ).toMatchObject({ content: 'private body', revision: 1 });
    await caller.disposeNetwork();
    expect(port.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('an unknown original input survives a view switch; lookup and same-ID retry cannot rebind or issue a second mutation', async () => {
  const port = client();
  let dispatched = 0;
  const queried: string[] = [];
  port.startRun = async () => {
    dispatched++;
    throw new Error('controlled_response_lost');
  };
  port.getCommand = async (commandId) => {
    queried.push(commandId);
    return {
      id: commandId,
      sessionId: 's',
      originStoreId: 'store',
      kind: 'run.start',
      subjectId: 'local-user',
      requestDigest: callerTextDigest(
        canonicalCallerCommandRequest({
          kind: 'run.start',
          expectedStoreId: 'store',
          commandId: 'original',
          content: 'exact body',
        }),
      ),
      status: 'accepted',
      receipt: null,
    } as Awaited<ReturnType<AgentClient['getCommand']>>;
  };
  const data = memoryPrivateData();
  const caller = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: 'store',
      commandId: 'original',
      content: 'exact body',
    };
    const first = await caller.invoke({ method: 'submit', generation, sessionId: 's', intent });
    expect(first).toMatchObject({
      phase: 'unknown',
      sessionId: 's',
      intent: {
        kind: intent.kind,
        expectedStoreId: intent.expectedStoreId,
        commandId: intent.commandId,
      },
    });
    expect(data.callers()[0]!.intent.request).toEqual(intent);
    expect(JSON.stringify(caller.state())).not.toContain('exact body');
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    const reconciled = await caller.invoke({
      method: 'lookupInput',
      generation,
      commandId: 'original',
    });
    expect(reconciled).toMatchObject({
      phase: 'accepted',
      sessionId: 's',
      intent: {
        kind: intent.kind,
        expectedStoreId: intent.expectedStoreId,
        commandId: intent.commandId,
      },
    });
    expect(queried).toEqual(['original']);
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(
      await caller.invoke({ method: 'submit', generation, sessionId: 's', intent }),
    ).toMatchObject({ phase: 'accepted' });
    expect(dispatched).toBe(1);
    expect(
      await code(caller.invoke({ method: 'lookupInput', generation, commandId: 'another' })),
    ).toBe('input_intent_missing');
  } finally {
    await caller.close();
  }
});

test('Session creation freezes a durable original intent; unknown and wrong receipts never cause a second POST or overwrite drafts', async () => {
  const port = client(),
    data = memoryPrivateData();
  let posts = 0,
    lookups = 0,
    wrong = false;
  Object.assign(port, {
    async createSession() {
      posts++;
      throw Error('physical response lost');
    },
    async getCommand(id: string) {
      lookups++;
      return {
        id,
        sessionId: wrong ? 'wrong' : 'new',
        kind: 'session.create',
        receipt: { sessionId: 'new' },
        status: 'applied',
        originStoreId: 'store',
      };
    },
  });
  const caller = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    await caller.invoke({
      method: 'draft.write',
      generation,
      sessionId: 's',
      revision: 0,
      content: 'retained',
    });
    const intent = {
      method: 'createSession' as const,
      generation,
      workspaceId: 'w',
      expectedStoreId: 'store',
      commandId: 'original-create',
      sessionId: 'new',
      title: 'new',
    };
    expect(await caller.invoke(intent)).toMatchObject({ phase: 'unknown' });
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    expect(await caller.invoke(intent)).toMatchObject({ phase: 'unknown' });
    expect(posts).toBe(1);
    expect(await code(caller.invoke({ ...intent, sessionId: 'wrong' }))).toBe(
      'creation_intent_conflict',
    );
    wrong = true;
    expect(
      await code(
        caller.invoke({ method: 'lookupCreation', generation, commandId: intent.commandId }),
      ),
    ).toBe('creation_identity_mismatch');
    expect(caller.state().creationSubmissions[0]!.phase).toBe('unknown');
    wrong = false;
    expect(
      await caller.invoke({ method: 'lookupCreation', generation, commandId: intent.commandId }),
    ).toMatchObject({ phase: 'created' });
    expect(posts).toBe(1);
    expect(lookups).toBe(2);
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(await caller.invoke({ method: 'draft.read', generation, sessionId: 's' })).toMatchObject(
      { content: 'retained', revision: 1 },
    );
  } finally {
    await caller.close();
  }
});

test('old Store and deleted Session draft associations preserve original text without rebinding; missing private storage is local', async () => {
  const port = client(),
    data = memoryPrivateData();
  const old = data.save(
    { storeId: 'older-store', workspaceId: 'old-workspace', rootSessionId: 'old-session' },
    0,
    'old original',
  );
  const deleted = data.save(
    { storeId: 'store', workspaceId: 'w', rootSessionId: 'gone' },
    0,
    'deleted original',
  );
  const readView = port.getView.bind(port);
  Object.assign(port, {
    async getView(id: string) {
      if (id === 'gone') throw Error('session missing');
      return readView(id);
    },
  });
  const caller = new NativeCaller(port, () => {}, data),
    unavailable = new NativeCaller(client(), () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(
      await caller.invoke({ method: 'draft.original', generation, draftId: old.id }),
    ).toMatchObject({
      association: 'unavailable',
      content: 'old original',
      storeId: 'older-store',
    });
    expect(
      await caller.invoke({ method: 'draft.original', generation, draftId: deleted.id }),
    ).toMatchObject({
      association: 'unavailable',
      content: 'deleted original',
      rootSessionId: 'gone',
    });
    expect(await caller.invoke({ method: 'draft.read', generation, sessionId: 's' })).toMatchObject(
      { content: '', revision: 0 },
    );
    const attached = (await unavailable.invoke({ method: 'attach' })) as { generation: number };
    await unavailable.invoke({ method: 'select', generation: attached.generation, sessionId: 's' });
    expect(
      await code(
        unavailable.invoke({
          method: 'draft.read',
          generation: attached.generation,
          sessionId: 's',
        }),
      ),
    ).toBe('draft_storage_unavailable');
    expect(
      (
        (await unavailable.invoke({ method: 'state', generation: attached.generation })) as {
          selection: unknown;
        }
      ).selection,
    ).toBeDefined();
  } finally {
    await caller.close();
    await unavailable.close();
  }
});

test('main shutdown and directory exhaust admitted SDK pages: activity beyond 200 is observed, query failure is not idle', async () => {
  const port = client();
  let reads = 0;
  const view = port.getView.bind(port);
  Object.assign(port, {
    async listAllSessions() {
      return Array.from({ length: 205 }, (_, i) => ({ id: `session-${i}` }));
    },
    async listAllWorkspaces() {
      return Array.from({ length: 205 }, (_, i) => ({ id: `workspace-${i}` }));
    },
    async getView(id: string) {
      reads++;
      const value = await view(id);
      return { ...value, runs: id === 'session-204' ? [{ isActive: true }] : [] };
    },
    async listSessions() {
      throw Error('legacy first page forbidden');
    },
    async listWorkspaces() {
      throw Error('legacy first page forbidden');
    },
  });
  const caller = new NativeCaller(port, () => {}, memoryPrivateData());
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    const directory = (await caller.invoke({ method: 'directory', generation })) as {
      sessions: unknown[];
      workspaces: unknown[];
    };
    expect(directory.sessions.length).toBe(205);
    expect(directory.workspaces.length).toBe(205);
    expect(await caller.hasActiveWork()).toBe(true);
    expect(reads).toBe(205);
    Object.assign(port, {
      async listAllSessions() {
        throw Error('query unavailable');
      },
    });
    expect(await code(caller.hasActiveWork())).toBe('query unavailable');
  } finally {
    await caller.close();
  }
});

test('global activity refresh follows non-selected changes, retains failed observations, and never blocks selected reading or revives a detached read', async () => {
  const port = client();
  port.serverInfo!.capabilities.push('session_directory_activity');
  let change!: () => void,
    mode = 'ok',
    timestamp = 1000,
    pending = 1;
  let heldSignal: AbortSignal | undefined;
  let release!: (value: unknown) => void;
  const views: string[] = [];
  const original = port.getView.bind(port);
  Object.assign(port, {
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      change = () => {
        void options.onChange?.({} as never);
      };
      await options.onReady?.({} as never);
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async listAllWorkspaces() {
      return [{ id: 'w', name: 'w', rootUri: 'file:///w' }];
    },
    async listAllSessionDirectory(options: { signal: AbortSignal }) {
      if (mode === 'fail') throw Error('activity unavailable');
      const entries = Array.from({ length: 205 }, (_, index) => ({
        seq: String(index + 1),
        session: {
          id: `s-${index}`,
          workspaceId: 'w',
          rootSessionId: `s-${index}`,
          parentSessionId: null,
          title: 'same name',
          controlRevision: '0',
          contextSelectionId: 'selection',
          nextSeq: '0',
          deletedAt: null,
        },
        activity: {
          updatedAt: timestamp,
          queued: false,
          pendingInteractions: index === 204 ? pending : 0,
          run:
            index === 204
              ? {
                  id: 'actual-run',
                  status: pending ? 'waiting_interaction' : 'completed',
                  isActive: !!pending,
                  waitingForResults: false,
                }
              : null,
        },
      }));
      if (mode === 'hold') {
        heldSignal = options.signal;
        return await new Promise((resolve) => {
          release = resolve;
        });
      }
      return entries;
    },
    async getView(id: string) {
      views.push(id);
      return original(id);
    },
    async listAllSessions() {
      throw Error('identity-only directory forbidden');
    },
  });
  const caller = new NativeCaller(port, () => {}, memoryPrivateData());
  const wait = async (accept: (value: NativeState) => boolean) => {
    for (let i = 0; i < 100 && !accept(caller.state()); i++) await Bun.sleep(1);
    expect(accept(caller.state())).toBe(true);
  };
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await wait((state) => state.directory?.sessions.length === 205);
    await caller.invoke({ method: 'select', generation, sessionId: 's-0' });
    expect(caller.state().directory!.sessions[204]!.activity).toMatchObject({
      pendingInteractions: 1,
      run: { id: 'actual-run', status: 'waiting_interaction' },
    });
    timestamp = 2000;
    pending = 0;
    change();
    await wait((state) => state.directory?.sessions[204]?.activity?.updatedAt === 2000);
    expect(caller.state().selection?.session.id).toBe('s-0');
    expect(caller.state().directory!.sessions[204]!.activity?.pendingInteractions).toBe(0);
    expect(views.every((id) => id === 's-0')).toBe(true);
    mode = 'fail';
    change();
    await wait((state) => state.directory?.unavailable === true);
    expect(caller.state().directory!.sessions).toHaveLength(205);
    expect(caller.state().directory!.sessions[204]!.activity?.updatedAt).toBe(2000);
    mode = 'hold';
    change();
    for (let i = 0; i < 100 && !heldSignal; i++) await Bun.sleep(1);
    expect(heldSignal).toBeDefined();
    await caller.invoke({ method: 'select', generation, sessionId: 's-1' });
    expect(
      ((await caller.invoke({ method: 'state', generation })) as NativeState).selection?.session.id,
    ).toBe('s-1');
    await caller.invoke({ method: 'detach', generation });
    expect(heldSignal!.aborted).toBe(true);
    release([]);
    await Bun.sleep(2);
    expect(caller.state().directory).toBeUndefined();
    expect(port.writes).toBe(0);
  } finally {
    release?.([]);
    await caller.close();
  }
});

test('cold observer reset invalidates the old directory read explicitly and publishes the new observation without effects', async () => {
  const port = client();
  let reset!: () => void,
    reads = 0,
    held: AbortSignal | undefined;
  Object.assign(port, {
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      await options.onReady?.({} as never);
      await new Promise<void>((resolve) => {
        reset = () => {
          void options.onReset?.({} as never);
          resolve();
        };
        options.signal!.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    async listWorkspaceDirectory() {
      return { snapshotCursor: '10' };
    },
    async listAllWorkspaces(options: { signal: AbortSignal }) {
      if (++reads === 1) {
        held = options.signal;
        await new Promise<void>((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        );
      }
      return [{ id: 'w', name: 'Restored project', rootUri: 'file:///w' }];
    },
  });
  const caller = new NativeCaller(port, () => {}, memoryPrivateData());
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const reading = code(caller.invoke({ method: 'directory', generation }));
    for (let i = 0; i < 100 && !held; i++) await Bun.sleep(1);
    expect(held).toBeDefined();
    // invoke first drains Main refresh; allow it to join the existing held GET before reset.
    await Bun.sleep(1);
    reset();
    expect(await reading).toBe('directory_observation_changed');
    expect(held!.aborted).toBe(true);
    for (let i = 0; i < 100 && caller.state().directory?.unavailable !== false; i++)
      await Bun.sleep(5);
    expect(caller.state().directory).toMatchObject({
      unavailable: false,
      workspaces: [{ id: 'w', name: 'Restored project' }],
    });
    expect(port.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('same creation command shares one in-flight POST across view switches; cold pending intent only queries', async () => {
  const port = client(),
    data = memoryPrivateData();
  let posts = 0,
    release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  Object.assign(port, {
    async createSession() {
      posts++;
      await barrier;
      throw Error('lost response');
    },
  });
  const caller = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    const intent = {
      method: 'createSession' as const,
      generation,
      workspaceId: 'w',
      expectedStoreId: 'store',
      commandId: 'single',
      sessionId: 'new',
      title: 'new',
    };
    const first = caller.invoke(intent),
      second = caller.invoke(intent);
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    expect(posts).toBe(1);
    release();
    expect(await first).toMatchObject({ phase: 'unknown' });
    expect(await second).toMatchObject({ phase: 'unknown' });
    expect(posts).toBe(1);
  } finally {
    release();
    await caller.close();
  }
  data.begin({
    expectedStoreId: 'store',
    workspaceId: 'w',
    commandId: 'cold',
    sessionId: 'cold-session',
    title: 'new',
  });
  const cold = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await cold.invoke({ method: 'attach' })) as { generation: number };
    expect(
      cold.state().creationSubmissions.find((value) => value.input.commandId === 'cold')!.phase,
    ).toBe('unknown');
    expect(
      await cold.invoke({
        method: 'createSession',
        generation,
        expectedStoreId: 'store',
        workspaceId: 'w',
        commandId: 'cold',
        sessionId: 'cold-session',
        title: 'new',
      }),
    ).toMatchObject({ phase: 'unknown' });
    expect(posts).toBe(1);
  } finally {
    await cold.close();
  }
});
