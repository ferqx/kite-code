import { expect, test } from 'bun:test';
import { type AgentClient, ClientError, type Command } from '@kite-ai/client';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeSessionManagement } from '../electron/session-management';

const session = {
  id: 's',
  workspaceId: 'w',
  rootSessionId: 's',
  parentSessionId: null,
  title: 'Original',
  contextSelectionId: 'selected',
  controlRevision: '4',
  nextSeq: '8',
  deletedAt: null,
};
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
test('Native Session unknown Fork shares one frozen POST; lookup after switching validates original receipt without replay', async () => {
  let scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' },
    release!: () => void,
    entered!: () => void,
    posts = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  let original!: Command;
  const gets: string[] = [];
  const client = {
    serverInfo: { capabilities: ['sessions', 'context'] },
    getView: async () => ({ storeId: 'store', session }),
    async forkSession(_session: string, input: Parameters<AgentClient['forkSession']>[1]) {
      posts++;
      original = {
        id: input.commandId,
        originStoreId: 'store',
        sessionId: input.newSessionId,
        kind: 'session.create',
        status: 'applied',
        cancelRequestedAt: null,
        receipt: {
          sessionId: input.newSessionId,
          selectionId: 'new-selection',
          sourceSessionId: 's',
          sourceSelectionId: 'selected',
          omittedExtensionState: true,
          namespaceReport: [
            {
              extensionId: 'fixture',
              contentType: 'fixture',
              contentVersion: 1,
              ruleVersion: null,
              mode: 'omit',
              copied: 0,
              rebuilt: 0,
              omitted: 1,
            },
          ],
        },
      } as Command;
      entered();
      await gate;
      throw new ClientError('network_outcome_unknown');
    },
    async getCommand(id: string) {
      gets.push(id);
      return original;
    },
  } as unknown as AgentClient;
  const host = new NativeSessionManagement(
      client,
      () => scope,
      () => {},
    ),
    facts = await host.observe('s');
  const first = host.submit(facts.observationId, 'fork', 'Forked'),
    duplicate = host.submit(facts.observationId, 'fork', 'Forked');
  expect(first).toBe(duplicate);
  await ready;
  expect(posts).toBe(1);
  scope = { ...scope, selection: 2, sessionId: 'other' };
  host.release();
  release();
  expect(await code(first)).toBe('network_outcome_unknown');
  expect(host.submissions[0]).toMatchObject({
    sessionId: 's',
    phase: 'unknown',
    intent: { expectedContextSelectionId: 'selected' },
  });
  await host.lookup(original.id);
  expect(gets).toEqual([original.id]);
  expect(posts).toBe(1);
  expect(host.submissions[0]).toMatchObject({
    phase: 'applied',
    omittedExtensionState: true,
    newSessionId: original.sessionId,
  });
});
test('Native Session fresh view revision drift and child scope reject before POST; applied delete never claims stop confirmation', async () => {
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  let revision = '4',
    child = false,
    posts = 0;
  const client = {
    serverInfo: { capabilities: ['sessions', 'context'] },
    getView: async () => ({
      storeId: 'store',
      session: { ...session, controlRevision: revision, parentSessionId: child ? 'parent' : null },
    }),
    async deleteSession(_id: string, input: Parameters<AgentClient['deleteSession']>[1]) {
      posts++;
      const updated = { ...session, controlRevision: '5', deletedAt: 1 };
      return {
        command: {
          id: input.commandId,
          originStoreId: 'store',
          sessionId: 's',
          kind: 'session.delete',
          status: 'applied',
          receipt: { outcome: 'delete_requested', stopConfirmed: false, session: updated },
        },
        session: updated,
      };
    },
  } as unknown as AgentClient;
  const host = new NativeSessionManagement(
      client,
      () => scope,
      () => {},
    ),
    facts = await host.observe('s');
  revision = '5';
  expect(await code(host.submit(facts.observationId, 'rename', 'Renamed'))).toBe(
    'session_observation_changed',
  );
  expect(posts).toBe(0);
  child = true;
  const childFacts = await host.observe('s');
  expect(
    await code(Promise.resolve().then(() => host.submit(childFacts.observationId, 'delete'))),
  ).toBe('child_session_readonly');
  child = false;
  revision = '4';
  const current = await host.observe('s');
  await host.submit(current.observationId, 'delete');
  expect(posts).toBe(1);
  expect(host.submissions.at(-1)).toMatchObject({ phase: 'applied', stopConfirmed: false });
});
test('Native Session IPC does not accept renderer command/Store/revision authority or malformed title', () => {
  expect(
    decodeNativeRequest({ method: 'session.fork', generation: 1, observationId: 3, title: 'Fork' }),
  ).toMatchObject({ method: 'session.fork' });
  for (const extra of [
    { commandId: 'renderer' },
    { expectedStoreId: 'foreign' },
    { ifRevision: '0' },
  ])
    expect(() =>
      decodeNativeRequest({ method: 'session.delete', generation: 1, observationId: 3, ...extra }),
    ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({ method: 'session.rename', generation: 1, observationId: 3, title: ' ' }),
  ).toThrow('invalid_native_request');
});
