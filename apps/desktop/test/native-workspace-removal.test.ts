import { expect, test } from 'bun:test';
import { type AgentClient, ClientError } from '@kite-ai/client';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeWorkspaceRemovalPort } from '../electron/workspace-removal';
import { memoryPrivateData } from './private-data.fixture';

test('original confirmation defaults to keep; one saved POST becomes unknown and a cold host only GETs its original identity', async () => {
  const data = memoryPrivateData(),
    workspace = { id: 'w', name: 'Original', rootUri: 'file:///workspace' };
  let scope = { generation: 1, storeId: 'store', subjectId: 'user' },
    posts = 0,
    gets = 0;
  const client = {
    async getWorkspace() {
      return workspace;
    },
    async removeWorkspace(id: string, input: { expectedStoreId: string; commandId: string }) {
      posts++;
      expect(data.workspaceRemovals()[0]).toMatchObject({
        workspaceId: id,
        request: input,
        phase: 'submitting',
      });
      throw new ClientError('network_outcome_unknown');
    },
    async getWorkspaceRemoval(id: string, commandId: string, options: { storeId: string }) {
      gets++;
      expect(id).toBe('w');
      expect(commandId).toBe(data.workspaceRemovals()[0]!.request.commandId);
      expect(options.storeId).toBe('store');
      return {
        commandId,
        originStoreId: 'store',
        subjectId: 'user',
        workspaceId: 'w',
        requestDigest: 'a'.repeat(64),
        deletedRoots: 2,
        deletedSessions: 4,
        removedAt: 1,
        outcome: 'workspace_removed',
        stopConfirmed: false,
      };
    },
  } as unknown as AgentClient;
  const create = () =>
    new NativeWorkspaceRemovalPort(
      client,
      () => data,
      () => scope,
      () => workspace,
      () => {},
    );
  const host = create();
  expect(
    (
      await host.remove('w', async (label) => {
        expect(label).toBe('Original');
        return false;
      })
    ).phase,
  ).toBe('cancelled');
  expect(posts).toBe(0);
  expect(data.workspaceRemovals()).toHaveLength(0);
  const unknown = await host.remove('w', async () => true);
  expect(unknown.phase).toBe('unknown');
  expect(posts).toBe(1);
  const cold = create();
  expect(cold.submissions[0]!.phase).toBe('unknown');
  expect(posts).toBe(1);
  expect(gets).toBe(0);
  scope = { generation: 2, storeId: 'restored', subjectId: 'user' };
  expect((await cold.lookup(unknown.commandId!)).error).toBe('workspace_origin_unavailable');
  expect(gets).toBe(0);
  expect(posts).toBe(1);
  scope = { generation: 3, storeId: 'store', subjectId: 'user' };
  expect((await cold.lookup(unknown.commandId!)).phase).toBe('applied');
  expect(gets).toBe(1);
  expect(posts).toBe(1);
  expect(data.workspaceRemovals()).toHaveLength(0);
  expect(() =>
    decodeNativeRequest({
      method: 'workspace.remove',
      generation: 1,
      workspaceId: 'w',
      confirmed: true,
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'workspace.removal.lookup',
      generation: 1,
      commandId: unknown.commandId,
      expectedStoreId: 'restored',
    }),
  ).toThrow('invalid_native_request');
});
