import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentClient, Message, ModelOutputSnapshot } from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';

test('Native linked output derives original Session/run only from cloned observed Message; renderer source authority and late view fail locally', async () => {
  const output = { complete: true, content: 'original body', reasoning: '', toolCalls: [] },
    body = JSON.stringify(output),
    gets: string[] = [];
  const value = {
    storeId: 'store',
    sessionId: 'original',
    rootSessionId: 'original',
    runId: 'run-original',
    executionId: 'model',
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    bodyHash: createHash('sha256').update(body).digest('hex'),
    bodyBytes: String(Buffer.byteLength(body)),
    contentBytes: '13',
    reasoningBytes: '0',
    snapshotCursor: '4',
    output,
  } as ModelOutputSnapshot;
  const message = {
    id: 'copied',
    sessionId: 'fork',
    runId: null,
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: 'preview',
    originMessage: {
      storeId: 'store',
      sessionId: 'original',
      messageId: 'original-message',
      runId: 'run-original',
    },
    outputBody: {
      executionId: 'model',
      complete: true,
      contentBytes: '13',
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  } as Message;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['sessions', 'history', 'model_outputs'] },
    connect: async () => {},
    observe: async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    disposeNetwork() {},
    getView: async (id: string) => ({
      storeId: 'store',
      session: {
        id,
        workspaceId: 'w',
        rootSessionId: id,
        parentSessionId: null,
        title: id,
        contextSelectionId: 'selection',
        controlRevision: '0',
        nextSeq: '1',
        deletedAt: null,
      },
      runs: [],
      executions: [],
      messages: [],
    }),
    listMessages: async () => [message],
    getExecution: async () => ({
      id: 'model',
      kind: 'model',
      sessionId: 'original',
      runId: 'run-original',
      originStoreId: 'store',
    }),
    async getModelOutput(id: string) {
      gets.push(id);
      return value;
    },
  } as unknown as AgentClient;
  const main = new NativeCaller(client, () => {});
  try {
    await main.invoke({ method: 'attach' });
    await main.invoke({ method: 'select', generation: 1, sessionId: 'fork' });
    expect(() =>
      decodeNativeRequest({
        method: 'modelOutput.open',
        generation: 1,
        readId: 'r',
        expectedStoreId: 'store',
        sessionId: 'fork',
        executionId: 'model',
        messageId: 'copied',
        sourceSessionId: 'evil',
      }),
    ).toThrow('invalid_native_request');
    let missing = false;
    try {
      await main.invoke({
        method: 'modelOutput.open',
        generation: 1,
        readId: 'r',
        expectedStoreId: 'store',
        sessionId: 'fork',
        executionId: 'model',
        messageId: 'copied',
      });
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
    expect(gets).toHaveLength(0);
    await main.invoke({ method: 'messages', generation: 1, sessionId: 'fork', limit: 50 });
    message.originMessage!.sessionId = 'mutated-alias';
    const opened = await main.invoke({
      method: 'modelOutput.open',
      generation: 1,
      readId: 'r',
      expectedStoreId: 'store',
      sessionId: 'fork',
      executionId: 'model',
      messageId: 'copied',
    });
    expect(opened).toMatchObject({ sessionId: 'original', executionId: 'model', viewSelection: 2 });
    expect(gets).toEqual(['original']);
    await main.invoke({ method: 'select', generation: 1, sessionId: 'other' });
    let late = false;
    try {
      await main.invoke({
        method: 'modelOutput.read',
        generation: 1,
        readId: 'r',
        offset: 0,
        limit: 64,
      });
    } catch {
      late = true;
    }
    expect(late).toBe(true);
    expect(gets).toHaveLength(1);
  } finally {
    await main.close();
  }
});
