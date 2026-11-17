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

test('pending attachment IPC admits metadata only and closes preparation scope', () => {
  const item = { id: 'image', kind: 'image' as const, name: 'picture.png' };
  const write = {
    method: 'input.attachments.write' as const,
    generation: 1,
    sessionId: 'session',
    revision: 0,
    attachments: [item],
  };
  expect(decodeNativeRequest(write)).toEqual(write);
  for (const extra of [
    { path: '/private/file' },
    { chunks: [new Uint8Array([1])] },
    { data: 'YQ==' },
    { bytes: [1] },
  ]) {
    expect(() => decodeNativeRequest({ ...write, attachments: [{ ...item, ...extra }] })).toThrow(
      'invalid_native_request',
    );
  }
  expect(() => decodeNativeRequest({ ...write, attachments: [item, item] })).toThrow(
    'invalid_native_request',
  );
  expect(() => decodeNativeRequest({ ...write, sessionId: 'new-conversation' })).toThrow(
    'invalid_native_request',
  );
  expect(
    decodeNativeRequest({ ...write, sessionId: 'new-conversation', workspaceId: 'workspace' }),
  ).toMatchObject({ workspaceId: 'workspace' });
  expect(() => decodeNativeRequest({ ...write, revision: -1 })).toThrow('invalid_native_request');
  const send = {
    method: 'conversation.send',
    generation: 1,
    creation: {
      expectedStoreId: 'store',
      workspaceId: 'workspace',
      sessionId: 'new-session',
      commandId: 'create',
      title: 'new',
    },
    intent: { kind: 'run.start', expectedStoreId: 'store', commandId: 'send', content: 'hello' },
    attachmentRevision: 1,
    attachmentSessionId: 'new-session',
  };
  expect(decodeNativeRequest(send)).toMatchObject({ attachmentSessionId: 'new-session' });
  expect(() => decodeNativeRequest({ ...send, attachmentSessionId: 'another-session' })).toThrow(
    'invalid_native_request',
  );
  expect(() => decodeNativeRequest({ ...send, attachmentRevision: undefined })).toThrow(
    'invalid_native_request',
  );
});
