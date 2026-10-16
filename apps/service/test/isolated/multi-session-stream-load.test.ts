import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { type BackgroundExecutionItem, createClient } from '@kite-ai/client';
import { launchPairedService } from '../../src/paired';
import type { LoadResourcePhase, LoadTelemetry } from './multi-session-stream-load.types';

async function until(read: () => boolean | Promise<boolean>, name: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await read())) {
    if (Date.now() > deadline) throw Error(`load_deadline:${name}`);
    await Bun.sleep(20);
  }
}
function provider() {
  type Live = { ticks: number; finish: () => void };
  const active = new Map<string, Live>();
  const started = new Set<string>();
  const canceled = new Set<string>();
  let maxActive = 0,
    calls = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: unknown }[];
      };
      calls++;
      const text = JSON.stringify(body.messages);
      const root = text.match(/load-root-(\d+)/)?.[1];
      if (root === undefined) return new Response('missing load root', { status: 400 });
      const isChild = body.model === 'load-child';
      const childIndex = text.match(/child-index-(\d+)/)?.[1];
      const label = isChild ? `root-${root}-child-${childIndex}` : `root-${root}`;
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: label, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (!isChild && !body.messages.some((message) => message.role === 'tool')) {
        const tool_calls = Array.from({ length: 3 }, (_, index) => ({
          index,
          id: `task-${root}-${index}`,
          type: 'function',
          function: {
            name: 'task',
            arguments: JSON.stringify({
              key: `child-${index}`,
              role: 'worker',
              input: { content: `load-root-${root} child-index-${index}` },
              cancellation: root === '1' ? 'detached' : 'attached',
              resultDisposition: 'required',
            }),
          },
        }));
        return new Response(
          `${chunk({ role: 'assistant', tool_calls })}${chunk({}, 'tool_calls')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      let timer: ReturnType<typeof setInterval> | undefined;
      let finished = false;
      const release = () => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        active.delete(label);
      };
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (value: string) => controller.enqueue(new TextEncoder().encode(value));
            const live: Live = {
              ticks: 0,
              finish() {
                if (finished) return;
                send(chunk({}, 'stop'));
                send('data: [DONE]\n\n');
                controller.close();
                release();
              },
            };
            active.set(label, live);
            started.add(label);
            maxActive = Math.max(maxActive, active.size);
            send(
              chunk({
                role: 'assistant',
                content: `partial ${label} ${isChild ? 'stream-雪🙂-'.repeat(7000) : ''}`,
              }),
            );
            timer = setInterval(() => {
              if (!finished) {
                live.ticks++;
                send(chunk({ content: 'stream-雪🙂-'.repeat(16) }));
              }
            }, 60);
          },
          cancel() {
            canceled.add(label);
            release();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    active,
    started,
    canceled,
    get maxActive() {
      return maxActive;
    },
    get calls() {
      return calls;
    },
    baseURL: `${server.url.href}v1`,
    finish() {
      for (const live of [...active.values()]) live.finish();
    },
    close() {
      for (const live of [...active.values()]) live.finish();
      server.stop(true);
    },
  };
}
function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}
async function descriptors(pid: number) {
  if (process.platform === 'win32') return null;
  const child = Bun.spawn(['lsof', '-a', '-p', String(pid), '-Ff'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  return code === 0 ? output.split('\n').filter((line) => /^f[0-9]+$/.test(line)).length : null;
}

for (const stage of [
  { roots: 4, slots: 4 },
  { roots: 4, slots: 16 },
  { roots: 8, slots: 32 },
])
  test(`real Service load ${stage.roots} roots x 3 Task children with ${stage.slots} Model slots`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-multi-session-load-')));
    const workspace = join(directory, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'load' });
    const metricsPath = join(directory, 'metrics.json');
    const source = provider();
    let host: Awaited<ReturnType<typeof launchPairedService>> | undefined;
    const controllers = new Set<AbortController>();
    const observers: Promise<unknown>[] = [];
    const samples: LoadTelemetry[] = [];
    const latencies: number[] = [],
      healthLatencies: number[] = [];
    let bodyReads = 0,
      maxBodyBytes = 0,
      observerReady = 0,
      observerChanges = 0;
    let observerStarts = 0;
    const resourcePhases: LoadResourcePhase[] = [];
    let readFailures = 0,
      expectedAborts = 0;
    let exitCode: number | undefined;
    try {
      host = await launchPairedService({
        entrypoint: join(import.meta.dir, 'multi-session-stream-load.fixture.ts'),
        profile,
        instanceId: `load-${stage.roots}-${stage.slots}`,
        buildId: 'isolated-loopback-load',
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'model_outputs', 'events'],
        hostConfiguration: { baseURL: source.baseURL, slots: stage.slots, metricsPath },
        shutdownTimeoutMs: 10000,
      });
      const client = host.client,
        storeId = host.bootstrap.storeId!;
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'load',
        rootUri: pathToFileURL(workspace).href,
      });
      await Promise.all(
        Array.from({ length: stage.roots }, async (_, index) => {
          const id = `root-${index}`;
          await client.createSession({
            expectedStoreId: storeId,
            commandId: `create-${index}`,
            sessionId: id,
            workspaceId: 'w',
            title: id,
          });
          await client.startRun(id, {
            expectedStoreId: storeId,
            commandId: `work-${index}`,
            kind: 'run.start',
            content: `load-root-${index}`,
          });
        }),
      );
      const expected = Math.min(stage.slots, stage.roots * 4);
      await until(
        () =>
          source.active.size === expected &&
          [...source.active.values()].every((live) => live.ticks >= 2),
        `actual-${expected}-streams`,
      );
      expect(source.maxActive).toBe(expected);
      const actualProviderLabels = [...source.active.keys()];
      if (stage.slots > 4) {
        expect([...source.active.keys()].filter((id) => id.includes('child'))).toHaveLength(
          stage.roots * 3,
        );
        expect([...source.active.keys()].filter((id) => !id.includes('child'))).toHaveLength(
          stage.roots,
        );
      }
      let items: BackgroundExecutionItem[] = [];
      await until(async () => {
        items = await client.listAllBackgroundExecutions();
        return items.filter((item) => item.execution.childSessionId).length === stage.roots * 3;
      }, 'all-child-carriers');
      const verifyPublicHealth = async () => {
        const roots = await Promise.all(
          Array.from({ length: stage.roots }, (_, index) => client.getView(`root-${index}`)),
        );
        expect(
          roots.every((view) => view.runs.some((run) => run.isActive && run.status === 'running')),
        ).toBe(true);
        expect(
          roots.every((view) =>
            view.executions.some(
              (execution) => execution.kind === 'model' && execution.status === 'dispatching',
            ),
          ),
        ).toBe(true);
        const children = await Promise.all(
          items.map((item) => client.getView(item.execution.childSessionId!)),
        );
        if (stage.slots > 4) {
          expect(
            children.every((view) =>
              view.runs.some((run) => run.isActive && run.status === 'running'),
            ),
          ).toBe(true);
          expect(
            children.every((view) =>
              view.executions.some(
                (execution) => execution.kind === 'model' && execution.status === 'dispatching',
              ),
            ),
          ).toBe(true);
          expect(
            children.every((view) =>
              view.messages.some(
                (message) => message.outputBody && BigInt(message.outputBody.contentBytes) > 65536n,
              ),
            ),
          ).toBe(true);
        } else {
          expect(
            children.every(
              (view) =>
                !view.executions.some(
                  (execution) => execution.kind === 'model' && execution.status === 'dispatching',
                ),
            ),
          ).toBe(true);
        }
      };
      await verifyPublicHealth();
      const startObserver = () => {
        observerStarts++;
        const controller = new AbortController();
        controllers.add(controller);
        const observer = createClient({
          endpoint: host!.bootstrap.endpoint,
          token: host!.bootstrap.token,
          expected: {
            profile: host!.bootstrap.profile,
            apiMajor: 1,
            requiredCapabilities: ['events'],
          },
        });
        const promise = observer
          .connect()
          .then(() =>
            observer.observe({
              signal: controller.signal,
              onReady() {
                observerReady++;
              },
              onChange() {
                observerChanges++;
              },
            }),
          )
          .catch((error) => {
            if (!controller.signal.aborted) throw error;
          })
          .finally(() => {
            observer.disposeNetwork();
            controllers.delete(controller);
          });
        observers.push(promise);
        return controller;
      };
      const first = [startObserver(), startObserver(), startObserver()];
      const timed = async (read: () => Promise<unknown>, health = false) => {
        const before = performance.now();
        try {
          await read();
          (health ? healthLatencies : latencies).push(performance.now() - before);
        } catch (error) {
          readFailures++;
          throw error;
        }
      };
      const childItems = items.filter((item) => item.execution.childSessionId);
      const readBatch = async (round: number, pace = 100) => {
        const reads = Array.from(
          { length: 6 },
          (_, index) => childItems[(round * 6 + index) % childItems.length]!,
        );
        await Promise.all([
          ...reads.map((item) =>
            timed(async () => {
              const child = item.execution.childSessionId!;
              const messages = await client.listMessages(child);
              const model = messages.find((message) => message.outputBody);
              if (model?.outputBody) {
                const snapshot = await client.getModelOutput(child, model.outputBody.executionId, {
                  expectedStoreId: storeId,
                });
                bodyReads++;
                maxBodyBytes = Math.max(maxBodyBytes, Number(snapshot.bodyBytes));
              }
            }),
          ),
          timed(async () => {
            const response = await fetch(`${host!.bootstrap.endpoint}/v1/lifecycle`, {
              headers: { authorization: `Bearer ${host!.bootstrap.token}` },
              signal: AbortSignal.timeout(2000),
            });
            expect(response.status).toBe(200);
            await response.arrayBuffer();
          }, true),
        ]);
        // Cancel a real network GET and reconnect SSE without issuing any task cancellation.
        const abort = new AbortController();
        const pending = client
          .listMessages(reads[0]!.execution.childSessionId!, { signal: abort.signal })
          .then(
            () => false,
            () => true,
          );
        abort.abort();
        if (await pending) expectedAborts++;
        if (round === 2) {
          for (const controller of first) controller.abort();
          startObserver();
          startObserver();
        }
        samples.push(JSON.parse(readFileSync(metricsPath, 'utf8')));
        await Bun.sleep(pace);
      };
      for (let round = 0; round < 12; round++) await readBatch(round);
      // Reading cancellation cannot stop any task; all originally active streams still advance.
      expect(source.canceled.size).toBe(0);
      expect(source.active.size).toBe(expected);
      expect(expectedAborts).toBe(12);
      await until(() => observerReady === 5, 'five-observer-admissions');
      if (stage.slots > 4) expect(bodyReads).toBeGreaterThan(0);
      await verifyPublicHealth();
      const snapshotResources = async (phase: LoadResourcePhase['phase']) => {
        const sample: LoadTelemetry = JSON.parse(readFileSync(metricsPath, 'utf8'));
        resourcePhases.push({ phase, ...sample, descriptors: await descriptors(host!.pid) });
      };
      let sustainedBatches = 0;
      let sustainedMs = 0;
      if (stage.slots === 32) {
        await snapshotResources('warmup');
        const started = performance.now();
        let middle = false;
        const tickStart = new Map([...source.active].map(([id, live]) => [id, live.ticks]));
        while (performance.now() - started < 30000) {
          await readBatch(12 + sustainedBatches, 250);
          sustainedBatches++;
          if (!middle && performance.now() - started >= 15000) {
            await snapshotResources('middle');
            middle = true;
            await verifyPublicHealth();
          }
          if (sustainedBatches % 24 === 0) {
            for (const controller of controllers) controller.abort();
            startObserver();
            startObserver();
          }
        }
        sustainedMs = performance.now() - started;
        await snapshotResources('tail');
        await until(() => observerReady === observerStarts, 'sustained-observer-reconnections');
        await verifyPublicHealth();
        expect(source.active.size).toBe(32);
        expect(source.canceled.size).toBe(0);
        expect([...source.active].every(([id, live]) => live.ticks > tickStart.get(id)!)).toBe(
          true,
        );
        expect(expectedAborts).toBe(12 + sustainedBatches);
      }
      const fdDuring = await descriptors(host.pid);
      const detached = items.filter((item) => item.session.id === 'root-1');
      await client.cancelCommand('root-0', {
        expectedStoreId: storeId,
        commandId: 'cancel-attached-root',
        kind: 'command.cancel',
        targetCommandId: 'work-0',
      });
      await until(async () => {
        const view = await client.getView('root-0');
        return view.runs.every((run) => !run.isActive);
      }, 'attached-root-stopped');
      await until(async () => {
        const current = await client.listAllBackgroundExecutions();
        return current
          .filter((item) => item.session.id === 'root-0')
          .every(
            (item) =>
              item.execution.status !== 'running' &&
              item.execution.status !== 'planned' &&
              item.execution.status !== 'dispatching',
          );
      }, 'attached-children-stopped');
      if (stage.slots === 4)
        expect([...source.started].some((label) => label.startsWith('root-0-child-'))).toBe(false);
      await client.cancelCommand('root-1', {
        expectedStoreId: storeId,
        commandId: 'cancel-detached-parent',
        kind: 'command.cancel',
        targetCommandId: 'work-1',
      });
      await until(
        async () => (await client.getView('root-1')).runs.every((run) => !run.isActive),
        'detached-parent-stopped',
      );
      const survivors = (await client.listAllBackgroundExecutions()).filter(
        (item) => item.session.id === 'root-1',
      );
      expect(survivors).toHaveLength(3);
      if (!survivors.every((item) => item.execution.status === 'running'))
        console.error(
          JSON.stringify({
            detachedLoadFailure: survivors.map((item) => ({
              execution: item.execution,
              childRun: item.childRun,
            })),
            providerCanceled: [...source.canceled],
          }),
        );
      expect(survivors.every((item) => item.execution.status === 'running')).toBe(true);
      const target = detached[0]!;
      await client.cancelExecution('root-1', {
        expectedStoreId: storeId,
        commandId: 'cancel-exact-child',
        kind: 'execution.cancel',
        executionId: target.execution.id,
      });
      await until(
        async () => (await client.getExecution(target.execution.id)).status === 'cancelled',
        'exact-child-stopped',
      );
      const siblings = (await client.listAllBackgroundExecutions()).filter(
        (item) => item.session.id === 'root-1' && item.execution.id !== target.execution.id,
      );
      expect(siblings.every((item) => item.execution.status === 'running')).toBe(true);
      expect(readFailures).toBe(0);
      expect(Math.max(...healthLatencies)).toBeLessThan(2000);
      for (const controller of controllers) controller.abort();
      await Promise.all(observers);
      // Ending every current Provider attempt allows required-result parent continuations too.
      let settled = false;
      for (let round = 0; round < 100; round++) {
        source.finish();
        const roots = await Promise.all(
          Array.from({ length: stage.roots }, (_, index) => client.getView(`root-${index}`)),
        );
        if (!source.active.size && roots.every((view) => view.runs.every((run) => !run.isActive))) {
          settled = true;
          break;
        }
        await Bun.sleep(30);
      }
      expect(settled).toBe(true);
      const terminal = await client.listAllBackgroundExecutions();
      expect(
        terminal.every(
          (item) =>
            item.execution.status ===
            (item.session.id === 'root-0' || item.execution.id === target.execution.id
              ? 'cancelled'
              : 'succeeded'),
        ),
      ).toBe(true);
      const terminalSessionIds = [
        ...Array.from({ length: stage.roots }, (_, index) => `root-${index}`),
        ...terminal.map((item) => item.execution.childSessionId!),
      ];
      const terminalViews = await Promise.all(terminalSessionIds.map((id) => client.getView(id)));
      const terminalRuns = terminalViews.flatMap((view) => view.runs);
      const terminalModels = terminalViews.flatMap((view) =>
        view.executions.filter((execution) => execution.kind === 'model'),
      );
      expect(
        terminalRuns.every(
          (run) => !run.isActive && ['completed', 'cancelled'].includes(run.status),
        ),
      ).toBe(true);
      expect(
        terminalModels.every((execution) => ['succeeded', 'cancelled'].includes(execution.status)),
      ).toBe(true);
      const quiescentProof = {
        sessionCount: terminalViews.length,
        runCount: terminalRuns.length,
        modelCount: terminalModels.length,
        allRunsInactiveAndTerminal: true,
        allModelsSucceededOrCancelled: true,
        allCarrierStatusesMatch: true,
        allReadAndAbortPromisesAwaited: true,
        allObserversAwaited: true,
      };
      if (stage.slots === 32) {
        await Bun.sleep(1000);
        expect(source.active.size).toBe(0);
        await snapshotResources('quiescent');
      }
      const fdAfterReads = await descriptors(host.pid);
      const summary = {
        stage,
        actualPeakProviderStreams: source.maxActive,
        actualParentStreams: actualProviderLabels.filter((label) => !label.includes('child'))
          .length,
        actualChildStreams: actualProviderLabels.filter((label) => label.includes('child')).length,
        bodyReads,
        maxBodyBytes,
        observerReady,
        observerChanges,
        requests: latencies.length,
        requestP50Ms: percentile(latencies, 0.5),
        requestP95Ms: percentile(latencies, 0.95),
        healthP95Ms: percentile(healthLatencies, 0.95),
        readFailures,
        expectedAborts,
        sustainedMs,
        sustainedBatches,
        sustainedReadsPerSecond: sustainedMs
          ? (sustainedBatches * 6) / (sustainedMs / 1000)
          : undefined,
        resourcePhases,
        quiescentProof,
        fdDuring,
        fdAfterReads,
        metrics: {
          samples: samples.length,
          rssFirst: samples[0]?.rss,
          rssPeak: Math.max(...samples.map((sample) => Number(sample.rss))),
          rssLast: samples.at(-1)?.rss,
          heapUsedFirst: samples[0]?.heapUsed,
          heapUsedPeak: Math.max(...samples.map((sample) => sample.heapUsed)),
          heapUsedLast: samples.at(-1)?.heapUsed,
          externalFirst: samples[0]?.external,
          externalPeak: Math.max(...samples.map((sample) => sample.external)),
          externalLast: samples.at(-1)?.external,
          arrayBuffersFirst: samples[0]?.arrayBuffers,
          arrayBuffersPeak: Math.max(...samples.map((sample) => sample.arrayBuffers)),
          arrayBuffersLast: samples.at(-1)?.arrayBuffers,
          cpuFirst: samples[0]?.cpu,
          cpuLast: samples.at(-1)?.cpu,
          elapsedMs: samples.at(-1)?.elapsedMs,
          lagMaxMs: Math.max(...samples.map((sample) => Number(sample.lagMaxMs))),
        },
      };
      await host.close();
      exitCode = await host.exited;
      expect(exitCode).toBe(0);
      console.log(JSON.stringify({ multiSessionStreamLoad: summary, exitCode }));
    } catch (error) {
      console.error(
        JSON.stringify({
          multiSessionStreamLoadFailure: {
            stage,
            code: (error as { code?: string }).code ?? (error as Error).message,
            actualPeakProviderStreams: source.maxActive,
            activeProviders: [...source.active.keys()],
            bodyReads,
            maxBodyBytes,
            readFailures,
            expectedAborts,
            metrics: samples.at(-1),
          },
        }),
      );
      throw error;
    } finally {
      for (const controller of controllers) controller.abort();
      source.close();
      await Promise.allSettled(observers);
      await host?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90000);
