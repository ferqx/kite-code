import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorClientIdentity,
  type CoordinatorIdentity,
  type CoordinatorRequestFrame,
  type CoordinatorWorkerReference,
  createCoordinatorControlPlane,
  createCoordinatorDispatcher,
  createCoordinatorRegistry,
  openCoordinatorCatalog,
} from '@kite-ai/kite-local-runtime/coordinator';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const coordinator: CoordinatorIdentity = {
  role: 'coordinator',
  instanceId: 'coordinator-1',
  buildId: 'build-1',
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
  clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
};

const client: CoordinatorClientIdentity = {
  role: 'client',
  instanceId: 'client-1',
  buildId: 'build-1',
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
  clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
};

const worker: CoordinatorWorkerReference = {
  identity: {
    role: 'worker',
    workerScopeId: 'scope-1',
    instanceId: 'worker-1',
    buildId: 'build-1',
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  },
  workspace: {
    canonicalPath: '/workspace',
    projectId: 'project-1',
    workspaceDigest: `sha256:${'a'.repeat(64)}`,
  },
  endpoint: { origin: 'http://127.0.0.1:43123', websocketUrl: 'ws://127.0.0.1:43123/rpc' },
};

function openCatalog(root: string) {
  const generation = 'generation-1';
  mkdirSync(join(root, 'layouts', generation), { recursive: true, mode: 0o700 });
  return openCoordinatorCatalog({
    canonicalKiteHomeRoot: root,
    layoutGeneration: generation,
    catalogPath: join(root, 'layouts', generation, 'catalog.sqlite'),
    mode: 'initialize_target',
  });
}

function request<M extends CoordinatorRequestFrame['method']>(
  method: M,
  params: Extract<CoordinatorRequestFrame, { method: M }>['params'],
  idempotencyKey = `key-${method}`,
): Extract<CoordinatorRequestFrame, { method: M }> {
  return {
    schema: 'kite.local-coordinator-frame.v1',
    kind: 'request',
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    requestId: `request-${method}`,
    idempotencyKey,
    deadlineMs: 5_000,
    method,
    params,
  } as Extract<CoordinatorRequestFrame, { method: M }>;
}

describe('Coordinator durable control-plane composition', () => {
  test('blocks routing until reconcile and resolves persisted path-free metadata afterwards', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-control-plane-')));
    roots.push(root);
    const catalog = openCatalog(root);
    const registry = createCoordinatorRegistry();
    let directoryRefreshes = 0;
    const plane = createCoordinatorControlPlane({
      identity: coordinator,
      catalog,
      registry,
      workers: {
        resolveWorkspace: async () => worker,
        ensureWorkspace: async () => worker,
        describeScope: async () => ({ workspace: worker.workspace, worker }),
        mintCapability: async () => ({
          capability: 'C'.repeat(43),
          expiresAt: '2026-08-29T00:00:30.000Z',
        }),
      },
      gateway: {
        ensure: async () => ({ registration: gateway(), launchUrl: launchUrl() }),
        discover: async () => null,
        stop: async () => undefined,
      },
      beforeDirectoryRead: async () => {
        directoryRefreshes += 1;
      },
    });
    const dispatcher = createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: plane.handlers,
    });
    const before = await dispatcher.dispatch(
      request('resolveSessionWorkspace', { sessionId: 'session-1' }),
      client,
    );
    expect(before).toMatchObject({ outcome: 'error', error: { code: 'unavailable' } });
    const workspaceBefore = await dispatcher.dispatch(
      request('resolveWorkspaceWorker', { workspace: worker.workspace }),
      client,
    );
    expect(workspaceBefore).toMatchObject({
      outcome: 'error',
      error: { code: 'unavailable' },
    });

    plane.applySessionMetadata({
      sessionId: 'session-1',
      workerScopeId: 'scope-1',
      directoryRevision: 'revision-1',
      updatedAt: '2026-08-29T00:00:00.000Z',
      tombstone: false,
    });
    plane.completeReconcile();
    const after = await dispatcher.dispatch(
      request('resolveSessionWorkspace', { sessionId: 'session-1' }),
      client,
    );
    expect(after).toMatchObject({ outcome: 'ok', result: { workerScopeId: 'scope-1' } });
    expect(directoryRefreshes).toBe(1);
    expect(JSON.stringify((after as { result: unknown }).result)).toContain('/workspace');
    expect(JSON.stringify(catalog.listSessions())).not.toContain('/workspace');
    catalog.close();
  });

  test('mints one capability once and persists only non-secret outcome state', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-control-capability-')));
    roots.push(root);
    const catalog = openCatalog(root);
    let mints = 0;
    const plane = createCoordinatorControlPlane({
      identity: coordinator,
      catalog,
      registry: createCoordinatorRegistry(),
      workers: {
        resolveWorkspace: async () => worker,
        ensureWorkspace: async () => worker,
        describeScope: async () => ({ workspace: worker.workspace, worker }),
        mintCapability: async () => {
          mints += 1;
          return {
            capability: 'S'.repeat(43),
            expiresAt: '2026-08-29T00:00:30.000Z',
          };
        },
      },
      gateway: {
        ensure: async () => ({ registration: gateway(), launchUrl: launchUrl() }),
        discover: async () => null,
        stop: async () => undefined,
      },
    });
    plane.completeReconcile();
    const dispatcher = createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: plane.handlers,
    });
    const frame = request(
      'mintWorkerConnectionCapability',
      {
        workspace: worker.workspace,
        workerScopeId: 'scope-1',
        clientId: 'client-1',
        connectionGeneration: 1,
        purpose: 'native_client',
      },
      'mint-once',
    );
    const first = await dispatcher.dispatch(frame, client);
    expect(first).toMatchObject({ outcome: 'ok' });
    const replay = await dispatcher.dispatch(frame, client);
    expect(replay).toMatchObject({ outcome: 'error', error: { code: 'outcome_unknown' } });
    expect(mints).toBe(1);
    catalog.close();
    const bytes = readFileSync(join(root, 'layouts', 'generation-1', 'catalog.sqlite'));
    expect(bytes.includes(Buffer.from('S'.repeat(43)))).toBe(false);
  });

  test('lists persisted Workspace sessions while its Worker is idle and hides tombstones', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-control-directory-')));
    roots.push(root);
    const catalog = openCatalog(root);
    const plane = createCoordinatorControlPlane({
      identity: coordinator,
      catalog,
      registry: createCoordinatorRegistry(),
      workers: {
        resolveWorkspace: async () => null,
        ensureWorkspace: async () => worker,
        describeScope: async (scope) =>
          scope === 'scope-1' ? { workspace: worker.workspace, worker: null } : null,
        mintCapability: async () => {
          throw new Error('unexpected capability mint');
        },
      },
      gateway: {
        ensure: async () => ({ registration: gateway(), launchUrl: launchUrl() }),
        discover: async () => null,
        stop: async () => undefined,
      },
    });
    plane.applySessionMetadata({
      sessionId: 'session-live',
      workerScopeId: 'scope-1',
      directoryRevision: 'revision-1',
      updatedAt: '2026-08-29T00:00:00.000Z',
      tombstone: false,
    });
    plane.applySessionMetadata({
      sessionId: 'session-deleted',
      workerScopeId: 'scope-1',
      directoryRevision: 'revision-2',
      updatedAt: '2026-08-29T00:00:01.000Z',
      tombstone: true,
    });
    plane.completeReconcile();
    const response = await createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: plane.handlers,
    }).dispatch(request('listSessionMetadata', { workspace: worker.workspace }), client);
    expect(response).toMatchObject({
      outcome: 'ok',
      result: { entries: [{ sessionId: 'session-live', workerScopeId: 'scope-1' }] },
    });
    expect(JSON.stringify(response)).not.toContain('session-deleted');
    catalog.close();
  });
});

function gateway() {
  return {
    identity: {
      role: 'web_gateway' as const,
      instanceId: 'gateway-1',
      buildId: 'build-1',
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
      clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
    },
    endpoint: { origin: 'http://127.0.0.1:43124' },
    state: 'ready' as const,
    startedAt: '2026-08-29T00:00:00.000Z',
    lastSeenAt: '2026-08-29T00:00:00.000Z',
  };
}

function launchUrl(): string {
  return `http://127.0.0.1:43124/#${'a'.repeat(43)}`;
}
