import { expect, test } from 'bun:test';
import type { OutputFileSummary } from '@kite-ai/client';
import type { NativeBridge, NativeRequest, NativeSelection } from '../src/native-bridge';
import { submitOfficeRequest } from '../src/native-office-request-submit';

function fixture(phase = 'accepted') {
  const requests: NativeRequest[] = [];
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method === 'submit' && phase === 'throw') throw Error('lost');
      return { phase };
    },
  } as unknown as NativeBridge;
  const options = {
    bridge,
    generation: 7,
    selection: {
      storeId: 'store',
      session: { id: 'session' },
      runs: [],
    } as unknown as NativeSelection,
    file: {
      storeId: 'store',
      sessionId: 'session',
      fileId: 'file',
      locator: { kind: 'delivery', key: 'delivery/file' },
      name: 'deck.pptx',
      ownerRunId: 'run',
    } as unknown as OutputFileSummary,
    context: {
      sourceHash: 'a'.repeat(64),
      selection: {
        kind: 'powerpoint' as const,
        slide: 2,
        objectPath: '/shape/1',
        text: 'Original',
      },
    },
    prompt: 'Change this title',
    isCurrent: () => true,
    modelReady: true,
  };
  return { requests, options };
}
test('inline request imports only the original selected file and actually submits once', async () => {
  const { requests, options } = fixture();
  expect(await submitOfficeRequest(options)).toEqual({ status: 'accepted' });
  expect(requests.map((r) => r.method)).toEqual([
    'input.files.fromOutput',
    'submit',
    'input.files.release',
  ]);
  const sent = requests[1];
  const prepared = requests[0];
  if (sent?.method !== 'submit' || prepared?.method !== 'input.files.fromOutput')
    throw Error('unexpected Office request sequence');
  if (!sent.officeDocument?.outputFiles?.[0]) throw Error('missing Office document');
  expect(sent.fileIds).toEqual([prepared.id]);
  expect(sent.officeDocument.outputFiles[0].context).toEqual(options.context);
  expect(sent.intent.content).toContain('Change this title');
  expect(sent.intent.kind).toBe('run.start');
  expect(sent.draft).toBeUndefined();
  expect(requests[2]).toEqual({ method: 'input.files.release', generation: 7, id: prepared.id });
});
test('transport ambiguity never retries', async () => {
  const { requests, options } = fixture('throw');
  expect((await submitOfficeRequest(options)).status).toBe('unknown');
  expect(requests.filter((r) => r.method === 'submit')).toHaveLength(1);
  const prepared = requests[0];
  if (prepared?.method !== 'input.files.fromOutput') throw Error('missing Office preparation');
  expect(requests.at(-1)).toEqual({
    method: 'input.files.release',
    generation: 7,
    id: prepared.id,
  });
});
test('stale scope and missing model prevent any send', async () => {
  const { requests, options } = fixture();
  expect((await submitOfficeRequest({ ...options, isCurrent: () => false })).status).toBe('failed');
  expect((await submitOfficeRequest({ ...options, modelReady: false })).status).toBe('failed');
  expect(requests).toHaveLength(0);
});
test('selection change after import prevents dispatch', async () => {
  const { requests, options } = fixture();
  expect(
    (
      await submitOfficeRequest({
        ...options,
        isCurrent: () => requests.length === 0,
      })
    ).status,
  ).toBe('failed');
  expect(requests.map((r) => r.method)).toEqual(['input.files.fromOutput', 'input.files.release']);
});

test('uncertain preparation still releases only its temporary staging id', async () => {
  const { requests, options } = fixture();
  options.bridge.request = async (request: NativeRequest) => {
    requests.push(request);
    if (request.method === 'input.files.fromOutput') throw Error('lost preparation response');
    return null;
  };
  expect((await submitOfficeRequest(options)).status).toBe('failed');
  expect(requests.map((r) => r.method)).toEqual(['input.files.fromOutput', 'input.files.release']);
  const prepared = requests[0],
    released = requests[1];
  if (prepared?.method !== 'input.files.fromOutput' || released?.method !== 'input.files.release')
    throw Error('unexpected Office cleanup sequence');
  expect(released.id).toBe(prepared.id);
});
