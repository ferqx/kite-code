import { describe, expect, test } from 'bun:test';
import {
  startWorkspaceWorker,
  type WorkspaceWorkerIdentity,
  type WorkspaceWorkerOwnerLock,
  type WorkspaceWorkerRuntime,
} from '../../src/workspace-worker';

const identity: WorkspaceWorkerIdentity = {
  workerScopeId: 'scope-1',
  workerInstanceId: 'worker-1',
  buildId: 'build-1',
  workspace: {
    canonicalPath: '/workspace',
    projectId: 'project-1',
    workspaceDigest: `sha256:${'a'.repeat(64)}`,
  },
};

describe('Workspace Worker lifecycle', () => {
  test('acquires owner lock before Store composition and registers only after readiness', async () => {
    const order: string[] = [];
    const worker = await startWorkspaceWorker({
      identity,
      ownerLock: {
        acquire: async () => {
          order.push('lock');
          return {
            identity,
            [Symbol.asyncDispose]: async () => {
              order.push('unlock');
            },
          } satisfies WorkspaceWorkerOwnerLock;
        },
      },
      composeRuntime: () => {
        order.push('compose');
        return {
          ready: Promise.resolve().then(() => {
            order.push('ready');
          }),
          [Symbol.asyncDispose]: async () => {
            order.push('dispose');
          },
        } satisfies WorkspaceWorkerRuntime;
      },
      registry: {
        register: async () => {
          order.push('register');
        },
        unregister: async () => {
          order.push('unregister');
        },
      },
    });
    expect(order).toEqual(['lock', 'compose', 'ready', 'register']);
    await worker[Symbol.asyncDispose]();
    expect(order).toEqual([
      'lock',
      'compose',
      'ready',
      'register',
      'unregister',
      'dispose',
      'unlock',
    ]);
  });

  test('consumes one instance/workspace/client-bound capability exactly once', async () => {
    let clock = 1_000;
    const worker = await startWorkspaceWorker({
      identity,
      ownerLock: {
        acquire: async () => ({ identity, [Symbol.asyncDispose]: async () => undefined }),
      },
      composeRuntime: () => ({
        ready: Promise.resolve(),
        [Symbol.asyncDispose]: async () => undefined,
      }),
      registry: { register: async () => undefined, unregister: async () => undefined },
      now: () => clock,
      random: () => new Uint8Array(32).fill(7),
    });
    const request = {
      clientId: 'client-1',
      connectionGeneration: 1,
      purpose: 'web_observer',
    } as const;
    const minted = worker.mintConnectionCapability(request);
    const proof = {
      ...request,
      workerInstanceId: identity.workerInstanceId,
      workerScopeId: identity.workerScopeId,
      workspaceDigest: identity.workspace.workspaceDigest,
      secret: minted.secret,
    };
    expect(worker.consumeConnectionCapability({ ...proof, workerInstanceId: 'wrong' })).toBe(false);
    expect(worker.consumeConnectionCapability(proof)).toBe(true);
    expect(worker.consumeConnectionCapability(proof)).toBe(false);

    const expired = worker.mintConnectionCapability({ ...request, connectionGeneration: 2 });
    clock = expired.expiresAt + 1;
    expect(
      worker.consumeConnectionCapability({
        ...proof,
        connectionGeneration: 2,
        secret: expired.secret,
      }),
    ).toBe(false);
    await worker[Symbol.asyncDispose]();
  });

  test('releases lock and Runtime when readiness or registration fails', async () => {
    const order: string[] = [];
    await expect(
      startWorkspaceWorker({
        identity,
        ownerLock: {
          acquire: async () => ({
            identity,
            [Symbol.asyncDispose]: async () => {
              order.push('unlock');
            },
          }),
        },
        composeRuntime: () => ({
          ready: Promise.reject(new Error('not ready')),
          [Symbol.asyncDispose]: async () => {
            order.push('dispose');
          },
        }),
        registry: { register: async () => undefined, unregister: async () => undefined },
      }),
    ).rejects.toThrow('not ready');
    expect(order).toEqual(['dispose', 'unlock']);
  });
});
