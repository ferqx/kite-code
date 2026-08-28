import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorWorkerIdentity,
  type CoordinatorWorkerReference,
  type CoordinatorWorkspaceIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  type CoordinatorWorkerManagerPort,
  coordinatorWorkerScopeId,
  createCoordinatorWorkerManagerAdapter,
} from '../../src/coordinator/worker-manager-adapter';
import type { WorkspaceWorkerControlIdentity } from '../../src/workspace-worker/process-host';
import type {
  WorkspaceWorkerCapabilityResult,
  WorkspaceWorkerProcessRegistration,
  WorkspaceWorkerProcessResult,
} from '../../src/workspace-worker/process-manager';
import {
  canonicalWorkspaceIdentity,
  workspaceIdentityDigest,
} from '../../src/workspace-worker/workspace-identity';

const READY_AT = '2026-08-29T00:00:00.000Z';
const BUILD_ID = 'worker-build-v1';

interface Harness {
  readonly workspace: KiteWorkspaceIdentity;
  readonly otherWorkspace: KiteWorkspaceIdentity;
  readonly scopeId: string;
  readonly identity: WorkspaceWorkerControlIdentity;
  readonly reference: CoordinatorWorkerReference;
  readonly calls: {
    readonly ensure: unknown[];
    readonly resolve: unknown[];
    readonly describeScope: string[];
    readonly mint: unknown[];
  };
  readonly manager: CoordinatorWorkerManagerPort;
}

function makeWorkspace(label: string): KiteWorkspaceIdentity {
  const canonicalPath = realpathSync.native(
    mkdtempSync(join(tmpdir(), `kite-coordinator-adapter-${label}-`)),
  );
  const workspaceDigest = `sha256:${createHash('sha256')
    .update(canonicalPath, 'utf8')
    .digest('hex')}` as `sha256:${string}`;
  return {
    canonicalPath,
    projectId: `project_${workspaceDigest.slice('sha256:'.length)}`,
    workspaceDigest,
  };
}

function asCoordinatorWorkspace(workspace: KiteWorkspaceIdentity): CoordinatorWorkspaceIdentity {
  return workspace;
}

function makeCoordinatorIdentity(
  scopeId: string,
  instanceId = 'worker-instance',
): CoordinatorWorkerIdentity {
  return {
    role: 'worker',
    workerScopeId: scopeId,
    instanceId,
    buildId: BUILD_ID,
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  };
}

function makeRegistration(
  workspace: KiteWorkspaceIdentity,
  scopeId: string,
  instanceId = 'worker-instance',
): WorkspaceWorkerProcessRegistration {
  return {
    identity: makeCoordinatorIdentity(scopeId, instanceId),
    workspaceDigest: workspace.workspaceDigest,
    endpoint: {
      origin: 'http://127.0.0.1:43101',
      websocketUrl: 'ws://127.0.0.1:43101/rpc',
    },
    state: 'ready',
    startedAt: READY_AT,
    lastSeenAt: READY_AT,
  };
}

function result(
  operation: WorkspaceWorkerProcessResult['operation'],
  registration: WorkspaceWorkerProcessRegistration | undefined,
  outcome: WorkspaceWorkerProcessResult['outcome'] = 'applied',
  state: WorkspaceWorkerProcessResult['state'] = 'ready',
  diagnostic?: WorkspaceWorkerProcessResult['diagnostic'],
): WorkspaceWorkerProcessResult {
  return {
    operation,
    outcome,
    state,
    ...(registration === undefined ? {} : { registration }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function createHarness(): Harness {
  const workspace = makeWorkspace('primary');
  const otherWorkspace = makeWorkspace('other');
  const scopeId = coordinatorWorkerScopeId(asCoordinatorWorkspace(workspace));
  const identity: WorkspaceWorkerControlIdentity = {
    workerScopeId: scopeId,
    workerInstanceId: 'worker-instance',
    buildId: BUILD_ID,
    workspace,
  };
  const registration = makeRegistration(workspace, scopeId);
  const calls = {
    ensure: [] as unknown[],
    resolve: [] as unknown[],
    describeScope: [] as string[],
    mint: [] as unknown[],
  };
  const manager: CoordinatorWorkerManagerPort = {
    async ensure(input) {
      calls.ensure.push(input);
      return result('ensure', registration);
    },
    async resolve(input) {
      calls.resolve.push(input);
      return result('resolve', registration);
    },
    async describeScope(input) {
      calls.describeScope.push(input);
      return identity;
    },
    async mintConnectionCapability(input) {
      calls.mint.push(input);
      return {
        outcome: 'applied',
        capability: 'capability-value-012345678901234567890',
        expiresAt: '2026-08-29T00:00:30.000Z',
      } satisfies WorkspaceWorkerCapabilityResult;
    },
  };
  const reference: CoordinatorWorkerReference = {
    identity: registration.identity,
    workspace: asCoordinatorWorkspace(workspace),
    endpoint: registration.endpoint,
  };
  return { workspace, otherWorkspace, scopeId, identity, reference, calls, manager };
}

describe('Coordinator Worker manager adapter', () => {
  test('derives distinct stable scopes from the complete canonical Workspace identity', () => {
    const first = makeWorkspace('scope-a');
    const second = makeWorkspace('scope-b');
    const firstScope = coordinatorWorkerScopeId(asCoordinatorWorkspace(first));
    const secondScope = coordinatorWorkerScopeId(asCoordinatorWorkspace(second));
    expect(firstScope).toBe(
      `workspace_${workspaceIdentityDigest(canonicalWorkspaceIdentity(first)).slice('sha256:'.length)}`,
    );
    expect(firstScope).toMatch(/^workspace_[a-f0-9]{64}$/u);
    expect(secondScope).not.toBe(firstScope);
  });

  test('maps ensure and resolve registrations only after exact scope/workspace checks', async () => {
    const harness = createHarness();
    const adapter = createCoordinatorWorkerManagerAdapter({ manager: harness.manager });
    const ensured = await adapter.ensureWorkspace(asCoordinatorWorkspace(harness.workspace));
    const resolved = await adapter.resolveWorkspace(asCoordinatorWorkspace(harness.workspace));
    expect(ensured).toEqual(harness.reference);
    expect(resolved).toEqual(harness.reference);
    expect(harness.calls.ensure[0]).toMatchObject({
      workerScopeId: harness.scopeId,
      workspace: harness.workspace,
    });
    expect(harness.calls.resolve[0]).toMatchObject({
      workerScopeId: harness.scopeId,
      workspace: harness.workspace,
    });
  });

  test('maps absent resolve without inventing a Worker reference', async () => {
    const harness = createHarness();
    const manager: CoordinatorWorkerManagerPort = {
      ...harness.manager,
      async resolve() {
        return result('resolve', undefined, 'applied', 'absent', 'not_running');
      },
    };
    const adapter = createCoordinatorWorkerManagerAdapter({ manager });
    await expect(
      adapter.resolveWorkspace(asCoordinatorWorkspace(harness.workspace)),
    ).resolves.toBeNull();
  });

  test('maps outcome_unknown and registration mismatches to typed fail-closed errors', async () => {
    const unknownHarness = createHarness();
    const unknownManager: CoordinatorWorkerManagerPort = {
      ...unknownHarness.manager,
      async ensure() {
        return result('ensure', undefined, 'outcome_unknown', 'starting', 'outcome_unknown');
      },
    };
    const unknownAdapter = createCoordinatorWorkerManagerAdapter({ manager: unknownManager });
    await expect(
      unknownAdapter.ensureWorkspace(asCoordinatorWorkspace(unknownHarness.workspace)),
    ).rejects.toMatchObject({ code: 'outcome_unknown' });

    const mismatchHarness = createHarness();
    const wrongRegistration = makeRegistration(
      mismatchHarness.otherWorkspace,
      mismatchHarness.scopeId,
    );
    const mismatchManager: CoordinatorWorkerManagerPort = {
      ...mismatchHarness.manager,
      async ensure() {
        return result('ensure', wrongRegistration);
      },
    };
    const mismatchAdapter = createCoordinatorWorkerManagerAdapter({ manager: mismatchManager });
    await expect(
      mismatchAdapter.ensureWorkspace(asCoordinatorWorkspace(mismatchHarness.workspace)),
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  test('describeScope uses restart-safe identity then verifies the current registration', async () => {
    const harness = createHarness();
    const adapter = createCoordinatorWorkerManagerAdapter({ manager: harness.manager });
    await expect(adapter.describeScope(harness.scopeId)).resolves.toEqual({
      workspace: harness.workspace,
      worker: harness.reference,
    });
    expect(harness.calls.describeScope).toEqual([harness.scopeId]);
    expect(harness.calls.resolve).toHaveLength(1);

    const staleManager: CoordinatorWorkerManagerPort = {
      ...harness.manager,
      async describeScope() {
        return {
          ...harness.identity,
          workerInstanceId: 'replacement-instance',
        };
      },
    };
    const staleAdapter = createCoordinatorWorkerManagerAdapter({ manager: staleManager });
    await expect(staleAdapter.describeScope(harness.scopeId)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
  });

  for (const purpose of ['native_client', 'web_observer'] as const) {
    test(`maps ${purpose} capability mint without retaining the capability`, async () => {
      const harness = createHarness();
      const adapter = createCoordinatorWorkerManagerAdapter({ manager: harness.manager });
      const minted = await adapter.mintCapability({
        worker: harness.reference,
        clientId: `client-${purpose}`,
        connectionGeneration: 1,
        purpose,
      });
      expect(minted).toEqual({
        capability: 'capability-value-012345678901234567890',
        expiresAt: '2026-08-29T00:00:30.000Z',
      });
      expect(harness.calls.mint[0]).toEqual({
        workerScopeId: harness.scopeId,
        workspace: harness.workspace,
        clientId: `client-${purpose}`,
        connectionGeneration: 1,
        purpose,
      });
    });
  }

  test('rejects a stale reference before minting', async () => {
    const harness = createHarness();
    const adapter = createCoordinatorWorkerManagerAdapter({ manager: harness.manager });
    const stale = {
      ...harness.reference,
      identity: { ...harness.reference.identity, instanceId: 'stale-instance' },
    };
    await expect(
      adapter.mintCapability({
        worker: stale,
        clientId: 'client-stale',
        connectionGeneration: 1,
        purpose: 'web_observer',
      }),
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(harness.calls.mint).toHaveLength(0);
  });

  test('maps capability outcome_unknown without exposing a partial capability', async () => {
    const harness = createHarness();
    const manager: CoordinatorWorkerManagerPort = {
      ...harness.manager,
      async mintConnectionCapability() {
        return { outcome: 'outcome_unknown' } satisfies WorkspaceWorkerCapabilityResult;
      },
    };
    const adapter = createCoordinatorWorkerManagerAdapter({ manager });
    await expect(
      adapter.mintCapability({
        worker: harness.reference,
        clientId: 'client-unknown',
        connectionGeneration: 1,
        purpose: 'native_client',
      }),
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
  });
});
