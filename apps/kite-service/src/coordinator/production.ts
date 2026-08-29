import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorCatalog,
  type CoordinatorRegistry,
  createCoordinatorRegistry,
  writeCoordinatorProcessReadySignal,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
} from '@kite-ai/kite-local-runtime/service';
import {
  assertSqliteCoordinatorCatalogActive,
  markSqliteCoordinatorCatalogWritten,
  materializeAndAdmitNewWorkspaceStore,
  readSqliteActiveLayoutPointer,
  resolveSqliteRuntimeLayoutPaths,
} from '@kite-ai/runtime-storage-sqlite';
import { createWebGatewayControlLink } from '../web-gateway/control';
import {
  createNeutralWebGatewayEnvironmentResolver,
  createWebGatewayProcessExecutableResolver,
  createWebGatewayProcessHost,
  createWebGatewayProcessProbe,
} from '../web-gateway/process-host';
import { createWebGatewayProcessManager } from '../web-gateway/process-manager';
import { createWebGatewayProcessStatePort } from '../web-gateway/process-state';
import {
  createNeutralWorkspaceWorkerEnvironmentResolver,
  createWorkspaceWorkerProcessExecutableResolver,
  createWorkspaceWorkerProcessHost,
  createWorkspaceWorkerProcessProbe,
} from '../workspace-worker/process-host';
import { createWorkspaceWorkerProcessManager } from '../workspace-worker/process-manager';
import { createWorkspaceWorkerProcessStatePort } from '../workspace-worker/process-state';
import { createWorkspaceReservationPort } from '../workspace-worker/reservation';
import { workspaceIdentityDigest } from '../workspace-worker/workspace-identity';
import { createKiteCoordinatorComposition } from './composition';
import type { KiteCoordinatorMainDependencies } from './main';
import { createCoordinatorWorkerManagerAdapter } from './worker-manager-adapter';

/**
 * Production Coordinator factory for the one release-owned companion process. Every executable,
 * layout, state, and asset location is supplied by the manager environment; this code never
 * consults cwd, PATH, HOME, or a legacy Service data plane.
 */
export const createProductionKiteCoordinatorComposition: NonNullable<
  KiteCoordinatorMainDependencies['createComposition']
> = async (environment) => {
  const home = ensureLocalRuntimeServiceHome(
    createKiteHomeIdentity(environment.home, 'explicit_argument'),
  );
  const coordinationHome = ensureLocalRuntimeServiceHome(
    createKiteHomeIdentity(environment.coordinationHome, 'os_user_home'),
  );
  const layout = resolveSqliteRuntimeLayoutPaths(home.root);
  assertActiveGeneration();

  const neutralRoot = join(coordinationHome.root, 'managed-process-cwd');
  mkdirSync(neutralRoot, { recursive: true, mode: 0o700 });

  const registry = createCoordinatorRegistry();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const sourceWorker = join(
    environment.companionRoot,
    'scripts',
    'release',
    'entrypoints',
    'worker.ts',
  );
  const installedWorker = join(environment.companionRoot, 'bin', `kite-worker${suffix}`);
  const sourceGateway = join(
    environment.companionRoot,
    'scripts',
    'release',
    'entrypoints',
    'gateway.ts',
  );
  const installedGateway = join(environment.companionRoot, 'bin', `kite-web-gateway${suffix}`);

  const workerManager = createWorkspaceWorkerProcessManager({
    executableResolver: createWorkspaceWorkerProcessExecutableResolver({
      source: sourceWorker,
      installed: installedWorker,
      sourceBuildId: environment.buildId,
      installedBuildId: environment.buildId,
    }),
    environment: createNeutralWorkspaceWorkerEnvironmentResolver({
      // The Coordinator itself stays on the server-owned neutral cwd, while each Worker is
      // deliberately rooted at the exact canonical Workspace it owns. The process manager
      // revalidates this equality before spawning so neither cwd nor PATH can select a Workspace.
      cwd: ({ workspace }) => workspace.canonicalPath,
      env: ({ workspace, workerScopeId, workerInstanceId, layoutGeneration }) => ({
        KITE_WORKER_HOME: home.root,
        KITE_WORKER_WORKSPACE: workspace.canonicalPath,
        KITE_WORKER_PROJECT_ID: workspace.projectId,
        KITE_WORKER_WORKSPACE_DIGEST: workspace.workspaceDigest,
        KITE_WORKER_SCOPE_ID: workerScopeId,
        KITE_WORKER_INSTANCE_ID: workerInstanceId,
        KITE_WORKER_BUILD_ID: environment.buildId,
        KITE_WORKER_LAYOUT_GENERATION: layoutGeneration,
      }),
    }),
    spawn: createWorkspaceWorkerProcessHost({ runtimeExecutable: process.execPath }),
    process: createWorkspaceWorkerProcessProbe(),
    ownerReservation: createWorkspaceReservationPort({ coordinationHome }),
    admitWorkspaceStore: async ({ workspace, workerScopeId, layoutGeneration }) => {
      assertActiveGeneration(layoutGeneration);
      materializeAndAdmitNewWorkspaceStore(
        layout,
        {
          layoutGeneration,
          workerScopeId,
          workspaceIdentityDigest: workspaceIdentityDigest(workspace),
        },
        'run',
      );
    },
    registry: {
      register(value) {
        registry.registerWorker(value);
      },
      unregister(workerScopeId, workerInstanceId) {
        registry.unregisterWorker(workerScopeId, workerInstanceId);
      },
    },
    state: createWorkspaceWorkerProcessStatePort(home),
    activeLayoutGeneration: async () => assertActiveGeneration(),
    expectedBuildId: environment.buildId,
    args: ['worker', 'run'],
  });

  const gatewayManager = createWebGatewayProcessManager({
    home,
    state: createWebGatewayProcessStatePort(home),
    executableResolver: createWebGatewayProcessExecutableResolver({
      source: sourceGateway,
      installed: installedGateway,
      sourceBuildId: environment.buildId,
      installedBuildId: environment.buildId,
    }),
    environment: createNeutralWebGatewayEnvironmentResolver({
      cwd: neutralRoot,
      env: {
        KITE_WEB_GATEWAY_HOME: home.root,
        KITE_WEB_GATEWAY_STATIC_ROOT: environment.webStaticRoot,
      },
    }),
    spawn: createWebGatewayProcessHost({ runtimeExecutable: process.execPath }),
    process: createWebGatewayProcessProbe(),
    registry: {
      register(value) {
        registry.ensureWebGateway(value);
      },
      unregister(instanceId) {
        // A restarted Coordinator begins with an empty in-memory registry even when it is
        // recovering confirmed-dead Gateway process state. Treat that absence as idempotent;
        // `stopWebGateway` still rejects a different registered instance.
        if (registry.discoverWebGateway() === null) return;
        registry.stopWebGateway(instanceId);
      },
    },
    createControlLink: async ({ descriptor, credential }) =>
      createWebGatewayControlLink({
        origin: descriptor.endpoint.origin,
        credential,
        expectedInstanceId: descriptor.identity.instanceId,
        expectedBuildId: descriptor.identity.buildId,
      }),
    controlLinkFor: async (descriptor, credential) =>
      createWebGatewayControlLink({
        origin: descriptor.endpoint.origin,
        credential,
        expectedInstanceId: descriptor.identity.instanceId,
        expectedBuildId: descriptor.identity.buildId,
      }),
    executableMode: environment.executableMode,
    expectedBuildId: environment.buildId,
    managerInstanceId: environment.instanceId,
    managerBuildId: environment.buildId,
    managerProcessStartIdentity: environment.processStartIdentity,
    args: ['web-gateway', 'run'],
  });

  return createKiteCoordinatorComposition({
    home,
    catalogStorage: {
      canonicalKiteHomeRoot: home.root,
      catalogPath: environment.catalogPath,
      layoutGeneration: environment.layoutGeneration,
      mode: 'open_active',
      beforeWrite: () => {
        assertActiveGeneration();
        markSqliteCoordinatorCatalogWritten(
          layout,
          environment.layoutGeneration,
          environment.catalogPath,
          'run',
        );
      },
    },
    identity: {
      role: 'coordinator',
      instanceId: environment.instanceId,
      buildId: environment.buildId,
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
      clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
    },
    processStartIdentity: environment.processStartIdentity,
    peerOsIdentity: environment.peerOsIdentity,
    workers: createCoordinatorWorkerManagerAdapter({
      manager: workerManager,
      executableMode: environment.executableMode,
    }),
    gateway: gatewayManager,
    registry,
    reconcile: { reconcile: () => ({}) },
    directorySync: {
      sync: (input) => syncCoordinatorDirectory(workerManager, input),
    },
    readiness: {
      publish: (signal) => writeCoordinatorProcessReadySignal(signal, environment.readinessFd),
    },
    signals: processSignalPort(),
  });

  function assertActiveGeneration(expected = environment.layoutGeneration): string {
    const pointer = readSqliteActiveLayoutPointer(layout);
    if (!pointer || pointer.generation !== expected || expected !== environment.layoutGeneration) {
      throw new Error('Coordinator active layout generation changed.');
    }
    assertSqliteCoordinatorCatalogActive(layout, expected, environment.catalogPath, 'run');
    return expected;
  }
};

export async function syncCoordinatorDirectory(
  manager: Pick<
    ReturnType<typeof createWorkspaceWorkerProcessManager>,
    'listKnownScopes' | 'readDirectoryOutbox'
  >,
  input: { readonly catalog: CoordinatorCatalog; readonly registry: CoordinatorRegistry },
): Promise<void> {
  const scopes = new Set(input.catalog.listSessions().map((entry) => entry.workerScopeId));
  for (const scope of await manager.listKnownScopes()) scopes.add(scope);
  for (const workerScopeId of [...scopes].sort()) {
    let cursorValue = input.catalog.outboxCursor(workerScopeId);
    let cursor = decodeOutboxCursor(cursorValue);
    for (let pageIndex = 0; pageIndex < 512; pageIndex += 1) {
      const page = await manager.readDirectoryOutbox({ workerScopeId, cursor, limit: 200 });
      // An inactive or identity-uncertain Worker cannot safely refresh its mirror. Preserve
      // existing Catalog facts and expose it as unavailable rather than inventing data.
      if (!page) break;
      for (const entry of page.entries) {
        if (entry.workerScopeId !== workerScopeId) {
          throw new Error('Workspace Worker Directory scope changed during sync.');
        }
        const metadata = {
          sessionId: entry.sessionId,
          workerScopeId,
          directoryRevision: String(entry.revision),
          updatedAt: new Date(entry.updatedAt).toISOString(),
          tombstone: entry.tombstone,
        };
        input.catalog.upsertSession(metadata);
        input.registry.upsertSessionMetadata(metadata);
      }
      if (page.nextCursor !== undefined) {
        const nextCursor = String(page.nextCursor);
        if (!input.catalog.advanceOutboxCursor(workerScopeId, cursorValue, nextCursor)) {
          throw new Error('Coordinator Directory cursor changed during sync.');
        }
        cursorValue = nextCursor;
        cursor = page.nextCursor;
      }
      if (!page.hasMore) break;
      if (page.entries.length === 0 || page.nextCursor === undefined) {
        throw new Error('Workspace Worker Directory page did not advance.');
      }
      if (pageIndex === 511) {
        throw new Error('Workspace Worker Directory sync exceeded its bound.');
      }
    }
  }
}

function decodeOutboxCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/u.test(value)) throw new Error('Coordinator Directory cursor is invalid.');
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error('Coordinator Directory cursor is invalid.');
  }
  return cursor;
}

function processSignalPort() {
  return Object.freeze({
    subscribe(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
      process.once(signal, listener);
      return () => process.off(signal, listener);
    },
  });
}

/** Kept exported for release tests without exposing a mutable path resolver to callers. */
export function coordinatorCompanionName(kind: 'worker' | 'gateway'): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return kind === 'worker' ? `kite-worker${suffix}` : `kite-web-gateway${suffix}`;
}
