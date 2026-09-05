import type { MockModelServer } from './fixtures';
import type { PtyProcess } from './pty-process';
import type { TestWorkspace } from './test-workspace';

interface StoppableFixture {
  stop(): unknown | Promise<unknown>;
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
  const ownedWorkspaces = new Set<TestWorkspace>();

  for (const tui of fixtures.tuis ?? []) {
    if (!tui) continue;
    try {
      await tui.killAndWait();
    } catch (error) {
      errors.push(error);
    }
  }

  // Each production TUI owns its stdio App Server. killAndWait closes that process tree; durable
  // Session facts remain in the isolated Kite Home until the fixture itself is removed below.
  for (const workspace of fixtures.workspaces ?? []) {
    if (!workspace) continue;
    ownedWorkspaces.add(workspace);
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
      await server.stop();
    } catch (error) {
      errors.push(error);
    }
  }

  for (const workspace of ownedWorkspaces) {
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

/** Execute an explicit server stop without exposing raw fixture lifecycle calls in scenarios. */
export async function stopTuiSystemServer(server: StoppableFixture): Promise<unknown> {
  return server.stop();
}
