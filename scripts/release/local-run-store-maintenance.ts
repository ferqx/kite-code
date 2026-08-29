import { readdirSync } from 'node:fs';
import type {
  CoordinatorManagerResult,
  CoordinatorProcessLockLease,
} from '@kite-ai/kite-local-runtime/coordinator';
import { readCoordinatorProcessStartIdentity } from '@kite-ai/kite-local-runtime/coordinator';
import type { KiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createRuntimeHostStateStorageBinding,
  type StateRuntimeEvent,
  type StateRuntimeState,
} from '@kite-ai/runtime-host';
import {
  readSqliteActiveLayoutPointer,
  resolveSqliteRuntimeLayoutPaths,
  type SqliteRuntimeRunMigrationMaintenanceBarrier,
  type SqliteRuntimeRunMigrationResult,
} from '@kite-ai/runtime-storage-sqlite';
import { isRunStoreMigrationSessionSettled } from '../../apps/kite-service/src/coordinator/run-store-maintenance';
import { createWebGatewayControlLink } from '../../apps/kite-service/src/web-gateway/control';
import { createWebGatewayProcessProbe } from '../../apps/kite-service/src/web-gateway/process-host';
import { createWebGatewayProcessManager } from '../../apps/kite-service/src/web-gateway/process-manager';
import { createWebGatewayProcessStatePort } from '../../apps/kite-service/src/web-gateway/process-state';
import { createWorkspaceWorkerProcessProbe } from '../../apps/kite-service/src/workspace-worker/process-host';
import { createWorkspaceWorkerProcessManager } from '../../apps/kite-service/src/workspace-worker/process-manager';
import { createWorkspaceWorkerProcessStatePort } from '../../apps/kite-service/src/workspace-worker/process-state';
import { createWorkspaceReservationPort } from '../../apps/kite-service/src/workspace-worker/reservation';
import { runLocalRunStoreMigration } from './local-layout-migration';

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

export interface LocalRunStoreMaintenanceCoordinator {
  stop(): Promise<CoordinatorManagerResult>;
  status(): Promise<CoordinatorManagerResult>;
  acquireMaintenanceLock(): Promise<CoordinatorProcessLockLease | undefined>;
  /** Exact state check performed while the caller holds the lifecycle lock. */
  confirmAbsentWhileLocked(): Promise<boolean>;
}

export interface LocalRunStoreMaintenanceOptions {
  readonly home: KiteHomeIdentity;
  readonly coordinationHome: KiteHomeIdentity;
  readonly coordinator: LocalRunStoreMaintenanceCoordinator;
  readonly operationTimeoutMs?: number;
}

export interface LocalRunStoreMaintenance {
  migrate(input: {
    readonly targetLayoutGeneration: string;
  }): Promise<SqliteRuntimeRunMigrationResult>;
}

/** Release-owned explicit Store 7 → Store 8 command. Normal ensure never calls this owner. */
export function createLocalRunStoreMaintenance(
  options: LocalRunStoreMaintenanceOptions,
): LocalRunStoreMaintenance {
  const codec = createRuntimeHostStateStorageBinding().codec;
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1 ||
    operationTimeoutMs > 300_000
  ) {
    throw new RangeError('Run Store maintenance timeout is invalid.');
  }

  return Object.freeze({
    async migrate({
      targetLayoutGeneration,
    }: {
      readonly targetLayoutGeneration: string;
    }): Promise<SqliteRuntimeRunMigrationResult> {
      const stopped = await options.coordinator.stop();
      if (!isAbsentCoordinator(stopped, 'stop')) {
        return { status: 'blocked' as const, reason: 'maintenance_required' as const };
      }
      const status = await options.coordinator.status();
      if (!isAbsentCoordinator(status, 'status')) {
        return { status: 'blocked' as const, reason: 'maintenance_required' as const };
      }
      const lease = await options.coordinator.acquireMaintenanceLock();
      if (!lease) {
        return { status: 'blocked' as const, reason: 'maintenance_required' as const };
      }
      let absentWhileLocked = false;
      try {
        absentWhileLocked = await options.coordinator.confirmAbsentWhileLocked();
      } catch {
        absentWhileLocked = false;
      }
      if (!absentWhileLocked) {
        await lease.release().catch(() => undefined);
        return { status: 'blocked' as const, reason: 'maintenance_required' as const };
      }

      let result: SqliteRuntimeRunMigrationResult | undefined;
      let failure: unknown;
      try {
        result = await runLocalRunStoreMigration<StateRuntimeEvent, StateRuntimeState>({
          home: options.home,
          targetLayoutGeneration,
          codec,
          isSessionSettled: isRunStoreMigrationSessionSettled,
          inspectMaintenanceBarrier: () => quiesceManagedRuntime(options, operationTimeoutMs),
        });
      } catch (error) {
        failure = error;
      }
      try {
        await lease.release();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
      return result!;
    },
  });
}

async function quiesceManagedRuntime(
  options: LocalRunStoreMaintenanceOptions,
  operationTimeoutMs: number,
): Promise<SqliteRuntimeRunMigrationMaintenanceBarrier | 'uncertain'> {
  try {
    const pointer = readSqliteActiveLayoutPointer(
      resolveSqliteRuntimeLayoutPaths(options.home.root),
    );
    if (!pointer) return 'uncertain';

    if (!(await stopManagedGateway(options.home, operationTimeoutMs))) return 'uncertain';
    if (
      !(await stopManagedWorkers(
        options.home,
        options.coordinationHome,
        pointer.generation,
        operationTimeoutMs,
      ))
    ) {
      return 'uncertain';
    }

    return Object.freeze({
      coordinatorStopped: true,
      workspaceWorkersStopped: true,
      gatewayStopped: true,
      activeTurns: 0,
      pendingInteractions: 0,
      activeEffects: 0,
      externalProcesses: 0,
    });
  } catch {
    return 'uncertain';
  }
}

function isAbsentCoordinator(
  result: CoordinatorManagerResult,
  operation: 'stop' | 'status',
): boolean {
  return (
    result.operation === operation && result.outcome === 'applied' && result.state === 'absent'
  );
}

async function stopManagedGateway(
  home: KiteHomeIdentity,
  operationTimeoutMs: number,
): Promise<boolean> {
  const state = createWebGatewayProcessStatePort(home);
  const managerStartIdentity = await readCoordinatorProcessStartIdentity();
  if (!managerStartIdentity) return false;
  const manager = createWebGatewayProcessManager({
    home,
    state,
    executableResolver: {
      async resolve() {
        throw new Error('Maintenance cannot spawn Gateway.');
      },
    },
    environment: {
      async resolve() {
        throw new Error('Maintenance cannot spawn Gateway.');
      },
    },
    spawn: {
      async spawn() {
        throw new Error('Maintenance cannot spawn Gateway.');
      },
    },
    process: createWebGatewayProcessProbe(),
    controlLinkFor: async (descriptor, credential) =>
      createWebGatewayControlLink({
        origin: descriptor.endpoint.origin,
        credential,
        expectedInstanceId: descriptor.identity.instanceId,
        expectedBuildId: descriptor.identity.buildId,
      }),
    managerInstanceId: `run-store-maintenance-${process.pid}`,
    managerBuildId: 'run-store-maintenance-v1',
    managerProcessStartIdentity: managerStartIdentity,
    operationTimeoutMs,
    startupTimeoutMs: operationTimeoutMs,
  });
  try {
    if ((await manager.detailedStop()) !== 'closed') return false;
    return readdirSync(state.paths.root).length === 0;
  } catch {
    return false;
  }
}

async function stopManagedWorkers(
  home: KiteHomeIdentity,
  coordinationHome: KiteHomeIdentity,
  layoutGeneration: string,
  operationTimeoutMs: number,
): Promise<boolean> {
  const state = createWorkspaceWorkerProcessStatePort(home);
  const manager = createWorkspaceWorkerProcessManager({
    executableResolver: {
      async resolve() {
        throw new Error('Maintenance cannot spawn Worker.');
      },
    },
    environment: {
      async resolve() {
        throw new Error('Maintenance cannot spawn Worker.');
      },
    },
    spawn: {
      async spawn() {
        throw new Error('Maintenance cannot spawn Worker.');
      },
    },
    process: createWorkspaceWorkerProcessProbe(),
    ownerReservation: createWorkspaceReservationPort({ coordinationHome }),
    async admitWorkspaceStore() {
      throw new Error('Maintenance cannot admit a Workspace Store.');
    },
    registry: { register() {}, unregister() {} },
    state,
    activeLayoutGeneration: async () => layoutGeneration,
    operationTimeoutMs,
    startupTimeoutMs: operationTimeoutMs,
  });
  try {
    const scopes = await manager.listKnownScopes();
    for (const workerScopeId of scopes) {
      const result = await manager.stopIfIdle({ workerScopeId });
      if (result.outcome !== 'applied' || result.state !== 'absent') return false;
    }
    if ((await manager.listKnownScopes()).length !== 0) return false;
    return readdirSync(state.paths.root).length === 0;
  } catch {
    return false;
  }
}
