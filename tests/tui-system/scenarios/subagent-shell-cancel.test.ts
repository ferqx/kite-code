import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { waitForCondition } from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedTurnEvents } from '../harness/test-workspace';

// Actual POSIX host-shell evidence. Windows process-tree qualification belongs
// to the native sandbox suite, not this explicit no-sandbox configuration.
const posixTest = process.platform === 'win32' ? test.skip : test;
posixTest(
  'cancels an executing child process and persists cleanup before the successor',
  async () => {
    const workspace = createTestWorkspace({
      configOverrides: { language: 'en-US', interactionMode: 'full', sandbox: { enabled: false } },
    });
    const server = createMockModelServer();
    let tui: PtyProcess | undefined;
    const prompt = 'CANCEL_REAL_CHILD_PROCESS';
    const heartbeat = join(workspace.workspace, 'heartbeat.txt');
    const pidfile = join(workspace.workspace, 'child.pid');
    const sentinel = join(workspace.workspace, 'late-side-effect.txt');
    const program = join(workspace.workspace, 'heartbeat.ts');
    writeFileSync(
      program,
      `import { writeFileSync, appendFileSync } from 'node:fs';
writeFileSync('child.pid', String(process.pid));
for (let i=0; i<300; i++) {
  appendFileSync('heartbeat.txt', String(i)+'\\n');
  await Bun.sleep(100);
}
writeFileSync('late-side-effect.txt', 'unexpected completion');
`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `${quote(process.execPath)} ${quote(program)}`;
    server.setResponses([
      {
        toolContinuation: 'aborted',
        message: {
          tool_calls: [
            {
              id: 'parent-child',
              name: 'task',
              args: {
                name: 'Cancellable shell child',
                subagent_type: 'code',
                task: 'Run the heartbeat command.',
              },
            },
          ],
        },
      },
      {
        toolContinuation: 'aborted',
        message: {
          tool_calls: [
            {
              id: 'child-shell',
              name: 'shell_execute',
              // This extra model field is stripped by parsing. Suspension must carry
              // the parsed arguments matching the exact approval binding.
              args: { command, timeout: 60_000 },
            },
          ],
        },
      },
      { message: { content: 'SUCCESSOR_AFTER_PROCESS_CLEANUP' } },
    ]);
    function observe() {
      const observation = observePersistedTurnEvents(workspace, prompt);
      if (observation.status !== 'ready' || !observation.value) return undefined;
      const db = new Database(observation.path, { readonly: true });
      try {
        const sid = observation.value.threadId;
        const row = db
          .query<{ state_json: string }, [string]>(
            'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
          )
          .get(sid);
        const events = db
          .query<{ sequence: number; event_json: string }, [string]>(
            'SELECT sequence,event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
          )
          .all(sid)
          .map((row) => ({ sequence: row.sequence, event: JSON.parse(row.event_json) }));
        const runs = db
          .query<{ status: string; created_revision: number; last_revision: number }, [string]>(
            'SELECT status,created_revision,last_revision FROM runtime_runs WHERE session_id=? ORDER BY created_revision',
          )
          .all(sid);
        return { state: JSON.parse(row!.state_json), events, runs };
      } finally {
        db.close();
      }
    }
    try {
      tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitUserMessage(tui, server, prompt, { timeout: 15_000 });
      let approvalSent = false;
      await waitForCondition(
        () => {
          const state = observe()?.state;
          if (
            !approvalSent &&
            state?.interactions.kind === 'awaiting_tool_approval' &&
            tui!.viewport().includes('Allow once')
          ) {
            approvalSent = true;
            tui!.write('\r');
          }
          return (
            existsSync(heartbeat) && readFileSync(heartbeat, 'utf8').trim().split('\n').length >= 3
          );
        },
        'actual child process writes heartbeats',
        15_000,
      );
      const pid = Number(readFileSync(pidfile, 'utf8'));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          return false;
        }
      };
      expect(alive()).toBe(true);
      tui.write('\x1b');
      await waitForCondition(() => !alive(), 'child OS process exits after cancellation', 10_000);
      await waitForCondition(
        () => {
          const observation = observe();
          return (
            observation?.runs[0]?.status === 'cancelled' &&
            observation.events.some(
              ({ event }) =>
                event.type === 'capability.subagent_cleanup_completed' &&
                event.cleanupConfirmed === true,
            )
          );
        },
        'Server persists cancelled Run and confirmed child cleanup',
        10_000,
      );
      const stable = readFileSync(heartbeat, 'utf8');
      await Bun.sleep(2_200);
      expect(alive()).toBe(false);
      expect(readFileSync(heartbeat, 'utf8')).toBe(stable);
      expect(existsSync(sentinel)).toBe(false);
      await submitUserMessage(tui, server, 'Run the successor after child cleanup', {
        timeout: 15_000,
      });
      await waitForCondition(
        () => observe()?.runs[1]?.status === 'completed',
        'successor Run completes in Store',
        15_000,
      );
      const final = observe()!;
      const cancelled = final.events.find(({ event }) => event.type === 'turn.aborted')!;
      const cleanup = final.events.filter(
        ({ event }) => event.type === 'capability.subagent_cleanup_completed',
      );
      expect(cleanup.every(({ event }) => event.cleanupConfirmed === true)).toBe(true);
      const lastCleanup = cleanup.at(-1)!;
      // Approval suspends and cleans up the child Driver before the Host
      // executes its approved shell. Cancellation here stops that real shell;
      // it must not fabricate a second cleanup event for an inactive Driver.
      const shellStart = final.events.find(
        ({ event }) => event.type === 'tool.started' && event.toolCallId !== 'parent-child',
      )!;
      expect(lastCleanup.sequence).toBeLessThan(shellStart.sequence);
      expect(shellStart.sequence).toBeLessThan(cancelled.sequence);
      expect(final.runs[1]!.created_revision).toBeGreaterThan(lastCleanup.sequence);
      expect(final.state.tools.calls['parent-child'].status).toBe('cancelled');
      expect(final.state.turn.status).toBe('completed');
      expect(
        final.events.filter(
          ({ sequence, event }) =>
            sequence > cancelled.sequence &&
            sequence < final.runs[1]!.created_revision &&
            [
              'tool.started',
              'capability.execution_started',
              'model.invocation_attempt_started',
            ].includes(event.type),
        ),
      ).toEqual([]);
      console.log(
        JSON.stringify({
          pid,
          processExited: !alive(),
          heartbeatStable: true,
          delayedSideEffect: false,
          cancelRevision: cancelled.sequence,
          cleanupRevision: lastCleanup.sequence,
          runs: final.runs,
        }),
      );
    } catch (error) {
      console.error('Child cancellation evidence failed:', error, observe()?.runs);
      throw error;
    } finally {
      await cleanupTuiSystemFixtures({
        tuis: tui ? [tui] : [],
        mockServers: [server],
        workspaces: [workspace],
      });
    }
  },
  60_000,
);
