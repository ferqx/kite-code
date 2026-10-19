import { expect, test } from 'bun:test';
import { decodeNativeRequest } from '../electron/native-ipc';

test('image IPC accepts bounded chunks and image-only staged inputs, rejects paths and renderer references', () => {
  const begin = {
    method: 'input.images.begin' as const,
    generation: 1,
    id: 'image',
    name: 'pasted.png',
    mediaType: 'image/png' as const,
    size: 100,
    hash: 'a'.repeat(64),
  };
  expect(decodeNativeRequest(begin)).toEqual(begin);
  for (const input of [
    { ...begin, path: 'C:/private' },
    { ...begin, size: 16 * 1024 * 1024 + 1 },
    { ...begin, mediaType: 'application/pdf' },
    { ...begin, hash: 'forged' },
    { method: 'input.files.pick', generation: 1, path: 'C:/private' },
  ])
    expect(() => decodeNativeRequest(input)).toThrow('invalid_native_request');
  const intent = {
    kind: 'input.steer',
    expectedStoreId: 'store',
    commandId: 'command',
    targetRunId: 'run',
    contextSelectionId: 'selection',
    content: '',
  };
  expect(
    decodeNativeRequest({
      method: 'submit',
      generation: 1,
      sessionId: 's',
      intent,
      imageIds: ['image'],
    }),
  ).toMatchObject({ imageIds: ['image'] });
  expect(() =>
    decodeNativeRequest({ method: 'submit', generation: 1, sessionId: 's', intent }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'submit',
      generation: 1,
      sessionId: 's',
      intent,
      imageIds: Array.from({ length: 11 }, (_, index) => String(index)),
    }),
  ).toThrow('invalid_native_request');
  expect(
    decodeNativeRequest({
      method: 'submit',
      generation: 1,
      sessionId: 's',
      intent: { ...intent, files: [{ name: 'outside.ini', uri: 'file:///E:/outside.ini' }] },
    }),
  ).toMatchObject({ intent: { files: [{ name: 'outside.ini', uri: 'file:///E:/outside.ini' }] } });
  expect(() =>
    decodeNativeRequest({
      method: 'input.image.open',
      generation: 1,
      readId: 'read',
      viewSelection: 1,
      historyEpoch: 2,
      messageId: 'message',
      index: 0,
      reference: { id: 'forged' },
    }),
  ).toThrow('invalid_native_request');
});
