import { expect, test } from 'bun:test';
import type { AgentClient, Execution, Message } from '@kite-ai/client';
import { NativeInputImageReads } from '../electron/input-image-reads';
import type { NativeToolMessageScope } from '../src/tool-messages-bridge';

test('Native image reader accepts only an observed original user image and invalidates its bytes when the view changes', async () => {
  let scope = {
    generation: 1,
    storeId: 'store',
    sessionId: 's',
    viewSelection: 2,
    historyEpoch: 3,
  } as NativeToolMessageScope;
  const image = {
    name: 'original.png',
    reference: {
      id: 'ref',
      storeId: 'store',
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session' as const, id: 's' },
      hash: 'a'.repeat(64),
      size: '3',
      mediaType: 'image/png' as const,
    },
  };
  const messages = new Map([
    ['message', { id: 'message', role: 'user', status: 'complete', images: [image] } as Message],
  ]);
  const calls: unknown[] = [];
  const client = {
    async readArtifact(...args: unknown[]) {
      calls.push(args);
      return { content: new Uint8Array([1, 2, 3]), reference: image.reference };
    },
  } as unknown as AgentClient;
  const reads = new NativeInputImageReads(
    client,
    () => scope,
    () => messages,
  );
  const request = {
    method: 'input.image.open' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 3,
    readId: 'read',
    messageId: 'message',
    index: 0,
  };
  await expect(reads.open({ ...request, messageId: 'unobserved' })).rejects.toThrow(
    'input_image_view_changed',
  );
  expect(calls).toHaveLength(0);
  expect(await reads.open(request)).toMatchObject({ hash: image.reference.hash, size: 3 });
  expect(reads.read('read', 0)).toMatchObject({ data: 'AQID', nextOffset: 3, done: true });
  expect(calls[0]).toMatchObject([
    's',
    { expectedStoreId: 'store', refId: 'ref', scope: { kind: 'session', id: 's' } },
    { expectedReference: image.reference },
  ]);
  scope = { ...scope, viewSelection: 4 };
  expect(() => reads.read('read', 0)).toThrow('input_image_view_changed');
  await reads.closeAll();
});

test('PDF preview uses the observed original tool receipt across Fork and rejects a forged image scope', async () => {
  const scope = {
    generation: 1,
    storeId: 'current',
    sessionId: 'fork',
    viewSelection: 2,
    historyEpoch: 0,
  } as NativeToolMessageScope;
  const ref = {
    id: 'page-one',
    scope: { kind: 'execution' as const, id: 'execution' },
    mediaType: 'image/png',
    size: '3',
  };
  const content = JSON.stringify({ pages: [{ number: 7 }] });
  const message = {
    id: 'copied',
    sessionId: 'fork',
    runId: null,
    role: 'tool',
    status: 'complete',
    sourceIds: ['execution'],
    content,
    originMessage: {
      storeId: 'original',
      sessionId: 'source',
      runId: 'run',
      messageId: 'original-message',
    },
  } as Message;
  const execution = {
    id: 'execution',
    originStoreId: 'original',
    sessionId: 'source',
    runId: 'run',
    kind: 'tool',
    definitionId: 'files.read',
    definitionVersion: '5',
    status: 'succeeded',
    resultRevision: '1',
    result: { outcome: 'succeeded', content, artifactRefs: [ref], modelImages: [ref] },
  } as unknown as Execution;
  let reads = 0;
  const client = {
    getExecution: async () => execution,
    readArtifact: async (sessionId: string, input: unknown) => {
      reads++;
      expect(sessionId).toBe('source');
      expect(input).toEqual({ expectedStoreId: 'current', refId: ref.id, scope: ref.scope });
      return {
        content: new Uint8Array([1, 2, 3]),
        reference: { ...ref, hash: 'a'.repeat(64), storeId: 'original' },
      };
    },
  } as unknown as AgentClient;
  const reader = new NativeInputImageReads(
    client,
    () => scope,
    () => new Map([['copied', message]]),
  );
  const request = {
    method: 'input.image.open' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'pdf',
    messageId: 'copied',
    index: 0,
  };
  try {
    expect(await reader.open(request)).toMatchObject({ size: 3, mediaType: 'image/png' });
    expect(reader.read('pdf', 0)).toMatchObject({ data: 'AQID', done: true });
    reader.close('pdf');
    ref.scope.id = 'foreign-execution';
    await expect(reader.open({ ...request, readId: 'forged' })).rejects.toThrow(
      'tool_images_invalid',
    );
    expect(reads).toBe(1);
  } finally {
    await reader.closeAll();
  }
});
