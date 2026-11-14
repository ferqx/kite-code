import { expect, test } from 'bun:test';
import { canonicalCallerCommandRequest } from '@kite-ai/client';
import { decodeNativeRequest } from '../../electron/native-ipc';
import { nativeInputFileIntent } from '../../src/native-input-file-intent';

test('new and restored output chips and uploaded prepared files cross IPC only as host IDs', () => {
  const intent = {
    kind: 'run.start' as const,
    expectedStoreId: 'store',
    commandId: 'command',
    content: 'Modify the attached report.',
  };
  for (const file of [
    { name: 'report.docx · 基于轮次 c88d1403', uri: 'output-file:source', prepared: true },
    { name: 'report.docx · 基于轮次 c88d1403', uri: 'output-file:restored', prepared: true },
    { name: 'uploaded.txt', uri: 'prepared-file:upload', prepared: true },
  ]) {
    expect(() =>
      canonicalCallerCommandRequest({ ...intent, files: [{ name: file.name, uri: file.uri }] }),
    ).toThrow();
    const safe = { ...intent, ...nativeInputFileIntent([file]) };
    expect(safe).not.toHaveProperty('files');
    const envelope = {
      method: 'submit',
      generation: 1,
      sessionId: 'session',
      fileIds: ['prepared-id'],
    };
    expect(() =>
      decodeNativeRequest({
        ...envelope,
        intent: { ...intent, files: [{ name: file.name, uri: file.uri }] },
      }),
    ).toThrow('invalid_native_request');
    expect(decodeNativeRequest({ ...envelope, intent: safe })).toMatchObject({
      fileIds: ['prepared-id'],
    });
    expect(() =>
      decodeNativeRequest({
        ...envelope,
        intent: {
          ...safe,
          kind: 'input.follow_up',
          afterRunId: null,
          contextSelectionId: 'selection',
          content: '',
        },
      }),
    ).not.toThrow();
    expect(() => canonicalCallerCommandRequest(safe)).not.toThrow();
  }
  expect(
    nativeInputFileIntent([{ name: 'legacy.txt', uri: 'file:///workspace/legacy.txt' }]),
  ).toEqual({ files: [{ name: 'legacy.txt', uri: 'file:///workspace/legacy.txt' }] });
});
