import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentClient, ModelOutputSnapshot } from '@kite-ai/client';
import { type ModelOutputViewScope, NativeModelOutputReads } from '../electron/model-output-reads';
import { decodeNativeRequest } from '../electron/native-ipc';
import type { NativeBridge, NativeRequest } from '../src/native-bridge';
import { readNativeModelOutput } from '../src/native-model-output';

function snapshot(content: string): ModelOutputSnapshot {
  const output = { complete: true, content, reasoning: '', toolCalls: [] };
  const body = JSON.stringify(output);
  return {
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
    contentBytes: String(Buffer.byteLength(content)),
    reasoningBytes: '0',
    snapshotCursor: '1',
    output,
  };
}
async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}
function fixture(value: ModelOutputSnapshot) {
  let scope: ModelOutputViewScope | undefined = {
    generation: 1,
    selection: 1,
    storeId: 'store',
    sessionId: 's',
  };
  let reads = 0;
  const port = {
    serverInfo: { storeId: 'store', capabilities: ['model_outputs'] },
    async getModelOutput(
      sessionId: string,
      executionId: string,
      options: { expectedStoreId: string; signal: AbortSignal },
    ) {
      reads++;
      expect([sessionId, executionId, options.expectedStoreId]).toEqual(['s', 'e', 'store']);
      return value;
    },
  } as unknown as AgentClient;
  const main = new NativeModelOutputReads(port, () => scope);
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request: NativeRequest) {
      decodeNativeRequest(request);
      if (request.method === 'modelOutput.open') return main.open(request);
      if (request.method === 'modelOutput.read') return main.read(request);
      if (request.method === 'modelOutput.close') {
        main.close(request.readId);
        return null;
      }
      throw Error('unexpected_command');
    },
  };
  return {
    main,
    bridge,
    get reads() {
      return reads;
    },
    switchView() {
      scope = { generation: 2, selection: 2, storeId: 'store', sessionId: 'other' };
      main.release();
    },
  };
}
test('finite main lease transfers a verified >17MiB UTF-8 snapshot through at-most64KiB chunks and releases only the view', async () => {
  const full = `${'large λ '.repeat(2300000)}COMPLETE TAIL`;
  expect(Buffer.byteLength(full)).toBeGreaterThan(17 * 1048576);
  const value = snapshot(full),
    f = fixture(value);
  let max = 0,
    chunks = 0;
  const bridge: NativeBridge = {
    watch: f.bridge.watch,
    async request(input) {
      const result = await f.bridge.request(input);
      if (result && 'readId' in result && result.kind === 'modelOutput.chunk') {
        max = Math.max(max, Buffer.from(result.data, 'base64').length);
        chunks++;
      }
      return result;
    },
  };
  const complete = await readNativeModelOutput({
    bridge,
    generation: 1,
    expectedStoreId: 'store',
    sessionId: 's',
    executionId: 'e',
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(complete.output.content).toBe(full);
  expect(complete.bodyHash).toBe(value.bodyHash);
  expect(f.reads).toBe(1);
  expect(max).toBeLessThanOrEqual(65536);
  expect(chunks).toBeGreaterThan(200);
  expect(() => f.main.read({ readId: 'old', offset: 0, limit: 1 })).toThrow(
    'model_output_read_missing',
  );
  const second = await f.main.open({
    readId: 'next',
    expectedStoreId: 'store',
    sessionId: 's',
    executionId: 'e',
  });
  expect(second.readId).toBe('next');
  f.main.release();
}, 15000);
test('closed chunk requests, sequential offset, exact identity and late selection reject locally without new SDK I/O', async () => {
  const f = fixture(snapshot('body'));
  expect(() =>
    decodeNativeRequest({
      method: 'modelOutput.read',
      generation: 1,
      readId: 'x',
      offset: 0,
      limit: 65537,
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'modelOutput.open',
      generation: 1,
      readId: 'x',
      sessionId: 's',
      executionId: 'e',
      expectedStoreId: 'store',
      token: 'secret',
    }),
  ).toThrow('invalid_native_request');
  expect(
    await errorCode(
      f.main.open({ readId: 'x', expectedStoreId: 'foreign', sessionId: 's', executionId: 'e' }),
    ),
  ).toBe('store_identity_mismatch');
  expect(f.reads).toBe(0);
  await f.main.open({ readId: 'x', expectedStoreId: 'store', sessionId: 's', executionId: 'e' });
  expect(() => f.main.read({ readId: 'x', offset: 1, limit: 1 })).toThrow(
    'model_output_offset_invalid',
  );
  const chunk = f.main.read({ readId: 'x', offset: 0, limit: 1 });
  expect(chunk.nextOffset).toBe(1);
  expect(() => f.main.read({ readId: 'x', offset: 0, limit: 1 })).toThrow(
    'model_output_offset_invalid',
  );
  f.switchView();
  expect(() => f.main.read({ readId: 'x', offset: 1, limit: 1 })).toThrow(
    'model_output_read_missing',
  );
  expect(f.reads).toBe(1);
});
test('abort during SDK open prevents a late body lease; malicious transport offsets/hash fail and close only the original read', async () => {
  let release!: (value: ModelOutputSnapshot) => void,
    entered!: () => void,
    signal: AbortSignal | undefined;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const port = {
    serverInfo: { capabilities: ['model_outputs'] },
    getModelOutput: (_s: string, _e: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      entered();
      return new Promise<ModelOutputSnapshot>((r) => {
        release = r;
      });
    },
  } as unknown as AgentClient;
  const main = new NativeModelOutputReads(port, () => ({
    generation: 1,
    selection: 1,
    storeId: 'store',
    sessionId: 's',
  }));
  const open = main.open({
    readId: 'opening',
    expectedStoreId: 'store',
    sessionId: 's',
    executionId: 'e',
  });
  await waiting;
  main.close('opening');
  expect(signal?.aborted).toBe(true);
  release(snapshot('late'));
  expect(await errorCode(open)).toBe('model_output_view_changed');
  expect(() => main.read({ readId: 'opening', offset: 0, limit: 1 })).toThrow(
    'model_output_read_missing',
  );
  for (const corruption of ['offset', 'hash', 'utf8'] as const) {
    const value = snapshot('body'),
      f = fixture(value);
    let closed = 0;
    const bridge: NativeBridge = {
      watch: f.bridge.watch,
      async request(input) {
        if (input.method === 'modelOutput.close') closed++;
        const result = await f.bridge.request(input);
        if (
          result &&
          'readId' in result &&
          result.kind === 'modelOutput.chunk' &&
          corruption === 'offset'
        )
          return { ...result, offset: result.offset + 1 };
        if (
          result &&
          'readId' in result &&
          result.kind === 'modelOutput.chunk' &&
          corruption === 'utf8'
        ) {
          const bytes = Buffer.from(result.data, 'base64');
          bytes[0] = 255;
          return { ...result, data: bytes.toString('base64') };
        }
        if (
          result &&
          'readId' in result &&
          result.kind === 'modelOutput.opened' &&
          corruption === 'hash'
        )
          return { ...result, bodyHash: '0'.repeat(64) };
        return result;
      },
    };
    expect(
      await errorCode(
        readNativeModelOutput({
          bridge,
          generation: 1,
          expectedStoreId: 'store',
          sessionId: 's',
          executionId: 'e',
          signal: new AbortController().signal,
          isCurrent: () => true,
        }),
      ),
    ).toBe(
      corruption === 'offset'
        ? 'model_output_chunk_invalid'
        : corruption === 'hash'
          ? 'model_output_identity_mismatch'
          : 'model_output_invalid_body',
    );
    expect(closed).toBe(1);
    expect(f.reads).toBe(1);
  }
});
