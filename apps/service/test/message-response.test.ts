import { expect, test } from 'bun:test';
import type { AgentRuntime } from '@kite-ai/agent';
import type { MessageRecord } from '@kite-ai/agent/storage';
import { messageResponses } from '../src/message-response';

test('restored inline Fork history preserves the original user, Model and Tool Store instead of inventing the current Store as their source', async () => {
  const originals: MessageRecord[] = ['user', 'assistant', 'tool'].map((role, index) => ({
    id: `original-${role}`,
    sessionId: 'source',
    runId: 'original-run',
    seq: String(index + 1),
    role: role as MessageRecord['role'],
    status: 'complete',
    content: `original ${role} 雪🙂`,
    createdAt: 1234567890000 + index,
  }));
  const copies = originals.map((message) => ({
    ...message,
    id: `copy-${message.role}`,
    sessionId: 'fork',
    runId: null,
    createdAt: undefined,
  }));
  const runtime = {
    getMessageOrigin: async ({
      messageId,
      expectedStoreId,
    }: {
      messageId: string;
      expectedStoreId: string;
    }) => {
      expect(expectedStoreId).toBe('restored-store');
      return {
        message: originals[copies.findIndex((message) => message.id === messageId)]!,
        subjectId: 'owner',
        originStoreId: 'original-store',
      };
    },
  } as unknown as AgentRuntime;
  const messages = await messageResponses(runtime, copies, 'restored-store', 'owner');
  for (let index = 0; index < messages.length; index++) {
    expect(messages[index]).toMatchObject({
      ...copies[index]!,
      createdAt: originals[index]!.createdAt,
      originMessage: {
        storeId: 'original-store',
        sessionId: 'source',
        runId: 'original-run',
        messageId: originals[index]!.id,
      },
    });
  }
});

test('history with no original Store proof keeps its preview without labelling it as current-Store provenance', async () => {
  const original: MessageRecord = {
    id: 'original',
    sessionId: 'source',
    runId: null,
    seq: '1',
    role: 'system',
    status: 'complete',
    content: 'preserved original preview',
  };
  const copy = { ...original, id: 'copy', sessionId: 'fork' };
  const runtime = {
    getMessageOrigin: async () => ({ message: original, subjectId: 'owner' }),
  } as unknown as AgentRuntime;
  expect((await messageResponses(runtime, [copy], 'restored-store', 'owner'))[0]).toEqual(copy);
});

test('restored sealed Model history projects the original private output Store while the read remains bound to the current Store', async () => {
  const original: MessageRecord = {
      id: 'original',
      sessionId: 'source',
      runId: 'run',
      seq: '1',
      role: 'assistant',
      status: 'complete',
      content: 'preview',
      sourceIds: ['model'],
      modelOutput: {
        kind: 'model_output',
        version: 1,
        seq: '1',
        contentBytes: '70000',
        reasoningBytes: '0',
        toolCallCount: 0,
        complete: true,
        head: {
          id: 'original-head',
          storeId: 'original-store',
          sessionId: 'source',
          subjectId: 'owner',
          scope: { kind: 'execution', id: 'model' },
          hash: 'a'.repeat(64),
          size: '32768',
          mediaType: 'application/json',
        },
      },
    },
    copied: MessageRecord = {
      ...structuredClone(original),
      id: 'copied',
      sessionId: 'fork',
      runId: null,
    },
    runtime = {
      getMessageOrigin: async (input: unknown) => {
        expect(input).toEqual({
          expectedStoreId: 'restored-store',
          sessionId: 'fork',
          subjectId: 'owner',
          messageId: 'copied',
        });
        return { message: original, subjectId: 'owner' };
      },
    } as unknown as AgentRuntime;
  const [message] = await messageResponses(runtime, [copied], 'restored-store', 'owner');
  expect(message).toMatchObject({
    id: 'copied',
    sessionId: 'fork',
    runId: null,
    originMessage: {
      storeId: 'original-store',
      sessionId: 'source',
      messageId: 'original',
      runId: 'run',
    },
    outputBody: { executionId: 'model', complete: true, contentBytes: '70000' },
  });
  expect(original.modelOutput!.head.storeId).toBe('original-store');
  expect(copied.modelOutput!.head.storeId).toBe('original-store');
});

test('sealed original compression facts survive the public message response with exact source provenance', async () => {
  const original: MessageRecord = {
    id: 'summary-original',
    sessionId: 'source',
    runId: 'source-run',
    seq: '4',
    role: 'assistant',
    status: 'complete',
    content: 'summary',
    compression: { id: 'actual-compression', trigger: 'automatic', status: 'completed' },
  };
  const { compression: _compression, ...withoutCompression } = original;
  const copy = { ...withoutCompression, id: 'copy-summary', sessionId: 'fork', runId: null };
  const runtime = {
    getMessageOrigin: async () => ({
      message: original,
      subjectId: 'owner',
      originStoreId: 'original-store',
    }),
  } as unknown as AgentRuntime;
  expect((await messageResponses(runtime, [copy], 'current-store', 'owner'))[0]).toMatchObject({
    compression: original.compression,
    originMessage: {
      storeId: 'original-store',
      sessionId: 'source',
      messageId: original.id,
      runId: original.runId,
    },
  });
});
