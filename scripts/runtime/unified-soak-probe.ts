import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { CLIServiceArtifact } from '@kite-ai/cli/host';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { runFunctionalCase } from '../../tests/fixtures/unified-agent/soak/cases';
import { runContinuousSchedule } from '../../tests/fixtures/unified-agent/soak/continuous';
import { runTuiCase } from '../../tests/fixtures/unified-agent/soak/tui';
import { type CaseEvidence, sampleSoakResources, UNIFIED_SOAK_CASES } from './unified-soak-cases';

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(code);
}
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const deadline = performance.now() + 180_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (performance.now() >= deadline) throw Error('operation_deadline');
    await Bun.sleep(10);
  }
}
function sample() {
  return sampleSoakResources();
}
export async function runProbe(
  root: string,
  mode: 'lifecycle' | 'crash' | 'recover',
  cycles: number,
  minimumDurationMs = 0,
) {
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'soak' });
  const storeId = (await store.getMetadata()).storeId;
  let calls = 0;
  let entered: (() => void) | undefined;
  let cancelled = false;
  const nonce = randomUUID();
  const runtime = createRuntime({
    store,
    modelId: 'fixed-soak',
    model: {
      async *stream(request, options) {
        calls++;
        appendFileSync(join(root, 'model-ledger'), `${calls}\n`, { mode: 0o600 });
        if (mode === 'crash') {
          yield {
            type: 'tool_call' as const,
            id: 'original-effect-call',
            name: 'soak.effect',
            arguments: '{}',
          };
          yield {
            type: 'finish' as const,
            reason: 'tool_calls' as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        const hold = JSON.stringify(request.messages).includes('hold-soak');
        if (hold) {
          yield { type: 'text_delta' as const, text: 'original partial' };
          entered?.();
          while (!options.signal?.aborted) await Bun.sleep(10);
          cancelled = true;
          throw Error('fixture_cancelled');
        }
        yield { type: 'text_delta' as const, text: 'fixed completed' };
        yield {
          type: 'finish' as const,
          reason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
    extensions:
      mode === 'crash'
        ? [
            {
              id: 'soak',
              version: '1',
              apiMajor: 1,
              tools: [
                {
                  id: 'soak.effect',
                  version: '1',
                  description: 'owned effect before result',
                  inputSchema: { type: 'object' },
                  async execute(_input, context) {
                    appendFileSync(join(root, 'effect-ledger'), `${context.executionId}\n`, {
                      mode: 0o600,
                    });
                    writeFileSync(join(root, 'crash-entered'), 'entered', { mode: 0o600 });
                    while (!context.signal.aborted) await Bun.sleep(10);
                    throw Error('cancelled');
                  },
                },
              ],
            },
          ]
        : [],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'soak-only' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: join(root, 'data'), name: 'soak', accessKey: 'owned-soak' },
    subjectId: 'soak',
    buildId: 'unified-soak',
  });
  const makeClient = () =>
    createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        buildId: service.bootstrap.buildId,
        instanceId: service.bootstrap.instanceId,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
  let client = makeClient();
  const points: {
    sequence: number;
    before: ReturnType<typeof sample>['metrics'];
    after: ReturnType<typeof sample>['metrics'];
    observations: { before: ReturnType<typeof sample>; after: ReturnType<typeof sample> };
    durationMs: number;
    assertions: string[];
  }[] = [];
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    if (mode === 'recover') {
      const original = await store.getView('crashed');
      const originalIds = original.executions.map((value) => value.id);
      const result = await client.recoverSession('crashed', {
        expectedStoreId: storeId,
        kind: 'session.recover',
        commandId: 'interrupt-original',
        decision: 'interrupt',
      });
      assert(result.status === 'applied', 'interrupt_not_applied');
      const same = await client.getCommand('interrupt-original');
      assert(same?.id === result.id, 'receipt_changed');
      const after = await client.getView('crashed');
      assert(
        JSON.stringify(after.executions.map((value) => value.id)) === JSON.stringify(originalIds),
        'recovery_added_execution',
      );
      assert(calls === 0, 'recovery_replayed_model');
      assert(
        after.executions.some((item) => item.kind === 'tool' && item.status === 'outcome_unknown'),
        'unknown_effect_not_retained',
      );
      return {
        mode,
        pid: process.pid,
        nonce,
        identities: original.executions.map((v) => ({
          storeId: v.originStoreId,
          sessionId: v.sessionId,
          runId: v.runId,
          executionId: v.id,
          commandId: v.originCommandId,
        })),
        assertions: [
          'original_interrupt',
          'zero_model_replay',
          'original_execution_ids',
          'unknown_retained',
        ],
        points: [],
        calls,
        effectLedgerLines: readFileSync(join(root, 'effect-ledger'), 'utf8').trim().split('\n')
          .length,
      };
    }
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: new URL(`file://${root}/`).href,
      name: 'Disposable',
    });
    const workloadStarted = performance.now();
    let completedCycles = 0;
    let boundary: { observation: ReturnType<typeof sample>; started: number } | undefined;
    for (
      let sequence = 0;
      mode === 'crash'
        ? sequence < 1
        : points.length < cycles || performance.now() - workloadStarted < minimumDurationMs;
      sequence++
    ) {
      Bun.gc(true);
      await Bun.sleep(0);
      operationTimer ??= setTimeout(() => {
        console.error('operation_deadline');
        process.exit(1);
      }, 180_000);
      try {
        boundary ??= { observation: sample(), started: performance.now() };
        const beforeObservation = boundary.observation,
          before = beforeObservation.metrics,
          started = boundary.started;
        const sessionId = mode === 'crash' ? 'crashed' : `s-${sequence}`;
        await client.createSession({
          expectedStoreId: storeId,
          commandId: `create-${sequence}`,
          sessionId,
          workspaceId: 'w',
          title: 'fixed workload',
        });
        const commandId = `work-${sequence}`;
        const command = await client.startRun(sessionId, {
          kind: 'run.start',
          expectedStoreId: storeId,
          commandId,
          content: mode === 'crash' ? 'hold-soak' : 'complete-soak',
        });
        if (mode === 'crash') {
          await new Promise<never>(() => {});
        }
        const applied = await until(
          () => client.getCommand(commandId),
          (value) => value?.status === 'applied',
        );
        const receipt = applied?.receipt;
        assert(
          receipt &&
            typeof receipt === 'object' &&
            !Array.isArray(receipt) &&
            typeof receipt.runId === 'string',
          'run_receipt_missing',
        );
        const runId = receipt.runId;
        const run = await until(
          () => client.getRun(runId),
          (value) => value?.status === 'completed',
        );
        assert(run?.originCommandId === command.id, 'run_identity_changed');
        client.disposeNetwork();
        client = makeClient();
        await client.connect();
        assert(
          (await client.getCommand(commandId))?.id === command.id,
          'reconnect_receipt_changed',
        );
        const cancelSession = `cancel-${sequence}`;
        await client.createSession({
          expectedStoreId: storeId,
          commandId: `create-cancel-${sequence}`,
          sessionId: cancelSession,
          workspaceId: 'w',
          title: 'cancel workload',
        });
        cancelled = false;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const holding = await client.startRun(cancelSession, {
          kind: 'run.start',
          expectedStoreId: storeId,
          commandId: `hold-${sequence}`,
          content: 'hold-soak',
        });
        await waiting;
        await client.cancelCommand(cancelSession, {
          kind: 'command.cancel',
          expectedStoreId: storeId,
          commandId: `cancel-command-${sequence}`,
          targetCommandId: holding.id,
        });
        const settled = await until(
          () => client.getView(cancelSession),
          (value) => value.runs.length > 0 && value.runs.every((item) => !item.isActive),
        );
        assert(
          cancelled &&
            settled.executions.every((value) =>
              ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(value.status),
            ),
          'cancel_not_settled',
        );
        for (const id of [sessionId, cancelSession]) {
          const view = await client.getView(id);
          await client.deleteSession(id, {
            expectedStoreId: storeId,
            commandId: `delete-${id}`,
            ifRevision: view.session.controlRevision,
          });
        }
        entered = undefined;
        Bun.gc(true);
        await Bun.sleep(0);
        completedCycles++;
        // Warmup then fixed observations across actual active work. Never
        // replace the earlier measured boundaries with the final few cycles.
        const target =
          cycles === 1 ? minimumDurationMs : (points.length * minimumDurationMs) / (cycles - 1);
        if (performance.now() - workloadStarted >= target) {
          const afterObservation = sample();
          points.push({
            sequence: points.length,
            before,
            after: afterObservation.metrics,
            observations: { before: beforeObservation, after: afterObservation },
            durationMs: performance.now() - started,
            assertions: [
              'completed',
              'cancel_settled',
              'reconnected_original_receipt',
              'sessions_deleted',
            ],
          });
          boundary = undefined;
        }
      } finally {
        if (!boundary) {
          clearTimeout(operationTimer);
          operationTimer = undefined;
        }
      }
    }
    return {
      mode,
      pid: process.pid,
      nonce,
      assertions: ['same_process_lifecycle'],
      points,
      calls,
      completedCycles,
      workloadDurationMs: performance.now() - workloadStarted,
    };
  } finally {
    clearTimeout(operationTimer);
    client.disposeNetwork();
    await service.close();
    await runtime.close();
    await store.close();
  }
}
export async function runCaseMatrix(root: string, cycles: number, artifact: CLIServiceArtifact) {
  const cases: CaseEvidence[] = [];
  for (const caseId of UNIFIED_SOAK_CASES) {
    if (caseId === 'runtime_sigkill_recovery') continue; // The parent owns kill/reap and cold observer.
    if (caseId === 'tui_lifecycle_churn') {
      cases.push(
        await runTuiCase(
          join(root, caseId),
          artifact,
          join(import.meta.dir, 'unified-soak-cases.js'),
          cycles === 9 ? 9 : 2,
        ),
      );
      continue;
    }
    let combined: CaseEvidence | undefined;
    for (let sequence = 0; sequence < cycles; sequence++) {
      Bun.gc(true);
      await Bun.sleep(0);
      Bun.gc(true);
      await Bun.sleep(0);
      const beforeObservation = sample();
      const directory = join(root, `${caseId}-${sequence}`);
      const operationTimer = setTimeout(() => {
        console.error('operation_deadline');
        process.exit(1);
      }, 180_000);
      let result: CaseEvidence;
      try {
        result = await runFunctionalCase(directory, caseId);
      } finally {
        clearTimeout(operationTimer);
      }
      Bun.gc(true);
      await Bun.sleep(0);
      Bun.gc(true);
      await Bun.sleep(0);
      const afterObservation = sample();
      const point = {
        sequence,
        before: beforeObservation.metrics,
        after: afterObservation.metrics,
        observations: { before: beforeObservation, after: afterObservation },
        ...(result.identities ? { identities: result.identities } : {}),
        durationMs: result.durationMs,
        assertions: result.assertions,
      };
      if (!combined) combined = { ...result, points: [point] };
      else {
        combined.points!.push(point);
        combined.durationMs += result.durationMs;
        combined.workloadDurationMs += result.workloadDurationMs;
        combined.cleanupConfirmed &&= result.cleanupConfirmed;
        if (result.status !== 'passed') combined.status = result.status;
        combined.unavailable.push(...result.unavailable);
      }
      if (result.status !== 'passed') break;
    }
    cases.push(combined!);
  }
  return cases;
}
if (import.meta.main) {
  try {
    const root = process.argv[2]!,
      mode = process.argv[3] as 'lifecycle' | 'crash' | 'recover';
    if ((mode as string) === 'continuous') {
      const scheduleMode = process.argv[5];
      if (scheduleMode !== 'diagnostic' && scheduleMode !== 'formal')
        throw Error('invalid_continuous_mode');
      const result = await runContinuousSchedule(root, scheduleMode, undefined, process.argv[6]);
      writeFileSync(join(root, 'continuous.json'), JSON.stringify(result), { mode: 0o600 });
    } else if ((mode as string) === 'cases') {
      const artifact = JSON.parse(readFileSync(process.argv[5]!, 'utf8')) as CLIServiceArtifact;
      const result = await runCaseMatrix(root, Number(process.argv[4] ?? 2), artifact);
      writeFileSync(join(root, 'cases.json'), JSON.stringify(result), { mode: 0o600 });
    } else {
      if (!['lifecycle', 'crash', 'recover'].includes(mode)) throw Error('invalid_probe_mode');
      const result = await runProbe(
        root,
        mode,
        Number(process.argv[4] ?? 2),
        Number(process.argv[5] ?? 0),
      );
      writeFileSync(join(root, `${mode}.json`), JSON.stringify(result), { mode: 0o600 });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'probe_failed');
    process.exitCode = 1;
  }
}
