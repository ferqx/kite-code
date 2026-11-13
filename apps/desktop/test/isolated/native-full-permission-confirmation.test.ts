import { expect, test } from '#kite-test';
import type {
  NativeFullPermissionConfirmationRequest,
  NativeWindowBridge,
} from '../../src/native-bridge';
import { confirmNativeFullPermission } from '../../src/native-full-permission-confirmation';

function fixture() {
  const requests: NativeFullPermissionConfirmationRequest[] = [],
    cancelled: string[] = [];
  let resolve!: (value: boolean) => void, reject!: (error: Error) => void;
  const host: Partial<NativeWindowBridge> = {
    confirmFullPermission(request) {
      requests.push(request);
      return new Promise<boolean>((done, fail) => {
        resolve = done;
        reject = fail;
      });
    },
    cancelFullPermissionConfirmation(id) {
      cancelled.push(id);
    },
  };
  const controller = new AbortController();
  return {
    host,
    controller,
    requests,
    cancelled,
    run: () => confirmNativeFullPermission(host, { language: 'zh', signal: controller.signal }),
    resolve: (value: boolean) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}

test('native confirmation requires both host ports and never assumes permission from an unavailable host', async () => {
  const signal = new AbortController().signal;
  await expect(confirmNativeFullPermission({}, { language: 'en', signal })).rejects.toThrow(
    'native_full_permission_confirmation_unavailable',
  );
  const f = fixture();
  delete f.host.cancelFullPermissionConfirmation;
  await expect(f.run()).rejects.toThrow('native_full_permission_confirmation_unavailable');
  expect(f.requests).toHaveLength(0);
});

test('an already retired confirmation never opens a native dialog', async () => {
  const f = fixture();
  f.controller.abort();
  expect(await f.run()).toBe(false);
  expect(f.requests).toEqual([]);
  expect(f.cancelled).toEqual([]);
});

for (const decision of [false, true])
  test(`native decision ${decision} returns once and releases its cancellation listener`, async () => {
    const f = fixture();
    const result = f.run();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ language: 'zh' });
    expect(f.requests[0]!.requestId).toMatch(/^full-permission-[a-z0-9]+-[0-9]+$/);
    f.resolve(decision);
    expect(await result).toBe(decision);
    f.controller.abort();
    expect(f.cancelled).toEqual([]);
  });

test('retirement cancels only its own native request and a late positive cannot revive it', async () => {
  const f = fixture(),
    next = fixture();
  const old = f.run(),
    current = next.run();
  expect(f.requests[0]!.requestId).not.toBe(next.requests[0]!.requestId);
  f.controller.abort();
  expect(await old).toBe(false);
  expect(f.cancelled).toEqual([f.requests[0]!.requestId]);
  expect(next.cancelled).toEqual([]);
  f.resolve(true);
  next.resolve(true);
  expect(await current).toBe(true);
  expect(await old).toBe(false);
});

test('a failing native host stays a failure while current and cannot become approval', async () => {
  const f = fixture();
  const result = f.run();
  f.reject(Error('native_full_permission_confirmation_failed'));
  await expect(result).rejects.toThrow('native_full_permission_confirmation_failed');
  f.controller.abort();
  expect(f.cancelled).toEqual([]);
});

test('a closed cancellation transport still retires the caller without accepting a late decision', async () => {
  const f = fixture();
  f.host.cancelFullPermissionConfirmation = () => {
    throw Error('renderer_gone');
  };
  const result = f.run();
  f.controller.abort();
  expect(await result).toBe(false);
  f.resolve(true);
  expect(await result).toBe(false);
});
