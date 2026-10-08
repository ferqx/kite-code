import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RuntimeOptions } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import {
  busyDuration,
  CONTINUOUS_MINIMUM_BUSY_MS,
  type ContinuousEvidence,
  verifyContinuousEvidence,
} from '../../../../scripts/runtime/unified-soak-continuous';
import { until } from './common';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
/** Union of observed active intervals: parallel work never multiplies elapsed time. */
export function activeDuration(intervals: readonly (readonly [number, number])[]) {
  return busyDuration(intervals);
}

export async function openContinuousFixture(root: string) {
  const cleanup: (() => Promise<unknown>)[] = [];
  const closeResources = async () => {
    const failures: unknown[] = [];
    for (const close of cleanup.splice(0).reverse())
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, 'continuous_cleanup_failed');
  };
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const profile = { dataRoot: join(root, 'data'), name: 'continuous', accessKey: 'owned' };
    const stores: Awaited<ReturnType<typeof openSqliteStore>>[] = [];
    for (let index = 0; index < 2; index++) {
      const store = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.name,
      });
      stores.push(store);
      cleanup.push(() => store.close());
    }
    const storeId = (await stores[0]!.getMetadata()).storeId;
    let synchronousEffects = 0,
      childCalls = 0;
    const carriers = new Set<string>();
    const options: Omit<RuntimeOptions, 'store'> = {
      modelId: 'owned',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
      model: {
        async *stream(request) {
          let userIndex = -1;
          for (let index = request.messages.length - 1; index >= 0; index--)
            if (request.messages[index]!.role === 'user') {
              userIndex = index;
              break;
            }
          if (!request.messages.slice(userIndex + 1).some((message) => message.role === 'tool')) {
            yield { type: 'tool_call', id: 'sync', name: 'load.sync', arguments: '{}' };
            yield { type: 'tool_call', id: 'child', name: 'load.child', arguments: '{}' };
            yield { ...finish, reason: 'tool_calls' };
          } else {
            yield { type: 'text_delta', text: 'actual parent complete' };
            yield finish;
          }
        },
      },
      extensions: [
        {
          id: 'load',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'load.sync',
              version: '1',
              description: 'owned synchronous effect',
              inputSchema: { type: 'object' },
              async execute() {
                synchronousEffects++;
                return { outcome: 'succeeded', content: 'actual sync' };
              },
            },
            {
              id: 'load.child',
              version: '1',
              description: 'owned attached child',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                const operation = await context.operations.ensure({
                  key: `child-${context.runId}`,
                  cancellation: 'attached',
                  request: {
                    kind: 'agent',
                    configurationId: 'worker',
                    input: { content: 'actual child' },
                  },
                });
                if (!operation.executionId) throw Error('child_receipt_missing');
                carriers.add(operation.executionId);
                return { outcome: 'succeeded', content: 'original child dispatched' };
              },
            },
          ],
        },
      ],
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          modelId: 'child',
          toolIds: [],
          snapshot: {},
          model: {
            async *stream() {
              childCalls++;
              yield { type: 'text_delta', text: 'actual child complete' };
              yield finish;
            },
          },
        },
      ],
    };
    const runtimes: ReturnType<typeof createRuntime>[] = [];
    for (const store of stores) {
      const runtime = createRuntime({ ...options, store });
      runtimes.push(runtime);
      cleanup.push(() => runtime.close());
    }
    const services: Awaited<ReturnType<typeof startService>>[] = [];
    for (const runtime of runtimes) {
      const service = await startService({
        runtime,
        profile,
        subjectId: 'owned',
        buildId: 'continuous',
      });
      services.push(service);
      cleanup.push(() => service.close());
    }
    const clientFor = (index: number) =>
      createClient({
        endpoint: services[index]!.endpoint,
        token: services[index]!.bootstrap.token,
        expected: {
          profile,
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'events'],
        },
      });
    const clients = [clientFor(0), clientFor(1)],
      slow = clientFor(0);
    for (const client of [...clients, slow]) cleanup.push(async () => client.disposeNetwork());
    await Promise.all([...clients, slow].map((client) => client.connect()));
    await clients[0]!.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    const sessionIds = Array.from({ length: 20 }, (_, index) => `load-${index}`);
    for (const sessionId of sessionIds)
      await clients[0]!.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: 'owned load',
      });
    const initial = (await clients[0]!.getView(sessionIds[0]!)).snapshotCursor;
    const slowAbort = new AbortController();
    let releaseSlow!: () => void,
      slowEntered = false;
    const blocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowStream = slow
      .observe({
        cursor: { storeId, sequence: initial },
        sessionIds,
        signal: slowAbort.signal,
        async onChange() {
          slowEntered = true;
          await blocked;
        },
      })
      .catch((error: unknown) => {
        if (!slowAbort.signal.aborted) throw error;
      });
    cleanup.push(async () => {
      slowAbort.abort();
      releaseSlow();
      await slowStream;
    });
    const commands: string[] = [];
    let reconnects = 0,
      peerEvents = 0;
    const intervals: [number, number][] = [];
    const latencies: number[] = [];
    const wallStarted = performance.now();
    return {
      storeId,
      sessionIds,
      services,
      async cycle(signal?: AbortSignal) {
        const observerAbort = new AbortController();
        let ready = false;
        const observer = clients[1]!
          .observe({
            sessionIds,
            signal: observerAbort.signal,
            onReady() {
              ready = true;
            },
            onChange() {
              peerEvents++;
            },
          })
          .catch((error: unknown) => {
            if (!observerAbort.signal.aborted) throw error;
          });
        try {
          await until(async () => ready, Boolean);
          for (const [index, sessionId] of sessionIds.entries()) {
            if (signal?.aborted) throw Error('continuous_schedule_stopped');
            const begin = performance.now(),
              commandId = randomUUID();
            let stage = 'admission';
            try {
              const client = clients[index % 2]!;
              const acceptedAt = performance.now();
              await client.startRun(sessionId, {
                expectedStoreId: storeId,
                commandId,
                kind: 'run.start',
                content: 'load original run',
              });
              latencies.push(performance.now() - acceptedAt);
              commands.push(commandId);
              stage = 'command';
              const command = await until(
                () => clients[1]!.getCommand(commandId),
                (value) => value?.status === 'applied',
              );
              const runId = (command!.receipt as { runId: string }).runId;
              stage = 'run';
              await until(
                () => clients[(index + 1) % 2]!.getRun(runId),
                (value) => !!value && !value.isActive,
              );
              stage = 'view';
              const view = await clients[(index + 1) % 2]!.getView(sessionId);
              if (
                view.session.id !== sessionId ||
                !view.runs.some((run) => run.id === runId && run.status === 'completed')
              ) {
                console.error(
                  JSON.stringify({
                    sessionId,
                    runId,
                    runs: view.runs,
                    executions: view.executions,
                  }),
                );
                throw Error('original_run_scope_or_outcome');
              }
            } catch (error) {
              console.error(
                JSON.stringify({
                  caseId: 'continuous_operation_failure',
                  commandId,
                  sessionId,
                  stage,
                  elapsedMs: performance.now() - begin,
                  code: error instanceof Error ? error.message : 'unknown',
                }),
              );
              throw error;
            } finally {
              intervals.push([begin - wallStarted, performance.now() - wallStarted]);
            }
          }
          await until(async () => slowEntered, Boolean);
          for (const executionId of carriers) {
            const execution = await until(
              () => stores[1]!.getExecution(executionId),
              (value) => !!value && !['planned', 'running', 'waiting'].includes(value.status),
            );
            if (
              execution?.status !== 'succeeded' ||
              !execution.childSessionId ||
              !sessionIds.includes(execution.sessionId)
            )
              throw Error('original_child_scope_or_outcome');
          }
        } finally {
          observerAbort.abort();
          await observer;
          reconnects++;
        }
      },
      evidence() {
        return {
          storeId,
          serviceCount: services.length,
          serviceInstanceIds: services.map((service) => service.bootstrap.instanceId),
          sessionIds,
          commandIds: [...commands],
          synchronousEffects,
          childCalls,
          childExecutionIds: [...carriers],
          slowEntered,
          peerEvents,
          reconnects,
          wallDurationMs: performance.now() - wallStarted,
          activeWorkloadDurationMs: activeDuration(intervals),
          busyIntervals: intervals.map(([start, end]) => [start, end] as [number, number]),
          operationDurationMs: intervals.map(([start, end]) => end - start),
          admissionLatencyMs: [...latencies],
          missing: ['qualified_background_shell', 'full_formal_continuous_load'],
        };
      },
      async close() {
        await closeResources();
      },
    };
  } catch (error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'continuous_setup_failed');
    }
    throw error;
  }
}

/** Diagnostic adapters stay v1. Formal macOS uses the actual default packaged producer. */
export async function runContinuousSchedule(
  root: string,
  mode: 'diagnostic' | 'formal',
  signal?: AbortSignal,
  candidateRoot?: string,
): Promise<ContinuousEvidence> {
  if (signal?.aborted) throw Error('continuous_schedule_stopped');
  if (mode === 'formal') {
    if (process.platform !== 'darwin')
      throw Error('continuous_qualified_background_shell_required');
    const { openDefaultShellContinuousFixture } = await import('./continuous-default-shell');
    const fixture = await openDefaultShellContinuousFixture(root, candidateRoot);
    try {
      do {
        await fixture.cycle(signal);
      } while (
        fixture.evidence().completedCycles < 2 ||
        fixture.evidence().activeWorkloadDurationMs < CONTINUOUS_MINIMUM_BUSY_MS
      );
      await fixture.confirmCold();
      const evidence = fixture.evidence();
      if (verifyContinuousEvidence(evidence, true).length)
        throw Error('continuous_default_formal_evidence_invalid');
      return evidence;
    } finally {
      await fixture.close();
    }
  }
  const fixture = await openContinuousFixture(root);
  let completedCycles = 0;
  try {
    do {
      if (signal?.aborted) throw Error('continuous_schedule_stopped');
      await fixture.cycle(signal);
      completedCycles++;
    } while (completedCycles < 2);
    const observed = fixture.evidence();
    await fixture.close();
    return {
      version: 1,
      mode,
      status: 'passed',
      storeId: observed.storeId,
      serviceInstanceIds: observed.serviceInstanceIds,
      sessionIds: observed.sessionIds,
      commandIds: observed.commandIds,
      childExecutionIds: observed.childExecutionIds,
      synchronousEffects: observed.synchronousEffects,
      childCalls: observed.childCalls,
      slowEntered: observed.slowEntered,
      peerEvents: observed.peerEvents,
      reconnects: observed.reconnects,
      completedCycles,
      wallDurationMs: observed.wallDurationMs,
      activeWorkloadDurationMs: observed.activeWorkloadDurationMs,
      busyIntervals: observed.busyIntervals,
      operationDurationMs: observed.operationDurationMs,
      admissionLatencyMs: observed.admissionLatencyMs,
      cleanupConfirmed: true,
      missing: observed.missing,
    };
  } finally {
    await fixture.close();
  }
}
