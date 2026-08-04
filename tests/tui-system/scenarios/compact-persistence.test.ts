/**
 * PTY System Test — /compact command persistence
 *
 * This is intentionally independent from the session-switch regression.
 * It owns one Runtime Store and two TUI processes, proving that an exact
 * command event is replayed after a real process restart.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import {
  activateSessionSearch,
  submitCommand,
  submitCurrentInput,
  submitUserMessage,
  typeText,
} from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedCommandSession } from '../harness/test-workspace';

const TIMEOUT = 90_000;
const DURABLE_COMMAND_RECEIPT_TIMEOUT_MS = 30_000;

describe('TUI PTY System — /compact persistence', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'replays the exact command-bearing session after process restart',
    async () => {
      const sessionSearchIdentity = 'restart persistence target identity';
      const sessionResponse = 'Restart persistence target response';
      server.setResponses([{ message: { content: sessionResponse }, delay: 10 }]);
      await submitUserMessage(tui, server, sessionSearchIdentity, { timeout: 15_000 });
      await waitForText(() => tui.outputSinceLastAction(), sessionResponse, 15_000);
      await waitForTuiReady(tui);

      const command = '/compact restart-persistence-marker';
      let targetSession: { threadId: string; name: string } | undefined;
      await submitCommand(tui, command, undefined, {
        acceptWhen: () => {
          const observation = observePersistedCommandSession(workspace, command);
          if (observation.status !== 'ready') return false;
          targetSession = observation.value;
          return targetSession !== undefined;
        },
        requireAcceptWhen: true,
        semanticReceiptTimeoutMs: DURABLE_COMMAND_RECEIPT_TIMEOUT_MS,
      });
      expect(targetSession).toBeDefined();
      expect(targetSession!.name).not.toBe(targetSession!.threadId);

      await waitForTuiReady(tui);
      await submitCommand(tui, '/exit');
      await tui.waitForExit();

      server.setResponses([]);
      tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitCommand(tui, '/sessions');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'session selector chrome to finish its initial load',
        10_000,
      );

      await activateSessionSearch(tui);
      await typeText(tui, sessionSearchIdentity);
      await waitForCondition(
        () =>
          screenHasSessionRow(tui.viewport(), targetSession!.name, {
            active: false,
          }),
        'filtered command-bearing session row to load',
        10_000,
      );
      tui.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui.viewport(), targetSession!.name, {
            selected: true,
            active: false,
          }),
        'filtered command-bearing session row to become selected',
        5_000,
      );
      await submitCurrentInput(tui);
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, command) &&
            screenContains(viewport, '❯') &&
            !screenContains(viewport, '会话列表')
          );
        },
        'restarted TUI to replay the persisted compact command',
        15_000,
      );

      expect(screenContains(tui.viewport(), command)).toBe(true);
    },
    TIMEOUT,
  );
});
