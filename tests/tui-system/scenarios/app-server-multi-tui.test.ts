import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30_000;

describe('TUI PTY System — parent-owned App Servers', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let first: PtyProcess;
  let second: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({ configOverrides: { sandbox: { enabled: false } } });
    server.setResponses([{ message: { content: 'Shared durable history is ready.' } }]);
    first = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [first, second],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  step(
    'keeps two TUI-owned App Servers independent while sharing durable History',
    async () => {
      await submitUserMessage(first, server, 'History from the first TUI', { timeout: 15_000 });
      await waitForText(
        () => first.outputSinceLastAction(),
        'Shared durable history is ready.',
        15_000,
      );

      server.setResponses([]);
      second = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitCommand(second, '/resume');
      await waitForCondition(
        () =>
          screenHasSessionRow(second.viewport(), 'History from the first TUI', {
            active: false,
          }),
        'second TUI App Server to read the first TUI Session',
        10_000,
      );
      expect(screenContains(first.viewport(), '❯')).toBe(true);
      second.write('\x1b');
      await waitForCondition(
        () => !screenContains(second.viewport(), '会话列表') && second.focusedMainInputReady(),
        'second TUI main input to regain focus',
        5_000,
      );

      await submitCommand(first, '/status');
      await waitForText(() => first.outputSinceLastAction(), 'App Server 传输: stdio', 10_000);
      await waitForText(() => first.viewport(), '客户端与 App Server 已精确配对', 5_000);
      expect(screenContains(first.viewport(), '客户端与 App Server 已精确配对')).toBe(true);
      expect(screenContains(first.viewport(), 'Service PID')).toBe(false);
      expect(screenContains(first.viewport(), 'Kite Web')).toBe(false);
      const firstStatus = stripAnsi(first.viewport());
      const firstInstance = firstStatus.match(/(?:实例：|Instance:)\s*(\S+)/)?.[1];
      const firstStore = firstStatus.match(/(?:Store：|Store:)\s*(\S+)/)?.[1];
      expect(firstInstance).toBeDefined();
      expect(firstStore).toBeDefined();

      await submitCommand(second, '/status');
      await waitForText(() => second.outputSinceLastAction(), 'App Server 传输: stdio', 10_000);
      await waitForText(() => second.viewport(), '客户端与 App Server 已精确配对', 5_000);
      expect(screenContains(second.viewport(), '客户端与 App Server 已精确配对')).toBe(true);
      const secondStatus = stripAnsi(second.viewport());
      const secondInstance = secondStatus.match(/(?:实例：|Instance:)\s*(\S+)/)?.[1];
      const secondStore = secondStatus.match(/(?:Store：|Store:)\s*(\S+)/)?.[1];
      expect(secondInstance).toBeDefined();
      expect(secondInstance).not.toBe(firstInstance);
      expect(secondStore).toBe(firstStore);
      expect(server.getWorkRequestCount()).toBe(1);

      first.write('\x1b');
      await waitForCondition(
        () => first!.focusedMainInputReady(),
        'status closes back to the original main input',
        5_000,
      );
      await submitCommand(first, '/exit');
      expect(await first.waitForExit()).toBe(0);
      second.write('\x1b');
      await waitForCondition(
        () => second.focusedMainInputReady(),
        'second paired TUI remains live after first closes',
        5_000,
      );
      await submitCommand(second, '/status');
      await waitForText(() => second.viewport(), secondInstance!, 5_000);
      await waitForText(() => second.viewport(), '客户端与 App Server 已精确配对', 5_000);
      expect(screenContains(second.viewport(), '客户端与 App Server 已精确配对')).toBe(true);
      second.write('\x1b');
      await waitForCondition(
        () => second!.focusedMainInputReady(),
        'status closes back to the original main input',
        5_000,
      );
      await submitCommand(second, '/exit');
      expect(await second.waitForExit()).toBe(0);
    },
    TIMEOUT,
  );

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
