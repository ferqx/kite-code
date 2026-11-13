import type { AgentClient, Message, SessionView } from '@kite-ai/client';
import { expect, test } from '#kite-test';
import { createTuiHistoryReader } from '../host/tui-history';
import { createTuiSessionReader } from '../host/tui-session';

function fixture(changes = true) {
  const calls: string[] = [];
  let view = {
    storeId: 'store',
    snapshotCursor: '1',
    session: {
      id: 'session',
      workspaceId: 'workspace',
      rootSessionId: 'session',
      parentSessionId: null,
      nextSeq: '0',
      title: 'original',
      ownerInstanceId: null,
      ownerGeneration: '0',
    },
    runs: [],
    executions: [],
    messages: [],
  } as unknown as SessionView;
  const client = {
    serverInfo: { instanceId: 'connection', capabilities: changes ? ['message_changes'] : [] },
    getView: async () => {
      calls.push('view');
      return view;
    },
    listMessages: async () => {
      calls.push('messages');
      return [];
    },
    listMessageChanges: async (_id: string, query: { upperCursor: string }) => {
      calls.push('changes');
      return {
        highWaterSeq: '0',
        nextCursor: query.upperCursor,
        nextAfterSeq: null,
        messages: [],
        removedIds: [],
      };
    },
    listInteractions: async () => {
      calls.push('interactions');
      return { interactions: [], nextAfterId: null };
    },
    listPendingInputs: async () => {
      calls.push('pending');
      return { commands: [], nextAfterSeq: null, snapshotCursor: view.snapshotCursor };
    },
    getPermissionMode: async () => {
      calls.push('mode');
      return { storeId: 'store', sessionId: 'session', mode: 'auto' };
    },
    getModelSettings: async () => {
      calls.push('models');
      return { storeId: 'store', scope: 'user', models: [], defaultModelId: null };
    },
  } as unknown as AgentClient;
  const reader = createTuiSessionReader({
    client,
    storeId: 'store',
    workspaceId: 'workspace',
    environment: { workspacePath: 'workspace' },
    history: createTuiHistoryReader(client, 'store'),
    display: async () => {
      calls.push('display');
      return {
        executionTimings: {},
        runtimeModel: undefined,
        context: undefined,
        nextContext: undefined,
        usage: undefined,
      };
    },
    jobTails: {
      read: async () => {
        calls.push('tails');
        return [];
      },
      clear() {},
    },
    labels: () => undefined,
  });
  return {
    client,
    reader,
    calls,
    set view(value: SessionView) {
      view = value;
    },
    get view() {
      return view;
    },
  };
}
const signal = () => new AbortController().signal;

test('default split host executes bounded domains independently; message cursor adds no View or admission read', async () => {
  const f = fixture();
  const base = await f.reader.readSession('session', signal());
  expect(base.domains?.admission?.phase).toBe('fresh');
  expect(base.connectionInstanceId).toBe('connection');
  f.calls.length = 0;
  expect(await f.reader.readSessionDomain!('history', base, '2', signal())).toMatchObject({
    domain: 'history',
    cursor: '2',
    messages: [],
  });
  expect(f.calls).toEqual(['changes']);
  f.calls.length = 0;
  await f.reader.readSessionDomain!('execution', base, '2', signal());
  expect(f.calls).toEqual(['view']);
  f.calls.length = 0;
  await f.reader.readSessionDomain!('admission', base, undefined, signal());
  expect(f.calls.sort()).toEqual(['interactions', 'mode', 'pending']);
});

test('admitted fallback performs a fresh fixed full history read only when requested', async () => {
  const f = fixture(false);
  const base = await f.reader.readSession('session', signal());
  f.calls.length = 0;
  f.view = { ...f.view, snapshotCursor: '2' };
  await f.reader.readSessionDomain!('history', base, '2', signal());
  expect(f.calls).toEqual(['view', 'messages']);
  expect(f.reader.messageChanges).toBe(false);
});

test('optional initial display failures report their own unavailable state; permission failures close admission', async () => {
  const f = fixture();
  const saved = {
    id: 'saved',
    sessionId: 'session',
    seq: '1',
    content: 'original reply',
  } as Message;
  f.view = { ...f.view, session: { ...f.view.session, nextSeq: '1' } };
  f.client.listMessages = async () => [saved];
  f.client.getModelSettings = async () => {
    throw Error('settings_failed');
  };
  const base = await f.reader.readSession('session', signal());
  expect(base.domains?.models).toEqual({ phase: 'unavailable', error: 'settings_failed' });
  expect(base.domains?.admission?.phase).toBe('fresh');
  f.client.getPermissionMode = async () => {
    throw Error('mode_failed');
  };
  await expect(f.reader.readSessionDomain!('admission', base, undefined, signal())).rejects.toThrow(
    'mode_failed',
  );
  const readOnly = await f.reader.readSession('session', signal());
  expect(readOnly.messages).toEqual([saved]);
  expect(readOnly.domains?.history?.phase).toBe('fresh');
  expect(readOnly.domains?.admission).toEqual({ phase: 'unavailable', error: 'mode_failed' });
  expect(readOnly.environment?.permissionMode).toBeUndefined();
});

test('wrong selected Workspace never supplies execution or metadata even if all other reads work', async () => {
  const f = fixture();
  const base = await f.reader.readSession('session', signal());
  f.view = { ...f.view, session: { ...f.view.session, workspaceId: 'foreign' } };
  await expect(f.reader.readSessionDomain!('execution', base, '2', signal())).rejects.toThrow(
    'workspace_identity_mismatch',
  );
  await expect(f.reader.readSessionDomain!('metadata', base, '2', signal())).rejects.toThrow(
    'workspace_identity_mismatch',
  );
});
