import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OperationRef, PublicExecution, ToolContext } from '@kite-ai/agent/extensions';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import { createShellJob } from '../../../../src/jobs/shell';
import { openSqliteStore } from '../../../../src/sqlite';
import { AgentError } from '../../../../src/storage/types';
import { createShellExtension } from '../../../../src/tools/shell';
import { completeForegroundShell } from '../../../../src/tools/shell-foreground';

const ref: OperationRef = {
  originStoreId: 'store',
  sessionId: 'session',
  extensionId: 'builtin.shell',
  commandId: 'command',
  executionId: 'job',
  key: 'original',
};
function execution(status: PublicExecution['status'] = 'cancelled'): PublicExecution {
  return {
    id: ref.executionId!,
    sessionId: ref.sessionId,
    originStoreId: ref.originStoreId,
    runId: 'run',
    kind: 'job',
    definitionId: 'shell.command',
    resultRevision: '1',
    status,
    result: {
      outcome: status,
      content: `Shell ${status}`,
      details: {
        groupStopped: status !== 'outcome_unknown',
        processTreeStopped: status !== 'outcome_unknown',
      },
    },
  };
}
function context(controller: AbortController, get: () => Promise<PublicExecution | null>) {
  let waits = 0,
    dispatches = 0;
  const value = {
    signal: controller.signal,
    operations: {
      async wait(original: OperationRef) {
        expect(original).toEqual(ref);
        waits++;
        controller.abort(Error('cancel_requested'));
        throw controller.signal.reason;
      },
      async get(original: OperationRef) {
        expect(original).toEqual(ref);
        return get();
      },
      async ensure() {
        dispatches++;
        throw Error('must_not_restart');
      },
      async cancel() {
        dispatches++;
        throw Error('must_not_repeat_cancel');
      },
      async readOutput() {
        throw Error('cancelled_output_stays_in_original_reader');
      },
    },
  } as unknown as ToolContext;
  return { value, waits: () => waits, dispatches: () => dispatches };
}

test('a finite foreground deadline uses a bounded integer wait and keeps the original successful Job', async () => {
  const clock = spyOn(performance, 'now');
  try {
    for (const [deadline, elapsed, expected] of [
      [4000, 0.25, 3999],
      [1, 0.75, 1],
      [600000, 0.25, 30000],
    ] as const) {
      clock.mockReturnValueOnce(100).mockReturnValueOnce(100 + elapsed);
      const c = context(new AbortController(), async () => execution('running'));
      const waits: number[] = [];
      c.value.operations.wait = async (original, options) => {
        expect(original).toEqual(ref);
        const timeout = options?.timeoutMs;
        if (
          typeof timeout !== 'number' ||
          !Number.isSafeInteger(timeout) ||
          timeout < 0 ||
          timeout > 30000
        )
          throw new AgentError('invalid_wait_timeout');
        waits.push(timeout);
        return execution('succeeded');
      };
      c.value.operations.readOutput = async () => ({
        items: [],
        highWaterSeq: '0',
        nextAfterSeq: null,
      });
      const result = await completeForegroundShell(ref, c.value, deadline, 'standalone');
      expect(waits).toEqual([expected]);
      expect(result.outcome).toBe('succeeded');
      expect(result.details).toMatchObject({ timedOut: false, ref });
      expect(c.dispatches()).toBe(0);
    }
  } finally {
    clock.mockRestore();
  }
});

test('an omitted foreground deadline does not acquire the explicit ten-minute cancellation', async () => {
  const clock = spyOn(performance, 'now');
  try {
    for (const timeoutMs of [600000, undefined]) {
      clock.mockReset();
      clock.mockReturnValueOnce(100).mockReturnValue(600101);
      const c = context(new AbortController(), async () => execution('running'));
      let cancellations = 0;
      c.value.operations.cancel = async (original) => {
        expect(original).toEqual(ref);
        cancellations++;
      };
      c.value.operations.wait = async (original) => {
        expect(original).toEqual(ref);
        return execution(timeoutMs === undefined ? 'succeeded' : 'cancelled');
      };
      c.value.operations.readOutput = async () => ({
        items: [],
        highWaterSeq: '0',
        nextAfterSeq: null,
      });
      const result = await completeForegroundShell(ref, c.value, timeoutMs, 'standalone');
      expect(cancellations).toBe(timeoutMs === undefined ? 0 : 1);
      expect(result.details).toMatchObject({ timedOut: timeoutMs !== undefined });
      expect(result.outcome).toBe(timeoutMs === undefined ? 'succeeded' : 'failed');
      expect(c.dispatches()).toBe(0);
    }
  } finally {
    clock.mockRestore();
  }
});

test('planned waits do not consume execution budget and observed dispatch starts one non-resetting clock', async () => {
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  try {
    let phase: PublicExecution['status'] = 'planned';
    const c = context(new AbortController(), async () => execution(phase));
    const waits: number[] = [];
    let cancellations = 0;
    c.value.operations.wait = async (_original, options) => {
      waits.push(options!.timeoutMs!);
      if (waits.length <= 3) {
        now += 10000;
        if (waits.length === 3) phase = 'dispatching';
        throw new AgentError('wait_timeout');
      }
      if (waits.length <= 5) {
        now += waits.length === 4 ? 40 : 50;
        throw new AgentError('wait_timeout');
      }
      return execution('cancelled');
    };
    c.value.operations.cancel = async (original) => {
      expect(original).toEqual(ref);
      cancellations++;
    };
    c.value.operations.readOutput = async () => ({
      items: [],
      highWaterSeq: '0',
      nextAfterSeq: null,
    });
    const result = await completeForegroundShell(ref, c.value, 80, 'standalone');
    expect(waits).toEqual([25, 25, 25, 80, 40, 30000]);
    expect(cancellations).toBe(1);
    expect(result.outcome).toBe('failed');
    expect(result.details).toMatchObject({ timedOut: true });
    expect(c.dispatches()).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

for (const status of ['failed', 'cancelled', 'outcome_unknown'] as const)
  test(`an original Job ending before dispatch remains ${status} without an execution timeout`, async () => {
    const c = context(new AbortController(), async () => execution(status));
    c.value.operations.readOutput = async () => ({
      items: [],
      highWaterSeq: '0',
      nextAfterSeq: null,
    });
    const result = await completeForegroundShell(ref, c.value, 1, 'standalone');
    expect(result.outcome).toBe(status);
    expect(result.details).toMatchObject({ timedOut: false });
    expect(c.waits()).toBe(0);
    expect(c.dispatches()).toBe(0);
  });

test('external cancellation still observes the exact original stop while waiting for dispatch', async () => {
  const controller = new AbortController();
  const c = context(controller, async () =>
    execution(controller.signal.aborted ? 'cancelled' : 'planned'),
  );
  const result = await completeForegroundShell(ref, c.value, 1, 'standalone');
  expect(result.outcome).toBe('cancelled');
  expect(result.details).toMatchObject({ ref, cancellationObserved: true });
  expect(c.dispatches()).toBe(0);
  expect(c.waits()).toBe(1);
});

for (const timeoutMs of [600000, undefined])
  test(`foreground Shell abort with timeout=${timeoutMs ?? 'none'} waits for the exact owned stop`, async () => {
    const controller = new AbortController();
    let reads = 0;
    const c = context(controller, async () => (++reads === 1 ? execution('running') : execution()));
    const result = await completeForegroundShell(ref, c.value, timeoutMs, 'standalone');
    expect(reads).toBe(2);
    expect(c.waits()).toBe(1);
    expect(c.dispatches()).toBe(0);
    expect(result.outcome).toBe('cancelled');
    expect(result.details).toMatchObject({
      ref,
      cancellationObserved: true,
      execution: {
        id: 'job',
        status: 'cancelled',
        result: { details: { groupStopped: true, processTreeStopped: true } },
      },
    });
  });

test('foreground Shell abort retains an unknown stop and refuses foreign or missing terminal evidence', async () => {
  for (const observed of [
    execution('outcome_unknown'),
    { ...execution(), id: 'foreign-job' },
    { ...execution(), result: null },
  ]) {
    const controller = new AbortController();
    const c = context(controller, async () =>
      controller.signal.aborted ? observed : execution('running'),
    );
    const result = await completeForegroundShell(ref, c.value, 600000, 'standalone');
    expect(result.outcome).toBe('outcome_unknown');
    expect(c.dispatches()).toBe(0);
  }
});

test('abort during final Shell output reading does not lose an already recorded exact terminal stop', async () => {
  const controller = new AbortController();
  const c = context(controller, async () => execution());
  c.value.operations.wait = async () => execution();
  c.value.operations.readOutput = async () => {
    controller.abort(Error('cancel_requested'));
    throw controller.signal.reason;
  };
  const result = await completeForegroundShell(ref, c.value, 600000, 'standalone');
  expect(result.outcome).toBe('cancelled');
  expect(result.details).toMatchObject({ cancellationObserved: true });
  expect(c.dispatches()).toBe(0);
});

const posixTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
for (const slow of [false, true])
  posixTest(
    `execution deadline excludes real Job approval wait and still stops dispatched work: slow=${slow}`,
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-deadline-')));
      const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'fixture' });
      let runtime: ReturnType<typeof createRuntime> | undefined;
      try {
        const built = await Bun.build({
          entrypoints: [
            join(import.meta.dir, '../../../../src/platform/process/shell-supervisor.ts'),
          ],
          outdir: join(root, 'supervisor'),
          naming: 'supervisor.js',
          target: 'bun',
        });
        expect(built.success).toBe(true);
        const marker = join(root, 'effects');
        const deadlineMs = 500;
        const command = `printf 'started\\n' >> '${marker}'; ${slow ? 'sleep 20; ' : ''}printf 'completed\\n' >> '${marker}'`;
        const job = createShellJob({
          cwd: root,
          env: { PATH: '/usr/bin:/bin' },
          supervisorPath: built.outputs[0]!.path,
        });
        let starts = 0;
        const finish: Extract<ModelEvent, { type: 'finish' }> = {
          type: 'finish',
          reason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        const model = createFixedModel([
          [
            {
              type: 'tool_call',
              id: 'deadline-call',
              name: 'shell_execute',
              arguments: JSON.stringify({
                command,
                execution_timeout_ms: deadlineMs,
              }),
            },
            { ...finish, reason: 'tool_calls' },
          ],
          [finish],
        ]);
        runtime = createRuntime({
          store,
          model,
          modelId: 'fixed',
          permissions: {
            async authorize(request) {
              return request.kind === 'job'
                ? {
                    allowed: false,
                    revision: 'fixture-approval',
                    approval: { request: { title: 'Approve this exact Shell Job' } },
                  }
                : { allowed: true, revision: 'fixture-allow' };
            },
          },
          extensions: [
            createShellExtension({
              job: {
                ...job,
                async start(input, context) {
                  starts++;
                  return job.start(input, context);
                },
              },
            }),
          ],
        });
        const expectedStoreId = (await store.getMetadata()).storeId;
        await runtime.createWorkspace({
          expectedStoreId,
          id: 'w',
          rootUri: pathToFileURL(root).href,
          name: 'fixture',
        });
        await runtime.createSession({
          expectedStoreId,
          subjectId: 'owner',
          commandId: 'create',
          sessionId: 's',
          workspaceId: 'w',
          title: 'fixture',
        });
        await runtime.submitCommand({
          expectedStoreId,
          subjectId: 'owner',
          commandId: 'work',
          sessionId: 's',
          request: {
            kind: 'run.start',
            content: 'Execute the exact owned fixture command after approval.',
          },
        });
        const until = Date.now() + 5000;
        let card:
          | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
          | undefined;
        while (!card) {
          card = (
            await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
          ).interactions[0];
          if (Date.now() > until) throw Error('approval_not_created');
          if (!card) await Bun.sleep(10);
        }
        expect(card.definitionId).toBe('shell.command');
        await Bun.sleep(deadlineMs * 2 + 100);
        expect(starts).toBe(0);
        expect(existsSync(marker)).toBe(false);
        expect(
          (
            await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
          ).interactions.map((entry) => entry.id),
        ).toContain(card.id);
        expect((await store.getExecution(card.executionId))?.status).toBe('planned');
        await runtime.answerInteraction({
          expectedStoreId,
          subjectId: 'owner',
          commandId: 'approve',
          presentationSessionId: 's',
          interactionId: card.id,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        });
        await runtime.waitForCommand('work', { timeoutMs: 6000 });
        const rows = await store.listExecutions('s');
        const jobs = rows.filter((row) => row.definitionId === 'shell.command');
        const tool = rows.find((row) => row.definitionId === 'shell.execute')!;
        expect(starts).toBe(1);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.id).toBe(card.executionId);
        expect(jobs[0]!.parentExecutionId).toBe(tool.id);
        expect(jobs[0]!.status).toBe(slow ? 'cancelled' : 'succeeded');
        expect(jobs[0]!.result).toMatchObject({ details: { groupStopped: true } });
        expect(tool.status).toBe(slow ? 'failed' : 'succeeded');
        expect(tool.result).toMatchObject({ details: { timedOut: slow } });
        expect(readFileSync(marker, 'utf8')).toBe(slow ? 'started\n' : 'started\ncompleted\n');
        expect(model.requests).toHaveLength(2);
        const feedback = model.requests[1]!.messages.find(
          (message) => message.toolCallId === 'deadline-call',
        )!;
        expect(feedback.sourceIds).toEqual([tool.id]);
        expect(feedback.content).toContain(
          slow ? 'exceeded its execution deadline' : 'The command finished.',
        );
      } finally {
        if (runtime) await runtime.close();
        else await store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    15000,
  );
