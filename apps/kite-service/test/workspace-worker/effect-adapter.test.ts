import { describe, expect, test } from 'bun:test';
import type {
  SqliteWorkspaceAuthority,
  SqliteWorkspaceEffectEvidence,
  SqliteWorkspaceEffectPreparationInput,
  SqliteWorkspaceEffectTerminalInput,
  SqliteWorkspaceResourceLease,
  SqliteWorkspaceResourceLeaseInput,
} from '@kite-ai/runtime-storage-sqlite';
import {
  createWorkspaceStoreEffectAdapter,
  type WorkspaceEffectAttempt,
} from '../../src/workspace-worker';

const binding = {
  layoutGeneration: 'generation-1',
  workerScopeId: 'scope-1',
  workspaceIdentityDigest: 'a'.repeat(64),
} as const;

const attempt: WorkspaceEffectAttempt = {
  sessionId: 'session-1',
  commandId: 'command-1',
  invocationId: 'invocation-1',
  clientId: 'client-1',
  connectionGeneration: 1,
  controllerGeneration: 3,
  workerInstanceId: 'worker-1',
  ownerId: 'worker-1',
  workerScopeId: binding.workerScopeId,
  workspaceDigest: `sha256:${binding.workspaceIdentityDigest}`,
  attemptId: 'attempt-1',
  requestDigest: 'b'.repeat(64),
  expiresAtMs: 10_000,
  resourceId: 'workspace-resource-1',
  kind: 'filesystem',
};

type EffectState = SqliteWorkspaceEffectEvidence;

function fakeAuthority(log: string[]) {
  let effect: EffectState | undefined;
  let resource: SqliteWorkspaceResourceLease | undefined;
  const authority: Pick<SqliteWorkspaceAuthority, 'binding' | 'effects' | 'resources'> = {
    binding,
    effects: {
      prepare(input: SqliteWorkspaceEffectPreparationInput) {
        log.push('effect.prepare');
        if (effect) return { status: 'replay' as const, evidence: effect };
        effect = {
          schema: 'kite.runtime-effect-evidence.v1',
          sessionId: input.sessionId,
          effectId: input.effectId,
          workerScopeId: binding.workerScopeId,
          workspaceIdentityDigest: binding.workspaceIdentityDigest,
          layoutGeneration: binding.layoutGeneration,
          ownerId: input.ownerId,
          invocationId: input.invocationId,
          attemptId: input.attemptId,
          requestDigest: input.requestDigest,
          capabilityDigest: input.capabilityDigest ?? null,
          state: 'prepared',
          outcome: null,
          terminalDigest: null,
          terminalCode: null,
          leaseRevision: 0,
          preparedAt: 1,
          terminalAt: null,
        };
        return { status: 'prepared' as const, evidence: effect };
      },
      inspect() {
        log.push('effect.inspect');
        return effect ? { status: effect.state, evidence: effect } : { status: 'missing' as const };
      },
      terminal(input: SqliteWorkspaceEffectTerminalInput) {
        log.push(`effect.terminal:${input.outcome}`);
        if (!effect) return { status: 'unknown' as const, reason: 'missing_preparation' as const };
        if (effect.state === 'terminal') return { status: 'replay' as const, evidence: effect };
        if (effect.state === 'unknown') {
          return { status: 'unknown' as const, reason: 'reconciliation_required' as const };
        }
        effect = {
          ...effect,
          state: input.outcome === 'unknown' ? ('unknown' as const) : ('terminal' as const),
          outcome: input.outcome,
          terminalDigest: input.terminalDigest,
          terminalCode: input.terminalCode ?? null,
          terminalAt: 2,
        };
        return { status: 'terminal' as const, evidence: effect };
      },
    },
    resources: {
      prepare(input: SqliteWorkspaceResourceLeaseInput) {
        log.push('resource.prepare');
        if (resource) return resource;
        resource = {
          schema: 'kite.runtime-resource-lease.v1',
          sessionId: input.sessionId,
          resourceId: input.resourceId,
          workerScopeId: binding.workerScopeId,
          workspaceIdentityDigest: binding.workspaceIdentityDigest,
          layoutGeneration: binding.layoutGeneration,
          ownerId: input.ownerId,
          attemptId: input.attemptId,
          requestDigest: input.requestDigest,
          leaseRevision: 0,
          expiresAtMs: input.expiresAtMs,
          externalLeaseDigest: null,
          state: 'prepared',
        };
        return resource;
      },
      recordAcquired(input) {
        log.push('resource.acquired');
        if (!resource) throw new Error('missing resource');
        resource = { ...resource, externalLeaseDigest: input.externalLeaseDigest, state: 'held' };
        return resource;
      },
      recordReleased() {
        log.push('resource.released');
        if (!resource) throw new Error('missing resource');
        resource = { ...resource, state: 'released' };
        return resource;
      },
      inspect() {
        log.push('resource.inspect');
        return resource ?? null;
      },
    },
  };
  return authority;
}

function externalLease(log: string[]) {
  return {
    acquire: async (value: WorkspaceEffectAttempt) => {
      log.push(`external.acquire:${value.resourceId}`);
      return {
        resourceId: value.resourceId,
        [Symbol.asyncDispose]: async () => {
          log.push('external.release');
        },
      };
    },
  };
}

describe('Workspace Store effect adapter', () => {
  test('orders Store preparation, external lease, dispatch acknowledgement, and terminal evidence', async () => {
    const log: string[] = [];
    const adapter = createWorkspaceStoreEffectAdapter({
      authority: fakeAuthority(log),
      resourceLease: externalLease(log),
      authorizeController: (value) => {
        log.push(`authorize:g${value.controllerGeneration}`);
        return true;
      },
    });

    await expect(
      adapter.gate.run(attempt, async () => {
        log.push('dispatch');
        return 'ok';
      }),
    ).resolves.toEqual({ status: 'applied', result: 'ok' });
    expect(log).toEqual([
      'authorize:g3',
      'effect.inspect',
      'authorize:g3',
      'effect.prepare',
      'authorize:g3',
      'resource.prepare',
      'external.acquire:workspace-resource-1',
      'resource.acquired',
      'authorize:g3',
      'effect.inspect',
      'resource.inspect',
      'dispatch',
      'authorize:g3',
      'effect.inspect',
      'effect.terminal:succeeded',
      'external.release',
      'resource.released',
    ]);
  });

  test('records post-ack throw as unknown and refuses replay', async () => {
    const log: string[] = [];
    const adapter = createWorkspaceStoreEffectAdapter({
      authority: fakeAuthority(log),
      resourceLease: externalLease(log),
      authorizeController: () => true,
    });
    await expect(
      adapter.gate.run(attempt, async () => {
        throw new Error('dispatch lost');
      }),
    ).resolves.toEqual({ status: 'unknown' });
    await expect(adapter.gate.run(attempt, async () => 'replayed')).resolves.toEqual({
      status: 'unknown',
    });
    expect(log.filter((value) => value === 'dispatch')).toHaveLength(0);
    expect(log).toContain('effect.terminal:unknown');
  });

  test('requires the exact authenticated controller generation before dispatch', async () => {
    let dispatches = 0;
    const adapter = createWorkspaceStoreEffectAdapter({
      authority: fakeAuthority([]),
      resourceLease: externalLease([]),
      authorizeController: (value) => value.controllerGeneration === 99,
    });
    await expect(
      adapter.gate.run(attempt, async () => {
        dispatches += 1;
        return 'must-not-run';
      }),
    ).rejects.toThrow('Controller authority');
    expect(dispatches).toBe(0);
  });

  test('rejects terminal evidence when the Controller generation rolls during dispatch', async () => {
    let currentGeneration = attempt.controllerGeneration;
    const log: string[] = [];
    const adapter = createWorkspaceStoreEffectAdapter({
      authority: fakeAuthority(log),
      resourceLease: externalLease(log),
      authorizeController: (value) => {
        log.push(`authorize:g${value.controllerGeneration}`);
        return value.controllerGeneration === currentGeneration;
      },
    });
    await expect(
      adapter.gate.run(attempt, async () => {
        currentGeneration = attempt.controllerGeneration + 1;
        return 'must-not-commit';
      }),
    ).rejects.toThrow('Controller authority');
    expect(log).not.toContain('effect.terminal:succeeded');
    expect(log).not.toContain('effect.terminal:unknown');
  });
});
