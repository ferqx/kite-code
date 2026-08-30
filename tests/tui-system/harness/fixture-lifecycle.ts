import { existsSync } from 'node:fs';
import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from '@kite-ai/kite-local-runtime/client';
import {
  createCoordinatorProcessStatePort,
  decodeCoordinatorProcessDescriptor,
  readCoordinatorProcessStartIdentity,
  resolveCoordinatorStatePaths,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity, type KiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createWorkspaceWorkerProcessStatePort,
  decodeWorkspaceWorkerProcessDescriptor,
} from '../../../apps/kite-service/src/workspace-worker';
import { createManagedLocalServiceClientComposition } from '../../../scripts/release/local-service-client';
import type { MockModelServer } from './fixtures';
import type { PtyProcess } from './pty-process';
import type { TestWorkspace } from './test-workspace';

interface StoppableFixture {
  stop(): unknown;
}

export interface TuiSystemFixtures {
  tuis?: Array<PtyProcess | undefined>;
  servers?: Array<StoppableFixture | undefined>;
  mockServers?: Array<MockModelServer | undefined>;
  workspaces?: Array<TestWorkspace | undefined>;
}

/**
 * Release scenario resources in dependency order without allowing one cleanup
 * failure to strand the remaining resources.
 */
export async function cleanupTuiSystemFixtures(fixtures: TuiSystemFixtures): Promise<void> {
  const errors: unknown[] = [];
  const stoppedWorkspaces = new Set<TestWorkspace>();

  for (const tui of fixtures.tuis ?? []) {
    if (!tui) continue;
    try {
      await tui.killAndWait();
    } catch (error) {
      errors.push(error);
    }
  }

  // Client disconnect deliberately does not own the resident Service lifecycle. Test cleanup
  // therefore uses the same authenticated manager stop as production before deleting state.
  for (const workspace of fixtures.workspaces ?? []) {
    if (!workspace) continue;
    try {
      const codeRoot = workspace.env.KITE_CODE_HOME;
      if (!codeRoot) {
        throw new Error('TUI test workspace is missing its explicit KITE_CODE_HOME.');
      }
      await stopTestOwnedCoordinatorTree(codeRoot);
      const managed = createManagedLocalServiceClientComposition({
        argv: ['tui-system-cleanup', '--kite-home', codeRoot],
        environment: workspace.env,
        systemHome: workspace.home,
      });
      let stopped = await managed.lifecycle.stop({
        clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
      });
      // A just-disconnected PTY can briefly race the independent identity probe. The manager
      // proves `identity_uncertain` before sending control.stop, so bounded test-only re-probing
      // cannot replay a mutation. Busy/unknown/other outcomes remain immediate failures.
      for (
        let attempt = 0;
        stopped.outcome === 'unavailable' &&
        stopped.diagnostic === 'identity_uncertain' &&
        attempt < 20;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        stopped = await managed.lifecycle.stop({
          clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
        });
      }
      // `service_busy` is a definite rejection before drain commit, not an unknown mutation
      // outcome. A killed TUI deliberately does not cancel its resident Session/Turn, so the
      // test owner may wait for that bounded work to settle and issue a fresh ordinary stop.
      // Never apply this retry to `outcome_unknown`.
      for (let attempt = 0; stopped.outcome === 'service_busy' && attempt < 50; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        stopped = await managed.lifecycle.stop({
          clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
        });
      }
      let lastObservedStatus: Awaited<ReturnType<typeof managed.lifecycle.status>> | undefined;
      if (stopped.outcome !== 'applied') {
        if (stopped.outcome === 'outcome_unknown') {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            const observed = await managed.lifecycle.status({
              clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
            });
            lastObservedStatus = observed;
            if (observed.outcome === 'applied' && observed.state === 'absent') {
              stopped = observed;
              break;
            }
          }
        }
        if (stopped.outcome !== 'applied') {
          const observed = lastObservedStatus
            ? `; observed=${lastObservedStatus.outcome}/${lastObservedStatus.state}/${lastObservedStatus.diagnostic ?? 'none'}`
            : '';
          throw new Error(
            `Managed TUI test Service did not stop cleanly: ${stopped.outcome}/${stopped.diagnostic ?? stopped.state}${observed}`,
          );
        }
      }
      stoppedWorkspaces.add(workspace);
    } catch (error) {
      errors.push(error);
    }
  }

  for (const server of fixtures.mockServers ?? []) {
    if (!server) continue;
    try {
      server.assertComplete({
        allowUnconsumedResponses: process.env.KITE_FAULT_SOAK_PROCESS_NONCE !== undefined,
      });
    } catch (error) {
      errors.push(error);
    }
  }

  const servers = new Set<StoppableFixture>([
    ...(fixtures.mockServers ?? []).filter((server): server is MockModelServer => Boolean(server)),
    ...(fixtures.servers ?? []).filter((server): server is StoppableFixture => Boolean(server)),
  ]);
  for (const server of servers) {
    try {
      server.stop();
    } catch (error) {
      errors.push(error);
    }
  }

  for (const workspace of stoppedWorkspaces) {
    try {
      workspace.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'TUI system fixture cleanup failed');
  }
}

/**
 * Stop companions intentionally designed to outlive a terminal client. This is test-owner
 * cleanup only: production managers never kill by PID, and this helper signals a process only
 * after its server-owned PID + OS start token match the isolated fixture descriptor exactly.
 */
export async function stopTestOwnedCoordinatorTree(codeRoot: string): Promise<void> {
  const home: KiteHomeIdentity = createKiteHomeIdentity(codeRoot, 'explicit_argument');
  if (!existsSync(resolveCoordinatorStatePaths(home).root)) return;
  const workerState = createWorkspaceWorkerProcessStatePort(home);
  if (!workerState.listDescriptors) {
    throw new Error('Workspace Worker fixture state cannot enumerate owned processes.');
  }
  const workers = await workerState.listDescriptors();
  for (const raw of workers) {
    const descriptor = decodeWorkspaceWorkerProcessDescriptor(raw);
    await signalExactFixtureProcess(
      descriptor.pid,
      descriptor.processStartIdentity,
      'Workspace Worker',
    );
  }
  const rawCoordinator = await createCoordinatorProcessStatePort(home).readDescriptor();
  if (rawCoordinator === undefined) return;
  const descriptor = decodeCoordinatorProcessDescriptor(rawCoordinator);
  await signalExactFixtureProcess(descriptor.pid, descriptor.processStartIdentity, 'Coordinator');
}

async function signalExactFixtureProcess(
  pid: number,
  expectedStartIdentity: string,
  label: string,
): Promise<void> {
  const actual = await readCoordinatorProcessStartIdentity(pid, process.platform);
  if (actual !== expectedStartIdentity) {
    throw new Error(`${label} fixture process identity is uncertain; refusing cleanup signal.`);
  }
  process.kill(pid, 'SIGTERM');
  if (await waitForExactFixtureProcessExit(pid, expectedStartIdentity, 100)) return;
  const beforeForce = await readCoordinatorProcessStartIdentity(pid, process.platform);
  if (beforeForce !== expectedStartIdentity) return;
  process.kill(pid, 'SIGKILL');
  if (await waitForExactFixtureProcessExit(pid, expectedStartIdentity, 100)) return;
  throw new Error(`${label} fixture process did not stop within the cleanup deadline.`);
}

async function waitForExactFixtureProcessExit(
  pid: number,
  expectedStartIdentity: string,
  attempts: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isNativeError(error, 'ESRCH')) return true;
      throw error;
    }
    const current = await readCoordinatorProcessStartIdentity(pid, process.platform);
    if (current !== expectedStartIdentity) return true;
  }
  return false;
}

function isNativeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
