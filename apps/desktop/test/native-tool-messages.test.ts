import { expect, test } from 'bun:test';
import type { AgentClient, Execution, Message } from '@kite-ai/client';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeToolMessages } from '../electron/tool-messages';
import type { NativeToolMessageScope } from '../src/tool-messages-bridge';

function fixture() {
  let scope: NativeToolMessageScope = {
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
  };
  const messages = new Map<string, Message>(),
    executions = new Map<string, Execution>(),
    reads: string[] = [];
  const client = {
    verifyConnection: async () => {},
    getExecution: async (id: string) => {
      reads.push(id);
      return executions.get(id)!;
    },
  } as unknown as AgentClient;
  const manager = new NativeToolMessages(
    client,
    () => scope,
    () => messages,
  );
  const add = (
    id: string,
    status: Execution['status'],
    run = id,
    definitionId = 'shell.launch',
  ) => {
    messages.set(`call-${id}`, {
      id: `call-${id}`,
      seq: String(messages.size + 1),
      sessionId: 's',
      runId: run,
      role: 'assistant',
      status: 'complete',
      content: '',
      toolCalls: [
        {
          id: 'repeated',
          name: definitionId,
          arguments: JSON.stringify({ command: `${id} 雪🙂`, path: `${id}.txt` }),
        },
      ],
    });
    const message: Message = {
      id,
      seq: String(messages.size + 1),
      sessionId: 's',
      runId: run,
      role: 'tool',
      status: 'complete',
      content: `original-${id}`,
      toolCallId: 'repeated',
      sourceIds: [`execution-${id}`],
    };
    messages.set(id, message);
    executions.set(`execution-${id}`, {
      id: `execution-${id}`,
      originStoreId: 'store',
      sessionId: 's',
      runId: run,
      kind: 'tool',
      definitionId,
      definitionVersion: '1',
      status,
      result: { outcome: status, content: message.content },
      resultRevision: '1',
      cancelRequestedAt: null,
    });
  };
  const list = (messageIds: string[]) =>
    manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: scope.viewSelection,
      historyEpoch: scope.historyEpoch,
      readId: crypto.randomUUID(),
      messageIds,
    });
  return {
    client,
    messages,
    executions,
    reads,
    manager,
    add,
    list,
    get scope() {
      return scope;
    },
    set scope(value) {
      scope = value;
    },
  };
}

test('tool receipts outside the bounded View retain exact outcomes and only unique original call targets; repeated call IDs never establish execution identity', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 241; index++) f.add(`m${index}`, 'succeeded');
    f.add('failed', 'failed');
    f.add('cancelled', 'cancelled');
    f.add('unknown', 'outcome_unknown');
    const page = await f.list(['m240', 'failed', 'cancelled', 'unknown']);
    expect(page.entries.map((entry) => entry.status)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'outcome_unknown',
    ]);
    expect(page.entries.map((entry) => entry.target)).toEqual([
      'm240 雪🙂',
      'failed 雪🙂',
      'cancelled 雪🙂',
      'unknown 雪🙂',
    ]);
    expect(f.reads).toEqual([
      'execution-m240',
      'execution-failed',
      'execution-cancelled',
      'execution-unknown',
    ]);
    expect(page.scope).toEqual(f.scope);
    f.add('first-same-run', 'succeeded', 'shared');
    f.add('second-same-run', 'failed', 'shared');
    expect((await f.list(['second-same-run'])).entries[0]).toMatchObject({
      executionId: 'execution-second-same-run',
      status: 'failed',
    });
    expect((await f.list(['second-same-run'])).entries[0]!.target).toBeUndefined();
    const execution = f.executions.get('execution-failed')!;
    execution.result = { outcome: 'succeeded', content: 'original-failed' };
    expect((await f.list(['failed'])).entries).toEqual([]);
    execution.result = { outcome: 'failed', content: 'later unrelated body' };
    expect((await f.list(['failed'])).entries).toEqual([]);
    execution.result = { outcome: 'failed', content: 'original-failed' };
    execution.runId = 'm240';
    await expect(f.list(['failed'])).rejects.toMatchObject({
      code: 'tool_message_identity_mismatch',
    });
    await expect(f.list(['unobserved'])).rejects.toMatchObject({
      code: 'tool_message_unavailable',
    });
  } finally {
    f.manager.release();
  }
});

test('sealed Fork provenance is read-only, foreign or unsupported results cause no Execution GET, and close/selection change abort only the owned metadata read', async () => {
  const f = fixture();
  try {
    f.add('fork', 'failed');
    const message = f.messages.get('fork')!;
    message.originMessage = {
      storeId: 'store',
      sessionId: 'source',
      runId: 'source-run',
      messageId: 'original',
    };
    const execution = f.executions.get('execution-fork')!;
    execution.sessionId = 'source';
    execution.runId = 'source-run';
    expect((await f.list(['fork'])).entries[0]).toMatchObject({
      executionId: execution.id,
      status: 'failed',
    });
    f.reads.length = 0;
    message.originMessage.storeId = 'old-store';
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    message.originMessage.storeId = 'store';
    message.originMessage.runId = null;
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    message.originMessage.runId = 'source-run';
    message.contentFormat = 'unsupported';
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    delete message.contentFormat;
    let release!: (value: Execution) => void, signal: AbortSignal | undefined;
    let started!: () => void;
    let ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.client.getExecution = (async (_id, options) => {
      signal = options?.signal;
      started();
      return new Promise<Execution>((resolve) => {
        release = resolve;
      });
    }) as AgentClient['getExecution'];
    const pending = f.manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'held',
      messageIds: ['fork'],
    });
    const rejection = pending.catch((error: unknown) => error);
    await ready;
    f.manager.close('held');
    expect(signal?.aborted).toBe(true);
    release(execution);
    expect(await rejection).toMatchObject({ code: 'native_selection_changed' });
    ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const next = f.manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'later',
      messageIds: ['fork'],
    });
    const changed = next.catch((error: unknown) => error);
    await ready;
    f.scope = { ...f.scope, historyEpoch: 1 };
    release(execution);
    expect(await changed).toMatchObject({ code: 'native_selection_changed' });
    expect(signal?.aborted).toBe(true);
  } finally {
    f.manager.release();
  }
});

test('tool metadata IPC has the same closed 32-message request and current reading scope', () => {
  const request = {
    method: 'toolMessages.list' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'owned',
    messageIds: ['observed'],
  };
  expect(decodeNativeRequest(request)).toEqual(request);
  for (const change of [
    { executionId: 'arbitrary' },
    { messageIds: Array.from({ length: 33 }, (_, index) => `m${index}`) },
    { messageIds: ['same', 'same'] },
    { messageIds: ['../path'] },
    { viewSelection: 0 },
    { historyEpoch: -1 },
  ])
    expect(() => decodeNativeRequest({ ...request, ...change })).toThrow('invalid_native_request');
  expect(
    decodeNativeRequest({ method: 'toolMessages.close', generation: 1, readId: 'owned' }),
  ).toMatchObject({ method: 'toolMessages.close' });
});
