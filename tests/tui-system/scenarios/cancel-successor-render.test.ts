/**
 * PTY regression for the Windows cancellation/render race.
 *
 * A cancelled shell can spend noticeable time unwinding its process tree and
 * sandbox resources. The user is allowed to submit one successor prompt during
 * that cleanup window. The prompt must render once, the older run must not
 * reset the successor to idle, and the successor tool card must remain dynamic
 * so live output continues to repaint.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { tuiSystemDelay } from '../harness/cancellation';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import {
  activeInput,
  submitCurrentInput,
  submitUserMessage,
  typeText,
  waitForRequestMessage,
} from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 45_000;

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
type OldShell = {
  id: string;
  state: string;
  completed_cursor: number | null;
  cancel_requested_at: number | null;
  root_cancel_requested_at: number | null;
  root_active: number;
  carrier_id: string;
  carrier_state: string;
  carrier_started_marker: number;
  carrier_cancel_requested_at: number | null;
  carrier_completed_cursor: number | null;
};

describe('TUI PTY System — cancel shell then render successor', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        language: 'en-US',
        // The fixture disables native sandboxing to exercise a synthetic slow
        // process-tree cleanup. Full is the only Shell mode admitted without
        // a restricted sandbox backend.
        interactionMode: 'full',
        sandbox: { enabled: false },
      },
    });
    server.setResponses([
      {
        message: {
          content: 'Starting the cancellable shell.',
          tool_calls: [
            {
              id: 'old-shell',
              name: 'shell_execute',
              args: { command: 'pwd' },
            },
          ],
        },
        toolContinuation: 'aborted',
      },
      {
        message: {
          content: 'Starting the successor shell.',
          tool_calls: [
            {
              id: 'successor-shell',
              name: 'shell_execute',
              args: { command: 'pwd' },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'successor-shell',
              contentIncludes: ['SUCCESSOR_LINE_ONE', 'SUCCESSOR_LINE_TWO'],
            },
          ],
        },
        message: {
          reasoning_chunks: ['Checking the successor lifecycle.'],
          content_chunks: ['Successor completed once', '.'],
        },
      },
    ]);

    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      entryPath: resolve(import.meta.dir, '..', 'fixtures', 'cancel-successor-tui.tsx'),
      mockServer: server,
      workspace,
    });
  });

  afterAll(async () => {
    // Exit through the TUI so Windows releases the PTY and temporary workspace
    // before the generic process-tree fallback runs.
    if (tui) {
      tui.write('\x03');
      await tuiSystemDelay(100);
      tui.write('\x03');
      await tui.waitForExit().catch(() => {});
    }
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'queues one successor prompt and keeps its shell card live without duplicate messages',
    async () => {
      await submitUserMessage(tui, server, 'start old shell', { delayMs: 0, timeout: 15_000 });
      let oldShell: OldShell | undefined;
      const readOldShell = () => {
        const observed = observePersistedTurnEvents(workspace, 'start old shell');
        if (observed.status !== 'ready' || !observed.value) return undefined;
        using db = new Database(workspace.databasePath, { readonly: true });
        return (
          db
            .query<OldShell, [string, string]>(`
          SELECT p.id,p.state,p.completed_cursor,p.cancel_requested_at,
            r.cancel_requested_at AS root_cancel_requested_at,r.is_active AS root_active,
            c.id AS carrier_id,c.state AS carrier_state,
            c.cancel_requested_at AS carrier_cancel_requested_at,
            c.completed_cursor AS carrier_completed_cursor,
            EXISTS(SELECT 1 FROM execution_output o WHERE o.execution_id=c.id
              AND instr(CAST(o.content AS TEXT),'OLD_SHELL_RUNNING')>0) AS carrier_started_marker
          FROM execution p JOIN run r ON r.id=p.run_id AND r.session_id=p.session_id
          JOIN execution c ON c.parent_execution_id=p.id AND c.kind='job'
          WHERE p.run_id=? AND p.session_id=? AND p.kind='tool' AND p.call_id='old-shell'
            AND c.origin_store_id=p.origin_store_id AND p.origin_store_id=r.origin_store_id
            AND c.session_id=p.session_id AND c.root_session_id=p.root_session_id
            AND c.root_work_command_id=p.root_work_command_id
            AND c.root_work_seq=p.root_work_seq
            AND p.root_work_command_id=r.root_work_command_id AND p.root_work_seq=r.root_work_seq
        `)
            .get(observed.value.turnId, observed.value.threadId) ?? undefined
        );
      };
      // A planned Tool card can render before Job.start. Cancel only after the
      // exact owned carrier has really started and saved its first output, so
      // this journey exercises cancellation during the fixture's stop window.
      await waitForCondition(
        () => {
          const shell = readOldShell();
          return (
            screenContains(tui.viewport(), 'Bash pwd') &&
            shell?.root_active === 1 &&
            ['dispatching', 'running'].includes(shell.state) &&
            shell.carrier_state === 'running' &&
            shell.carrier_started_marker === 1 &&
            shell.root_cancel_requested_at === null &&
            shell.cancel_requested_at === null &&
            shell.carrier_cancel_requested_at === null
          );
        },
        'the visible original shell and its exact running carrier output',
        15_000,
        25,
      );
      tui.write('\x03');
      // Do not use waitForTuiReady here: its output-quiescence phase can spend
      // the whole synthetic cleanup window waiting on animated frames. We only
      // need proof that cancellation reopened the main input before submitting.
      await waitForCondition(
        () => {
          const input = activeInput(tui.inputViewport());
          return (
            input?.kind === 'main' &&
            input.value === '' &&
            !screenContains(tui.viewport(), 'Working')
          );
        },
        'main input after cancellation',
        2_000,
        25,
      );
      await waitForCondition(
        () => {
          oldShell = readOldShell();
          return (
            !!oldShell &&
            oldShell.root_active === 1 &&
            oldShell.root_cancel_requested_at !== null &&
            oldShell.cancel_requested_at !== null &&
            oldShell.carrier_cancel_requested_at !== null &&
            ['planned', 'dispatching', 'running'].includes(oldShell.state) &&
            ['planned', 'dispatching', 'running'].includes(oldShell.carrier_state) &&
            oldShell.completed_cursor === null &&
            oldShell.carrier_completed_cursor === null
          );
        },
        'durable original cancellation request with its exact Tool and carrier still nonterminal',
        5_000,
        25,
      );

      const successorRequestBaseline = server.getRequestCount();
      // Workspace-baseline Shell executes directly in Auto. The cancelled run
      // therefore made exactly one primary-model request and no reviewer call.
      expect(successorRequestBaseline).toBe(1);

      await typeText(tui, 'continue with successor', 0);
      // Record an explicit semantic input lifecycle. The successor is expected
      // to remain queued until predecessor cleanup completes, so submission
      // only waits for Ink to accept the input rather than for a model request.
      await submitCurrentInput(tui, { submitReceiptTimeoutMs: 2_000 });

      // The successor is accepted while the cancelled predecessor is still
      // unwinding, but Runtime Server V1 does not retain queued user text in
      // the terminal projection. Its durable receipt is the absence of a
      // second model request during this cleanup window.
      await tuiSystemDelay(250);
      expect(server.getRequestCount()).toBe(successorRequestBaseline);

      await waitForRequestMessage(server, 'continue with successor', 15_000, {
        since: successorRequestBaseline,
        tui,
      });

      const progressFrames = tui.markScreen();
      await waitForCondition(
        () =>
          tui
            .screenFramesSince(progressFrames)
            .some(
              (frame) =>
                screenContains(frame, 'Bash') &&
                !screenContains(frame, 'Successor completed once.'),
            ),
        'a live successor shell tool card',
        15_000,
        25,
      );

      await waitForText(() => tui.viewport(), 'Successor completed once.', 15_000);
      await waitForTuiReady(tui);
      const terminal = readOldShell();
      expect(terminal?.id).toBe(oldShell!.id);
      expect(terminal?.carrier_id).toBe(oldShell!.carrier_id);
      expect(terminal?.state).toBe('cancelled');
      expect(terminal?.carrier_state).toBe('cancelled');
      expect(terminal!.completed_cursor).toBeGreaterThan(0);
      expect(terminal!.carrier_completed_cursor).toBeGreaterThan(0);
      const successor = requirePersistedRuntimeReady(
        observePersistedTurnEvents(workspace, 'continue with successor'),
      );
      expect(successor).toBeDefined();
      const successorStarted = successor!.events.find(
        (event) => event.sourceType === 'run.started',
      );
      expect(Number(successorStarted?.sourceCursor)).toBeGreaterThan(terminal!.completed_cursor!);
      expect(Number(successorStarted?.sourceCursor)).toBeGreaterThan(
        terminal!.carrier_completed_cursor!,
      );

      // A single correct progress frame is insufficient: retain every parsed
      // successor frame and reject duplicated live tool headers throughout.
      for (const frame of tui.screenFramesSince(progressFrames)) {
        const boundary = frame.indexOf('❯ continue with successor');
        const successorFrame = boundary < 0 ? frame : frame.slice(boundary);
        expect((successorFrame.match(/^.*Bash.*$/gm) ?? []).length).toBeLessThanOrEqual(1);
        expect((frame.match(/Successor completed once\./g) ?? []).length).toBeLessThanOrEqual(1);
      }
      const finalScreen = stripAnsi(tui.scrollback());
      expect(finalScreen).toContain('OLD_SHELL_RUNNING');
      expect(finalScreen).toContain('cancelled');
      expect(occurrenceCount(finalScreen, 'continue with successor')).toBe(1);
      expect(occurrenceCount(finalScreen, 'Successor completed once.')).toBe(1);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
