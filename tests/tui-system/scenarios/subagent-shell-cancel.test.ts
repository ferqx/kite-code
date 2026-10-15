import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  inspectProcess,
  readProcessStartIdentity,
} from '../../../apps/service/src/daemon/process-identity';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition } from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedTurnEvents } from '../harness/test-workspace';

type Execution = {
  id: string;
  session_id: string;
  run_id: string | null;
  state: string;
  result_json: string | null;
  completed_cursor: number | null;
  child_session_id: string | null;
  root_work_command_id: string;
  root_work_seq: number;
  origin_store_id: string;
};
type Run = {
  id: string;
  session_id: string;
  status: string;
  is_active: number;
  origin_command_id: string;
};

test('cancels an executing child process and persists cleanup before the successor', async () => {
  const workspace = createTestWorkspace({
    configOverrides: { language: 'en-US', interactionMode: 'full', sandbox: { enabled: false } },
  });
  const server = createMockModelServer();
  let tui: PtyProcess | undefined;
  const prompt = 'CANCEL_REAL_CHILD_PROCESS';
  const successorPrompt = 'Run the successor after child cleanup';
  const heartbeat = join(workspace.workspace, 'heartbeat.txt');
  const pidfile = join(workspace.workspace, 'child.pid');
  const sentinel = join(workspace.workspace, 'late-side-effect.txt');
  const program = join(workspace.workspace, 'heartbeat.ts');
  writeFileSync(
    program,
    String.raw`import { writeFileSync, appendFileSync } from 'node:fs';
writeFileSync('child.pid', String(process.pid));
for (let i=0; i<300; i++) {
  appendFileSync('heartbeat.txt', String(i)+'\n');
  await Bun.sleep(100);
}
writeFileSync('late-side-effect.txt', 'unexpected completion');
`,
  );
  // Explicit argv for the current Tool's selected sh contract. Windows uses
  // native path spelling accepted by sh; missing native qualification fails,
  // rather than skipping the original process/cleanup assertions.
  const argv = [realpathSync(process.execPath), program];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = argv
    .map((value) => quote(process.platform === 'win32' ? value.replaceAll('\\', '/') : value))
    .join(' ');
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
            name: 'shell.execute',
            args: { key: 'original-child-shell', command, timeoutMs: 60_000 },
          },
        ],
      },
    },
    { message: { content: 'SUCCESSOR_AFTER_PROCESS_CLEANUP' } },
  ]);
  function observe() {
    const original = observePersistedTurnEvents(workspace, prompt);
    if (original.status !== 'ready' || !original.value) return undefined;
    const { threadId, turnId } = original.value;
    const db = new Database(original.path, { readonly: true });
    try {
      const root = db
        .query<Run, [string, string]>('SELECT * FROM run WHERE id=? AND session_id=?')
        .get(turnId, threadId)!;
      const task = db
        .query<Execution, [string, string]>(
          "SELECT * FROM execution WHERE run_id=? AND session_id=? AND kind='tool' AND call_id='parent-child'",
        )
        .get(turnId, threadId);
      const child =
        task &&
        db
          .query<Execution, [string]>(
            "SELECT * FROM execution WHERE parent_execution_id=? AND kind='job' AND child_session_id IS NOT NULL",
          )
          .get(task.id);
      const childRun =
        child &&
        db
          .query<Run, [string, string, number]>(
            'SELECT * FROM run WHERE session_id=? AND root_work_command_id=? AND root_work_seq=?',
          )
          .get(child.child_session_id!, child.root_work_command_id, child.root_work_seq);
      const shellTool =
        childRun &&
        db
          .query<Execution, [string, string]>(
            "SELECT * FROM execution WHERE run_id=? AND session_id=? AND kind='tool' AND call_id='child-shell'",
          )
          .get(childRun.id, childRun.session_id);
      const shell =
        shellTool &&
        db
          .query<Execution, [string]>(
            "SELECT * FROM execution WHERE parent_execution_id=? AND kind='job' AND adapter_id IN ('shell.command','builtin.shell/shell.command')",
          )
          .get(shellTool.id);
      const event = (id: string | undefined, type: string) =>
        id
          ? db
              .query<{ cursor: number }, [string, string]>(
                'SELECT cursor FROM change_event WHERE object_id=? AND type=? ORDER BY cursor LIMIT 1',
              )
              .get(id, type)?.cursor
          : undefined;
      const successor = db
        .query<Run & { started_cursor: number }, [string, string]>(`
        SELECT r.*,e.cursor AS started_cursor FROM run r
        JOIN message m ON m.run_id=r.id AND m.session_id=r.session_id
        JOIN message_part p ON p.message_id=m.id AND p.ordinal=0
        JOIN change_event e ON e.object_id=r.id AND e.scope_session_id=r.session_id AND e.type='run.started'
        WHERE r.session_id=? AND m.role='user' AND json_extract(p.json,'$.content')=?
      `)
        .get(threadId, successorPrompt);
      const cancelCursor = event(root.origin_command_id, 'command.cancel_requested');
      const afterCancelDispatches =
        cancelCursor && successor
          ? db
              .query<{ cursor: number; type: string }, [number, number, string]>(`
        SELECT e.cursor,e.type FROM change_event e JOIN execution x ON x.id=e.object_id
        WHERE e.cursor>? AND e.cursor<? AND e.type='execution.dispatching'
          AND x.root_work_command_id=(SELECT root_work_command_id FROM run WHERE id=?)
      `)
              .all(cancelCursor, successor.started_cursor, root.id)
          : [];
      return {
        root,
        task,
        child,
        childRun,
        shellTool,
        shell,
        shellStarted: event(shell?.id, 'execution.dispatching'),
        cancelCursor,
        rootFinished: event(root.id, 'run.finished'),
        successor,
        afterCancelDispatches,
      };
    } finally {
      db.close();
    }
  }
  try {
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await submitUserMessage(tui, server, prompt, { timeout: 15_000 });
    await waitForCondition(
      () => existsSync(heartbeat) && readFileSync(heartbeat, 'utf8').trim().split('\n').length >= 3,
      'actual child process writes heartbeats',
      15_000,
    );
    const pid = Number(readFileSync(pidfile, 'utf8'));
    const birth = readProcessStartIdentity(pid);
    expect(birth).toBeDefined();
    const alive = () => inspectProcess(pid, birth!) === 'alive';
    expect(alive()).toBe(true);
    const running = observe()!;
    expect(running.shell?.state).toBe('running');
    expect(running.shell?.session_id).toBe(running.childRun?.session_id);
    expect(running.shell?.origin_store_id).toBe(running.child?.origin_store_id);
    expect(running.shell?.root_work_command_id).toBe(running.child?.root_work_command_id);
    expect(running.shell?.root_work_seq).toBe(running.child?.root_work_seq);
    const cancelStarted = Date.now(),
      frames = tui.markScreen();
    tui.write('\x1b');
    await waitForCondition(
      () => tui!.screenFramesSince(frames).some((frame) => screenContains(frame, 'Cancelling')),
      'visible cancellation acknowledgement',
      1_000,
    );
    expect(Date.now() - cancelStarted).toBeLessThan(1_000);
    await waitForCondition(
      () => inspectProcess(pid, birth!) === 'dead',
      'child OS process exits after cancellation',
      10_000,
    );
    await waitForCondition(
      () => {
        const saved = observe();
        return (
          saved?.root.status === 'cancelled' &&
          saved.child?.state === 'cancelled' &&
          saved.childRun?.status === 'cancelled' &&
          saved.shell?.state === 'cancelled'
        );
      },
      'Server persists cancelled root/child Runs and actual Shell carrier cleanup',
      10_000,
    );
    const stopped = observe()!;
    expect(stopped.root.is_active).toBe(0);
    expect(stopped.childRun?.is_active).toBe(0);
    expect(stopped.task?.state).toBe('cancelled');
    expect(JSON.parse(stopped.shell!.result_json!)).toMatchObject({
      outcome: 'cancelled',
      details: { groupStopped: true },
    });
    expect(JSON.parse(stopped.child!.result_json!)).toMatchObject({
      outcome: 'cancelled',
      details: {
        childSessionId: stopped.child!.child_session_id,
        runId: stopped.childRun!.id,
        status: 'cancelled',
      },
    });
    const stable = readFileSync(heartbeat, 'utf8');
    await Bun.sleep(2_200);
    expect(inspectProcess(pid, birth!)).toBe('dead');
    expect(readFileSync(heartbeat, 'utf8')).toBe(stable);
    expect(existsSync(sentinel)).toBe(false);
    await submitUserMessage(tui, server, successorPrompt, { timeout: 15_000 });
    await waitForCondition(
      () => observe()?.successor?.status === 'completed',
      'successor Run completes in Store',
      15_000,
    );
    const final = observe()!;
    expect(final.shellStarted).toBeLessThan(final.cancelCursor!);
    expect(final.cancelCursor).toBeLessThan(final.shell!.completed_cursor!);
    expect(final.shell!.completed_cursor).toBeLessThan(final.child!.completed_cursor!);
    expect(final.child!.completed_cursor).toBeLessThan(final.successor!.started_cursor);
    expect(final.rootFinished).toBeLessThan(final.successor!.started_cursor);
    expect(final.task?.state).toBe('cancelled');
    expect(final.successor!.status).toBe('completed');
    expect(final.afterCancelDispatches).toEqual([]);
    expect(server.getRequestCount()).toBe(3);
    console.log(
      JSON.stringify({
        pid,
        processExited: !alive(),
        heartbeatStable: true,
        delayedSideEffect: false,
        cancelCursor: final.cancelCursor,
        shellCompletedCursor: final.shell!.completed_cursor,
        childCompletedCursor: final.child!.completed_cursor,
        successorStartedCursor: final.successor!.started_cursor,
      }),
    );
  } catch (error) {
    const saved = observe();
    const terminal = (execution: Execution | null | undefined) =>
      execution && {
        id: execution.id,
        state: execution.state,
        completedCursor: execution.completed_cursor,
        result: execution.result_json ? JSON.parse(execution.result_json) : null,
      };
    console.error(
      'Child cancellation evidence failed:',
      error,
      JSON.stringify({
        root: saved?.root && {
          id: saved.root.id,
          status: saved.root.status,
          active: saved.root.is_active,
        },
        task: terminal(saved?.task),
        child: terminal(saved?.child),
        childRun: saved?.childRun && {
          id: saved.childRun.id,
          status: saved.childRun.status,
          active: saved.childRun.is_active,
        },
        shellTool: terminal(saved?.shellTool),
        shell: terminal(saved?.shell),
        shellStarted: saved?.shellStarted,
        cancelCursor: saved?.cancelCursor,
        rootFinished: saved?.rootFinished,
      }),
    );
    console.error('Child cancellation viewport:', tui?.viewport());
    throw error;
  } finally {
    await cleanupTuiSystemFixtures({
      tuis: tui ? [tui] : [],
      mockServers: [server],
      workspaces: [workspace],
    });
  }
}, 60_000);
