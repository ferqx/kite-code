import { expect, test } from 'bun:test';
import { decodeNativeRequest } from '../electron/native-ipc';

test('local preview IPC accepts only opaque handle and bounded rectangle, never path/output authority', () => {
  const valid = {
    method: 'localPreview.open' as const,
    generation: 1,
    handleId: 'handle-1',
    previewId: 'view-1',
    bounds: { x: 0.5, y: 2, width: 0, height: 100 },
  };
  expect(decodeNativeRequest(valid)).toEqual(valid);
  for (const bad of [
    { ...valid, path: '/private/file' },
    { ...valid, target: { storeId: 's', sessionId: 's', fileId: 'f', locator: 'l' } },
    { ...valid, handleId: '../file' },
    { ...valid, bounds: { ...valid.bounds, width: -1 } },
    { ...valid, bounds: { ...valid.bounds, width: Infinity } },
    { ...valid, bounds: { ...valid.bounds, width: 16385 } },
  ])
    expect(() => decodeNativeRequest(bad)).toThrow();
  expect(
    decodeNativeRequest({ method: 'localPreview.check', generation: 1, handleId: 'handle-1' })
      .method,
  ).toBe('localPreview.check');
});

test('local PDF submit cannot carry renderer path, selection, or attachments', () => {
  const valid = {
    method: 'localPreview.submit' as const,
    generation: 1,
    handleId: 'handle-1',
    previewId: 'view-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    intent: {
      kind: 'run.start' as const,
      expectedStoreId: 'store',
      commandId: 'command-1',
      content: 'ignored',
    },
  };
  expect(decodeNativeRequest(valid)).toEqual(valid);
  for (const bad of [
    { ...valid, path: '/private/file' },
    { ...valid, selection: { kind: 'pdf' } },
    { ...valid, intent: { ...valid.intent, files: [] } },
    { ...valid, intent: { ...valid.intent, images: [] } },
    { ...valid, requestId: '../invalid' },
    { ...valid, handleId: '../invalid' },
    { ...valid, intent: { ...valid.intent, kind: 'run.cancel' } },
  ])
    expect(() => decodeNativeRequest(bad)).toThrow();
  expect(
    decodeNativeRequest({
      method: 'localPreview.interaction',
      generation: 1,
      handleId: 'handle-1',
      previewId: 'view-1',
      consumeRequest: false,
    }).method,
  ).toBe('localPreview.interaction');
});
