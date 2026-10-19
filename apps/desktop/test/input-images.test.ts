import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentClient, InputImage } from '@kite-ai/client';
import { NativeInputImages } from '../electron/input-images';

test('Native staging checks chunks and digest, publishes exact bytes once per session, and releases removed drafts', async () => {
  const stage = new NativeInputImages(),
    bytes = Buffer.from('user-delivered-image');
  const hash = createHash('sha256').update(bytes).digest('hex');
  stage.begin({
    id: 'image',
    name: 'pasted.png',
    mediaType: 'image/png',
    hash,
    size: bytes.length,
  });
  expect(() => stage.append('image', 1, bytes.toString('base64'))).toThrow(
    'native_image_chunk_invalid',
  );
  expect(() => stage.finish('image')).toThrow('native_image_incomplete');
  stage.append('image', 0, bytes.toString('base64'));
  stage.finish('image');
  const uploads: unknown[] = [];
  const client = {
    uploadInputImage: async (sessionId: string, input: unknown) => {
      uploads.push({ sessionId, input });
      return { name: 'pasted.png', reference: { id: 'ref' } } as InputImage;
    },
  } as unknown as AgentClient;
  await expect(
    stage.publish(
      client,
      'store',
      'original-session',
      Array.from({ length: 11 }, (_, index) => String(index)),
    ),
  ).rejects.toThrow('native_image_invalid');
  expect(uploads).toEqual([]);
  await stage.publish(client, 'store', 'original-session', ['image']);
  await stage.publish(client, 'store', 'original-session', ['image']);
  expect(uploads).toEqual([
    {
      sessionId: 'original-session',
      input: {
        expectedStoreId: 'store',
        id: 'image-original-session',
        name: 'pasted.png',
        mediaType: 'image/png',
        data: bytes.toString('base64'),
      },
    },
  ]);
  stage.release('image');
  await expect(stage.publish(client, 'store', 'original-session', ['image'])).rejects.toThrow(
    'native_image_missing',
  );
  stage.begin({
    id: 'corrupt',
    name: 'bad.png',
    mediaType: 'image/png',
    hash: 'f'.repeat(64),
    size: bytes.length,
  });
  stage.append('corrupt', 0, bytes.toString('base64'));
  expect(() => stage.finish('corrupt')).toThrow('native_image_hash_mismatch');
  await stage.close();
  expect(() =>
    stage.begin({ id: 'closed', name: 'x', mediaType: 'image/png', hash, size: 1 }),
  ).toThrow();
});

test('Main bounds the total number of staged images independently of their byte size', async () => {
  const stage = new NativeInputImages();
  const image = {
    name: 'tiny.png',
    mediaType: 'image/png' as const,
    hash: 'a'.repeat(64),
    size: 1,
  };
  for (let index = 0; index < 128; index++) stage.begin({ ...image, id: String(index) });
  expect(() => stage.begin({ ...image, id: 'overflow' })).toThrow(
    'native_image_budget_unavailable',
  );
  stage.release('0');
  expect(() => stage.begin({ ...image, id: 'replacement' })).not.toThrow();
  await stage.close();
});
