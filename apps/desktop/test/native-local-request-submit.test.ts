import { expect, test } from 'bun:test';
import type { NativeBridge, NativeRequest, NativeSelection } from '../src/native-bridge';
import { submitLocalOfficeRequest } from '../src/native-local-request-submit';

const selection = {
  storeId: 'store',
  session: { id: 'session' },
  runs: [],
} as unknown as NativeSelection;
test('local renderer sends opaque context once and reports unknown without retrying', async () => {
  const requests: NativeRequest[] = [];
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      throw Error('reply_lost');
    },
  } as unknown as NativeBridge;
  const result = await submitLocalOfficeRequest({
    bridge,
    generation: 1,
    selection,
    request: { handleId: 'handle', previewId: 'preview', requestId: 'request' },
    isCurrent: () => true,
    modelReady: true,
  });
  expect(result.status).toBe('unknown');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe('localPreview.submit');
  expect(requests[0]).not.toHaveProperty('path');
  expect(requests[0]).not.toHaveProperty('selection');
  expect(requests[0]).not.toHaveProperty('fileIds');
});
test('local annotation rejects stale session/model before any IPC and accepts journal receipt', async () => {
  let calls = 0;
  const bridge = {
    request: async () => {
      calls++;
      return { phase: 'accepted' };
    },
  } as unknown as NativeBridge;
  const options = {
    bridge,
    generation: 1,
    selection,
    request: { handleId: 'handle', previewId: 'preview', requestId: 'request' },
    isCurrent: () => false,
    modelReady: true,
  };
  expect((await submitLocalOfficeRequest(options)).status).toBe('failed');
  expect(
    (await submitLocalOfficeRequest({ ...options, isCurrent: () => true, modelReady: false }))
      .status,
  ).toBe('failed');
  expect(calls).toBe(0);
  expect((await submitLocalOfficeRequest({ ...options, isCurrent: () => true })).status).toBe(
    'accepted',
  );
  expect(calls).toBe(1);
});

test('explicit pre-dispatch source refusal is failed, but duplicate ownership remains unknown', async () => {
  for (const [code, status] of [
    ['local_preview_changed', 'failed'],
    ['local_preview_request_submitted', 'unknown'],
  ] as const) {
    const bridge = {
      request: async () => {
        throw Object.assign(Error(code), { code });
      },
    } as unknown as NativeBridge;
    expect(
      (
        await submitLocalOfficeRequest({
          bridge,
          generation: 1,
          selection,
          request: { handleId: 'handle', previewId: 'preview', requestId: 'request' },
          isCurrent: () => true,
          modelReady: true,
        })
      ).status,
    ).toBe(status);
  }
});
