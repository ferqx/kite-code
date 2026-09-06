import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type ControllerOperationRequest,
  type ControllerOperationResult,
  createSessionControllerAuthority,
  createWorkspaceEffectGate,
  type SessionControllerLease,
  type SessionControllerStore,
  type WorkspaceEffectAttempt,
} from '../../src/workspace-worker';

const effectAttempt = (attemptId: string): WorkspaceEffectAttempt => ({
  sessionId: 'session-1',
  commandId: null,
  invocationId: `invocation-${attemptId}`,
  clientId: 'client-1',
  connectionGeneration: 1,
  controllerGeneration: 1,
  workerInstanceId: 'worker-1',
  ownerId: 'worker-1',
  workerScopeId: 'scope-1',
  workspaceDigest: `sha256:${'a'.repeat(64)}`,
  attemptId,
  requestDigest: 'b'.repeat(64),
  expiresAtMs: 10_000,
  resourceId: 'workspace-1',
  kind: 'filesystem',
});

describe('Workspace effect gate', () => {
  test('serializes Workspace mutation and acknowledges before dispatch', async () => {
    const order: string[] = [];
    const gate = createWorkspaceEffectGate({
      workerScopeId: 'scope-1',
      workspaceDigest: `sha256:${'a'.repeat(64)}`,
      evidence: {
        inspect: async () => 'absent',
        prepare: async (attempt) => {
          order.push(`prepare:${attempt.attemptId}`);
        },
        acknowledgeDispatch: async (attempt) => {
          order.push(`ack:${attempt.attemptId}`);
        },
        commitTerminal: async (attempt) => {
          order.push(`terminal:${attempt.attemptId}`);
        },
        commitUnknown: async (attempt) => {
          order.push(`unknown:${attempt.attemptId}`);
        },
      },
      resources: {
        acquire: async (attempt) => ({
          resourceId: attempt.resourceId,
          [Symbol.asyncDispose]: async () => {
            order.push(`release:${attempt.attemptId}`);
          },
        }),
      },
    });
    const first = gate.run(effectAttempt('a1'), async () => {
      order.push('dispatch:a1');
      await Promise.resolve();
      return 'one';
    });
    const second = gate.run(effectAttempt('a2'), async () => {
      order.push('dispatch:a2');
      return 'two';
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'applied', result: 'one' },
      { status: 'applied', result: 'two' },
    ]);
    expect(order).toEqual([
      'prepare:a1',
      'ack:a1',
      'dispatch:a1',
      'terminal:a1',
      'release:a1',
      'prepare:a2',
      'ack:a2',
      'dispatch:a2',
      'terminal:a2',
      'release:a2',
    ]);
  });

  test('records post-ack failure as unknown without replay', async () => {
    let dispatches = 0;
    let unknown = 0;
    let durable: 'absent' | 'dispatch_acknowledged' | 'outcome_unknown' = 'absent';
    const gate = createWorkspaceEffectGate({
      workerScopeId: 'scope-1',
      workspaceDigest: `sha256:${'a'.repeat(64)}`,
      evidence: {
        inspect: async () => durable,
        prepare: async () => undefined,
        acknowledgeDispatch: async () => {
          durable = 'dispatch_acknowledged';
        },
        commitTerminal: async () => undefined,
        commitUnknown: async () => {
          unknown += 1;
          durable = 'outcome_unknown';
        },
      },
      resources: {
        acquire: async (attempt) => ({
          resourceId: attempt.resourceId,
          [Symbol.asyncDispose]: async () => undefined,
        }),
      },
    });
    await expect(
      gate.run(effectAttempt('unknown-1'), async () => {
        dispatches += 1;
        throw new Error('lost terminal');
      }),
    ).resolves.toEqual({ status: 'unknown' });
    expect(dispatches).toBe(1);
    expect(unknown).toBe(1);
    await expect(gate.run(effectAttempt('unknown-1'), async () => 'replay')).resolves.toEqual({
      status: 'unknown',
    });
    expect(dispatches).toBe(1);
  });

  test('replays only a prepared pre-ack attempt and never redispatches terminal evidence', async () => {
    let durable: 'prepared' | 'terminal' = 'prepared';
    let dispatches = 0;
    const gate = createWorkspaceEffectGate({
      workerScopeId: 'scope-1',
      workspaceDigest: `sha256:${'a'.repeat(64)}`,
      evidence: {
        inspect: async () => durable,
        prepare: async () => {
          throw new Error('prepared evidence must not be duplicated');
        },
        acknowledgeDispatch: async () => undefined,
        commitTerminal: async () => {
          durable = 'terminal';
        },
        commitUnknown: async () => undefined,
      },
      resources: {
        acquire: async (attempt) => ({
          resourceId: attempt.resourceId,
          [Symbol.asyncDispose]: async () => undefined,
        }),
      },
    });
    await expect(
      gate.run(effectAttempt('recover-prepared'), async () => {
        dispatches += 1;
        return 'settled';
      }),
    ).resolves.toEqual({ status: 'applied', result: 'settled' });
    await expect(
      gate.run(effectAttempt('recover-prepared'), async () => {
        dispatches += 1;
        return 'must-not-run';
      }),
    ).resolves.toEqual({ status: 'already_applied' });
    expect(dispatches).toBe(1);
  });
});

function request(
  requestId: string,
  clientId: string,
  clientKind: 'tui' | 'desktop' | 'web_observer',
): ControllerOperationRequest {
  return {
    requestId,
    requestDigest: createHash('sha256').update(requestId).digest('hex'),
    sessionId: 'session-1',
    clientId,
    clientKind,
    connectionGeneration: 1,
  };
}

function memoryControllerStore(): SessionControllerStore {
  let lease: SessionControllerLease | null = null;
  let generation = 0;
  const receipts = new Map<string, { digest: string; result: ControllerOperationResult }>();
  return {
    inspect: async () => ({ lease, controllerGeneration: generation }),
    lookupOperation: async (sessionId, requestId, digest) => {
      const found = receipts.get(`${sessionId}\0${requestId}`);
      if (!found) return null;
      return found.digest === digest ? found.result : 'digest_mismatch';
    },
    commitOperation: async ({ request: operation, expectedGeneration, result }) => {
      if (expectedGeneration !== generation) {
        return { status: 'conflict', lease, controllerGeneration: generation };
      }
      lease = result.status === 'applied' ? result.lease : result.lease;
      generation =
        result.status === 'applied'
          ? result.lease.controllerGeneration
          : result.controllerGeneration;
      receipts.set(`${operation.sessionId}\0${operation.requestId}`, {
        digest: operation.requestDigest,
        result,
      });
      return result;
    },
    markDetached: async (clientId, connectionGeneration) => {
      if (lease?.clientId === clientId && lease.connectionGeneration === connectionGeneration) {
        lease = { ...lease, state: 'detached' };
      }
    },
  };
}

describe('Session Controller authority', () => {
  test('allows one TUI Controller, keeps Desktop/Web observers, and fences mutation', async () => {
    const store = memoryControllerStore();
    const authority = createSessionControllerAuthority({ workerInstanceId: 'worker-1', store });
    const tui = await authority.requestControl(request('request-tui', 'tui-1', 'tui'));
    expect(tui.status).toBe('applied');
    await expect(
      authority.requestControl(request('request-desktop', 'desktop-1', 'desktop')),
    ).resolves.toMatchObject({ status: 'conflict' });
    await expect(
      authority.requestControl(request('request-web', 'web-1', 'web_observer')),
    ).resolves.toMatchObject({ status: 'observer' });
    expect(
      await authority.authorizeMutation({
        sessionId: 'session-1',
        clientId: 'tui-1',
        connectionGeneration: 1,
        controllerGeneration: 1,
      }),
    ).toBe(true);
    expect(
      await authority.authorizeMutation({
        sessionId: 'session-1',
        clientId: 'web-1',
        connectionGeneration: 1,
        controllerGeneration: 1,
      }),
    ).toBe(false);
  });

  test('persists detach, release generation, and idempotent operation receipt', async () => {
    const store = memoryControllerStore();
    const authority = createSessionControllerAuthority({ workerInstanceId: 'worker-1', store });
    const acquire = request('request-acquire', 'tui-1', 'tui');
    const first = await authority.requestControl(acquire);
    await expect(authority.requestControl(acquire)).resolves.toEqual(first);
    await authority.markConnectionDetached('tui-1', 1);
    expect(
      await authority.authorizeMutation({
        sessionId: 'session-1',
        clientId: 'tui-1',
        connectionGeneration: 1,
        controllerGeneration: 1,
      }),
    ).toBe(false);
    const released = await authority.releaseControl(request('request-release', 'tui-1', 'tui'));
    expect(released).toEqual({ status: 'observer', lease: null, controllerGeneration: 2 });
    const reacquired = await authority.requestControl(
      request('request-reacquire', 'desktop-1', 'desktop'),
    );
    expect(reacquired).toMatchObject({
      status: 'applied',
      lease: { clientId: 'desktop-1', controllerGeneration: 3 },
    });
  });
});
