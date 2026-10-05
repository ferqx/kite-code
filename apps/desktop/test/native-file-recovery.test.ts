import { expect, test } from 'bun:test';
import type { AgentClient } from '@kite-ai/client';
import { NativeFileRecovery } from '../electron/file-recovery';
import { decodeNativeRequest } from '../electron/native-ipc';
import { memoryPrivateData } from './private-data.fixture';

const checkpoint = {
  id: 'a'.repeat(64),
  workspace: { device: '1', inode: '2' },
  boundary: {
    storeId: 'source-A',
    sessionId: 'parent',
    workspaceId: 'source-W',
    runId: 'r',
    contextSelectionId: 'old-selector',
    messageId: null,
    messageSeq: '0',
    triggerMessageId: 'old-trigger',
    triggerSeq: '3',
  },
};
const session = {
  id: 's',
  workspaceId: 'w',
  parentSessionId: null,
  deletedAt: null,
  controlRevision: '1',
  contextSelectionId: 'current-selector',
};
const boundary = {
  storeId: 'store',
  sessionId: 's',
  workspaceId: 'w',
  contextSelectionId: 'current-selector',
  checkpoint,
  boundary: null,
  trigger: { messageId: 'current-trigger', seq: '3' },
};
const detail = {
  storeId: 'store',
  sessionId: 's',
  workspaceId: 'w',
  payload: { checkpoint, files: [] },
};
test('Native exact post-persistence current selection gate leaves original submitting intent and zero POST, cold does not acquire a permit', async () => {
  let scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' },
    posts = 0;
  const journal = memoryPrivateData(),
    original = journal.updateFileRecovery.bind(journal);
  journal.updateFileRecovery = async (next, previous) => {
    const saved = await original(next, previous);
    if (next.code?.phase === 'submitting') scope = { ...scope, selection: 2 };
    return saved;
  };
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'owner' },
    getView: async () => ({ storeId: 'store', session }),
    getFileCheckpoint: async () => detail,
    getFileCheckpointRecoveryBoundary: async () => boundary,
    invokeExtension: async () => {
      posts++;
      throw Error('must_not_post');
    },
  } as unknown as AgentClient;
  const manager = new NativeFileRecovery(
      client,
      () => scope,
      () => {},
      journal,
    ),
    facts = await manager.detail(checkpoint.id, 'read', 0);
  let error = '';
  try {
    await manager.begin(facts.observationId, 'both', 'Saved', 0);
  } catch (cause) {
    error = (cause as Error).message;
  }
  expect(error).toBe('native_selection_changed');
  expect(posts).toBe(0);
  const rows = await journal.fileRecoveries();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.code!.phase).toBe('submitting');
  expect(rows[0]!.fork!.phase).toBe('not_started');
  const cold = new NativeFileRecovery(
    client,
    () => scope,
    () => {},
    journal,
  );
  expect(await cold.saved()).toEqual(rows);
  expect(posts).toBe(0);
  scope = { ...scope, storeId: 'store-B' };
  const foreign = await cold.lookup(rows[0]!.code!.request.commandId, 'foreign');
  expect(foreign).toEqual(rows[0]!);
  expect(posts).toBe(0);
});
test('Native Files finite IPC rejects renderer authority, missing observation revision and bad closed point/afterKey', () => {
  const approved = {
    method: 'interaction.answer',
    generation: 1,
    interactionId: 'card',
    revision: '1',
    answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
  } as const;
  expect(decodeNativeRequest(approved)).toEqual(approved);
  expect(() =>
    decodeNativeRequest({ ...approved, answer: { ...approved.answer, grant: 'all' } }),
  ).toThrow('invalid_native_request');
  const base = {
    method: 'fileRecovery.detail',
    generation: 1,
    readId: 'r',
    pointId: checkpoint.id,
    inputRevision: 0,
  } as const;
  expect(decodeNativeRequest(base)).toEqual(base);
  for (const extra of [
    { commandId: 'new' },
    { expectedStoreId: 'other' },
    { grant: 'approve_once' },
    { request: {} },
    { pointId: 'not-hash' },
    { inputRevision: undefined },
    { inputRevision: -1 },
  ])
    expect(() => decodeNativeRequest({ ...base, ...extra })).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'fileRecovery.detail',
      generation: 1,
      readId: 'r',
      pointId: checkpoint.id,
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'fileRecovery.list',
      generation: 1,
      readId: 'r',
      afterKey: 'other/root',
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'fileRecovery.begin',
      generation: 1,
      observationId: 1,
      scope: 'all',
      inputRevision: 1,
      title: 'T',
    }),
  ).toThrow('invalid_native_request');
});
