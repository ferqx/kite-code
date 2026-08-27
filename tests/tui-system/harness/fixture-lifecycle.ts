import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from '@kite-ai/kite-local-runtime/client';
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
      if (stopped.outcome !== 'applied') {
        if (stopped.outcome === 'outcome_unknown') {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            const observed = await managed.lifecycle.status({
              clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
            });
            if (observed.outcome === 'applied' && observed.state === 'absent') {
              stopped = observed;
              break;
            }
          }
        }
        if (stopped.outcome !== 'applied') {
          throw new Error(
            `Managed TUI test Service did not stop cleanly: ${stopped.outcome}/${stopped.diagnostic ?? stopped.state}`,
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
