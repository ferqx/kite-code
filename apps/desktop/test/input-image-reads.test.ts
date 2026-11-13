import type { AgentClient, Execution, Message } from '@kite-ai/client';
import { expect, test } from '#kite-test';
import { NativeInputImageReads } from '../electron/input-image-reads';
import { nativeToolImages } from '../electron/tool-images';
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

for (const kind of ['pdf', 'local', 'batch'] as const)
  test(`${kind} preview uses the observed original tool receipt across Fork and rejects a forged image scope`, async () => {
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
    const content = JSON.stringify(
      kind === 'pdf'
        ? { pages: [{ number: 7 }] }
        : kind === 'batch'
          ? {
              images: Array.from({ length: 10 }, (_, i) => ({
                path: `C:/workspace/picture-${i}.png`,
              })),
            }
          : { path: 'C:/workspace/picture.png' },
    );
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
    const references =
      kind === 'batch'
        ? Array.from({ length: 10 }, (_, i) => ({ ...ref, id: `image-${i}` }))
        : [ref];
    const execution = {
      id: 'execution',
      originStoreId: 'original',
      sessionId: 'source',
      runId: 'run',
      kind: 'tool',
      definitionId: kind === 'pdf' ? 'files.read' : 'files.view_images',
      definitionVersion: kind === 'pdf' ? '5' : '1',
      status: 'succeeded',
      resultRevision: '1',
      result: { outcome: 'succeeded', content, artifactRefs: references, modelImages: references },
    } as unknown as Execution;
    let reads = 0;
    const client = {
      getExecution: async () => execution,
      readArtifact: async (sessionId: string, input: unknown) => {
        reads++;
        expect(sessionId).toBe('source');
        expect(input).toEqual({
          expectedStoreId: 'current',
          refId: references.at(-1)!.id,
          scope: ref.scope,
        });
        return {
          content: new Uint8Array([1, 2, 3]),
          reference: { ...references.at(-1)!, hash: 'a'.repeat(64), storeId: 'original' },
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
      index: references.length - 1,
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

test('Native local receipts enforce ten images, matching names, per-image bytes and the shared batch budget', () => {
  const refs = Array.from({ length: 10 }, (_, i) => ({
    id: `image-${i}`,
    scope: { kind: 'execution', id: 'e' },
    mediaType: 'image/png',
    size: '10',
  }));
  const content = JSON.stringify({ images: refs.map((_, i) => ({ path: `${i}.png` })) });
  const execution = {
    id: 'e',
    definitionId: 'files.view_images',
    definitionVersion: '1',
    status: 'succeeded',
    result: { outcome: 'succeeded', content, artifactRefs: refs, modelImages: refs },
  } as unknown as Execution;
  expect(nativeToolImages(execution).map((image) => image.name)).toEqual(
    refs.map((_, i) => `${i}.png`),
  );
  const check = (images: unknown[], body = content) =>
    nativeToolImages({
      ...execution,
      result: { outcome: 'succeeded', content: body, artifactRefs: images, modelImages: images },
    } as unknown as Execution);
  expect(() => check([...refs, refs[0]])).toThrow('tool_images_invalid');
  expect(() => check(refs.slice(0, 9))).toThrow('tool_images_invalid');
  expect(() => check(refs.map((ref) => ({ ...ref, size: String(2 * 1024 * 1024) })))).toThrow(
    'tool_images_invalid',
  );
  expect(() =>
    check([{ ...refs[0], size: String(8 * 1024 * 1024 + 1) }], JSON.stringify({ path: 'a.png' })),
  ).toThrow('tool_images_invalid');
  expect(
    check(
      refs.slice(0, 2).map((ref) => ({ ...ref, size: String(8 * 1024 * 1024) })),
      JSON.stringify({ images: [{ path: 'a' }, { path: 'b' }] }),
    ),
  ).toHaveLength(2);
});
