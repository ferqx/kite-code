import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentClient } from '@kite-ai/client';
import { NativeInputFiles } from '../../electron/input-files';
import { decodeNativeRequest } from '../../electron/native-ipc';
import { saveOutputFile } from '../../electron/output-files';

const target = {
  storeId: 'store',
  sessionId: 'session',
  fileId: 'file',
  locator: { kind: 'delivery' as const, key: 'delivery/00000000000000000001/job/file' },
};
test('output IPC accepts exact locators and rejects paths, fake references and malformed geometry', () => {
  expect(
    decodeNativeRequest({
      method: 'outputs.query',
      generation: 1,
      scope: { storeId: 'store', sessionId: 'session' },
      collectionBeforeKey: 'collection-cursor',
    }),
  ).toMatchObject({ collectionBeforeKey: 'collection-cursor' });
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.query',
      generation: 1,
      scope: { storeId: 'store', sessionId: 'session' },
      collectionBeforeKey: 5,
    }),
  ).toThrow();

  expect(decodeNativeRequest({ method: 'outputs.info', generation: 1, target })).toEqual({
    method: 'outputs.info',
    generation: 1,
    target,
  });
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.save',
      generation: 1,
      target: { ...target, path: '/etc/passwd' },
    }),
  ).toThrow();
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.save',
      generation: 1,
      target: { ...target, locator: { kind: 'delivery', key: 'x', reference: { hash: 'x' } } },
    }),
  ).toThrow();
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.preview.open',
      generation: 1,
      previewId: 'view',
      target,
      bounds: { x: 0, y: 0, width: -1, height: 100 },
    }),
  ).toThrow();
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.query',
      generation: 1,
      scope: { storeId: 'store', sessionId: 'session' },
      limit: 51,
    }),
  ).toThrow();
});
test('save streams chunks, commits only verified EOF and preserves prior destination on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-output-save-test-'));
  const destination = join(root, 'saved.bin');
  const bytes = Buffer.alloc(3 * 1024 * 1024, 17);
  let cancelled = 0;
  function client(bad = false) {
    return {
      async readOutputFileStream() {
        return {
          reference: {
            hash: bad ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
            size: String(bytes.length),
          },
          content: (async function* () {
            for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536);
          })(),
          async cancel() {
            cancelled++;
          },
        };
      },
    } as unknown as AgentClient;
  }
  try {
    await saveOutputFile(client(), target, destination, () => {});
    expect(await readFile(destination)).toEqual(bytes);
    expect(cancelled).toBe(1);
    await writeFile(destination, 'keep original');
    await expect(saveOutputFile(client(true), target, destination, () => {})).rejects.toThrow(
      'output_file_integrity_failed',
    );
    expect(await readFile(destination, 'utf8')).toBe('keep original');
    expect(await readdir(root)).toEqual(['saved.bin']);
    expect(cancelled).toBe(2);
    let calls = 0;
    await expect(
      saveOutputFile(client(), target, destination, () => {
        if (++calls === 4) throw Error('scope_changed');
      }),
    ).rejects.toThrow('scope_changed');
    expect(await readFile(destination, 'utf8')).toBe('keep original');
    expect(await readdir(root)).toEqual(['saved.bin']);
    expect(cancelled).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('reference preparation is lazy, stable per chip and rejects identity replacement', async () => {
  const owner = new NativeInputFiles();
  let calls = 0;
  let imported: unknown;
  const reference = { name: 'report.docx', uri: 'input-file:stable' };
  const client = {
    async prepareInputFromOutput(input: unknown) {
      calls++;
      imported = input;
      return reference;
    },
  } as unknown as AgentClient;
  owner.fromOutput('chip', target, 'report.docx');
  expect(calls).toBe(0);
  owner.fromOutput('chip', target, 'report.docx');
  expect(() => owner.fromOutput('chip', { ...target, fileId: 'different' }, 'report.docx')).toThrow(
    'native_file_invalid',
  );
  expect(await owner.publish(client, 'store', 'session', ['chip'])).toEqual([reference]);
  expect(await owner.publish(client, 'store', 'session', ['chip'])).toEqual([reference]);
  expect(calls).toBe(1);
  expect(imported).toMatchObject({
    source: target,
    expectedStoreId: 'store',
    targetSessionId: 'session',
    preparationId: 'chip',
  });
  await owner.close();
});
