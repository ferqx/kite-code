import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AgentClient,
  ClientError,
  type InputFileImport,
  type InputFileUploadQuery,
} from '@kite-ai/client';
import { NativeInputFiles } from '../electron/input-files';
import { decodeNativeRequest } from '../electron/native-ipc';

test('Native staged file bytes are independent, streamed and recovered by original import after a lost ACK', async () => {
  const files = new NativeInputFiles();
  const original = Buffer.from('独立原件\n完整正文');
  const expected = Buffer.from(original);
  files.begin({ id: 'file', name: '附件.txt', mediaType: 'text/plain', size: original.length });
  expect(() => files.finish('file')).toThrow('native_file_incomplete');
  files.append('file', 0, original);
  original.fill(0);
  files.finish('file');
  let captured: InputFileImport | undefined;
  let uploads = 0,
    lookups = 0;
  const client = {
    async getInputFileImport() {
      lookups++;
      if (!captured) throw new ClientError('input_file_not_found');
      return captured;
    },
    async uploadInputFile(
      sessionId: string,
      input: InputFileUploadQuery,
      content: ReadableStream<Uint8Array>,
    ) {
      uploads++;
      const bytes = new Uint8Array(await new Response(content).arrayBuffer());
      expect(Buffer.from(bytes)).toEqual(expected);
      expect(input.hash).toBe(createHash('sha256').update(expected).digest('hex'));
      captured = {
        id: input.id,
        name: input.name,
        uri: 'file:///saved',
        state: 'prepared',
        originStoreId: 'store',
        sessionId,
        subjectId: 'owner',
        createdAt: 1,
        boundCommandId: null,
        reference: {
          id: `input-file-${input.id}`,
          storeId: 'store',
          sessionId,
          subjectId: 'owner',
          scope: { kind: 'session', id: sessionId },
          hash: input.hash,
          size: input.size,
          mediaType: input.mediaType,
        },
      };
      throw new ClientError('network_outcome_unknown');
    },
  } as unknown as AgentClient;
  try {
    let first: unknown;
    try {
      await files.publish(client, 'store', 'session', ['file']);
    } catch (error) {
      first = error;
    }
    expect(first).toMatchObject({ code: 'network_outcome_unknown' });
    const result = await files.publish(client, 'store', 'session', ['file']);
    expect(result[0]?.reference).toEqual(captured!.reference);
    expect(uploads).toBe(1);
    expect(lookups).toBe(2);
    files.release('file');
    let removed: unknown;
    try {
      await files.publish(client, 'store', 'session', ['file']);
    } catch (error) {
      removed = error;
    }
    expect(removed).toMatchObject({ code: 'native_file_missing' });
  } finally {
    await files.close();
  }
});

test('Native file IPC accepts only bounded byte chunks; release retains in-flight byte reservations', async () => {
  const bytes = new Uint8Array(65536);
  const decoded = decodeNativeRequest({
    method: 'input.files.append',
    generation: 1,
    id: 'x',
    offset: 0,
    data: bytes,
  });
  expect(decoded).toMatchObject({ data: bytes });
  expect(() =>
    decodeNativeRequest({
      method: 'input.files.append',
      generation: 1,
      id: 'x',
      offset: 0,
      data: new Uint8Array(65537),
    }),
  ).toThrow();
  expect(() =>
    decodeNativeRequest({
      method: 'input.files.begin',
      generation: 1,
      id: 'x',
      name: 'x',
      mediaType: 'text/plain',
      size: 1,
      path: '/private',
    }),
  ).toThrow();
  const files = new NativeInputFiles();
  files.begin({ id: 'x', name: 'x', mediaType: 'text/plain', size: 1 });
  files.append('x', 0, new Uint8Array([1]));
  files.finish('x');
  let reject!: (error: Error) => void;
  const lookup = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const client = { getInputFileImport: () => lookup } as unknown as AgentClient;
  const pending = files.publish(client, 'store', 'session', ['x']).catch(() => {});
  files.release('x');
  expect(() =>
    files.begin({
      id: 'large',
      name: 'large',
      mediaType: 'application/pdf',
      size: 256 * 1024 * 1024,
    }),
  ).toThrow('native_file_budget_unavailable');
  reject(new ClientError('connection_superseded'));
  await pending;
  expect(() =>
    files.begin({
      id: 'large',
      name: 'large',
      mediaType: 'application/pdf',
      size: 256 * 1024 * 1024,
    }),
  ).not.toThrow();
  await files.close();
});
