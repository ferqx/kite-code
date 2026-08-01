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

  for (const tui of fixtures.tuis ?? []) {
    if (!tui) continue;
    try {
      await tui.killAndWait();
    } catch (error) {
      errors.push(error);
    }
  }

  for (const server of fixtures.mockServers ?? []) {
    if (!server) continue;
    try {
      server.assertComplete();
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

  for (const workspace of fixtures.workspaces ?? []) {
    if (!workspace) continue;
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
