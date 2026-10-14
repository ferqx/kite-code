import { expect, test } from 'bun:test';
import type { AgentClient, FileCheckpointPage, SessionLogPage, SessionView } from '@kite-ai/client';
import { createFileRecoveryPort, readFileCheckpointRecordedTimes } from '../host/file-recovery';
import type { openFileRecoveryJournal } from '../host/file-recovery-intents';

const id = 'a'.repeat(64);
const view = {
  storeId: 'store',
  snapshotCursor: '3',
  session: {
    id: 's',
    workspaceId: 'w',
    contextSelectionId: 'selection',
    rootSessionId: 's',
    parentSessionId: null,
    deletedAt: null,
  },
} as SessionView;
const points: FileCheckpointPage['payload']['items'] = [
  {
    checkpoint: {
      id,
      boundary: {
        storeId: 'store',
        workspaceId: 'w',
        sessionId: 's',
        runId: 'run',
        contextSelectionId: 'selection',
        messageId: null,
        messageSeq: '0',
        triggerMessageId: 'user',
        triggerSeq: '1',
      },
      workspace: { device: '1', inode: '2' },
    },
    revision: '1',
  },
];
const entry = {
  cursor: '1',
  sessionId: 's',
  objectId: `builtin.files/checkpoint/${id}/point`,
  type: 'extension.record_updated',
  revision: '0',
  occurredAt: 2000,
  category: 'extension',
  recordedStatus: null,
  summary: 'extension.record_updated',
  details: {},
  modelExecutionId: null,
} as const;
function page(): SessionLogPage {
  return {
    storeId: 'store',
    sessionId: 's',
    upperCursor: '3',
    snapshotCursor: '3',
    replayFloor: '0',
    nextAfterCursor: null,
    complete: true,
    entries: [{ ...entry }],
  };
}

test('recorded dates consume only same-source immutable point metadata at the fixed view bound and never use observer time', async () => {
  const requests: unknown[] = [];
  const client = {
    listSessionLogs: async (sessionId: string, options: unknown) => {
      requests.push({ sessionId, options });
      return page();
    },
  } as Pick<AgentClient, 'listSessionLogs'>;
  const signal = new AbortController().signal;
  expect(await readFileCheckpointRecordedTimes(client, 'store', view, points, signal)).toEqual({
    [id]: 2000,
  });
  expect(requests).toEqual([
    {
      sessionId: 's',
      options: { expectedStoreId: 'store', afterCursor: '0', upperCursor: '3', limit: 200, signal },
    },
  ]);
  for (const changed of [
    { ...page(), replayFloor: '1' },
    { ...page(), storeId: 'foreign' },
    { ...page(), entries: [{ ...entry, occurredAt: null }] },
    { ...page(), entries: [{ ...entry }, { ...entry, cursor: '2' }] },
  ]) {
    const reader = { listSessionLogs: async () => changed } as Pick<AgentClient, 'listSessionLogs'>;
    expect(await readFileCheckpointRecordedTimes(reader, 'store', view, points, signal)).toEqual(
      {},
    );
  }
  requests.length = 0;
  for (const changed of [
    { ...points[0]!, revision: '2' },
    {
      ...points[0]!,
      checkpoint: {
        ...points[0]!.checkpoint,
        boundary: { ...points[0]!.checkpoint.boundary, storeId: 'restored-original' },
      },
    },
  ]) {
    expect(await readFileCheckpointRecordedTimes(client, 'store', view, [changed], signal)).toEqual(
      {},
    );
  }
  expect(requests).toEqual([]);
});

test('host catalogue uses only verified log recordedAt and does not write or touch recovery journal', async () => {
  let effects = 0;
  const forbidden = () => {
    effects++;
    throw Error('unexpected_effect');
  };
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'subject' },
    getView: async () => view,
    listFileCheckpoints: async () => ({
      storeId: 'store',
      sessionId: 's',
      workspaceId: 'w',
      payload: { items: [{ ...points[0]!, recordedAt: 999 }], nextAfterKey: null },
    }),
    listSessionLogs: async () => page(),
    invokeExtension: forbidden,
  } as unknown as AgentClient;
  const journal = {
    list: forbidden,
    prepare: forbidden,
    record: forbidden,
  } as unknown as ReturnType<typeof openFileRecoveryJournal>;
  const port = createFileRecoveryPort({ client, journal });
  expect((await port.listPoints('s')).payload.items[0]!.recordedAt).toBe(2000);
  expect(effects).toBe(0);
});
