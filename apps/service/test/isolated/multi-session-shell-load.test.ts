import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeShellProcessEvidence, shellProcessEvidenceEnded } from '@kite-ai/agent/jobs/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { type BackgroundExecutionItem, createClient, ExecutionOutputPages } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { launchPairedService } from '../../src/paired';
import {
  buildMixedShellSupervisor,
  type MixedShellLedger,
  writeMixedShellScript,
} from './multi-session-shell-load.shared';
import type { LoadTelemetry } from './multi-session-stream-load.types';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
async function until(read: () => boolean | Promise<boolean>, name: string, ms = 20000) {
  const end = Date.now() + ms;
  while (!(await read())) {
    if (Date.now() > end) throw Error(`mixed_shell_deadline:${name}`);
    await Bun.sleep(30);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ??
  0;
async function descriptors(pid: number) {
  const child = Bun.spawn(['lsof', '-a', '-p', String(pid), '-Ff'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text.split('\n').filter((line) => /^f[0-9]+$/.test(line)).length;
}
function provider(shellCommand: (label: string) => string, slots: number) {
  const active = new Map<string, { ticks: number; finish(): void }>();
  const cancelled = new Set<string>();
  let peak = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: unknown }[];
      };
      const text = JSON.stringify(body.messages);
      const root = text.match(/MIXED_ROOT_(\d)/)?.[1];
      const child = text.match(/MIXED_CHILD_(\d)_(\d)/);
      if (root === undefined) return new Response('invalid fixture root', { status: 400 });
      const isChild = body.model === 'mixed-child';
      const label = isChild ? `child-${child?.[1]}-${child?.[2]}` : `root-${root}`;
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: label, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (!body.messages.some((message) => message.role === 'tool')) {
        const calls = [
          {
            name: 'shell_launch',
            args: { key: `shell-${label}`, command: shellCommand(label), cancellation: 'attached' },
          },
          ...(!isChild
            ? Array.from({ length: 3 }, (_, i) => ({
                name: 'spawn_agent',
                args: {
                  key: `task-${root}-${i}`,
                  role: 'worker',
                  input: { content: `MIXED_ROOT_${root} MIXED_CHILD_${root}_${i}` },
                  cancellation: 'attached',
                  result_disposition: 'required',
                },
              }))
            : []),
        ];
        const tool_calls = calls.map((call, index) => ({
          index,
          id: `call-${label}-${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }));
        return new Response(
          `${chunk({ role: 'assistant', tool_calls })}${chunk({}, 'tool_calls')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      // Default-four case deliberately releases parent Model permits so all child Shell requests can reach process admission.
      if (slots === 4 && !isChild)
        return new Response(
          `${chunk({ content: 'Required children still own their work.' })}${chunk({}, 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      let timer: ReturnType<typeof setInterval> | undefined,
        ended = false;
      const release = () => {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        active.delete(label);
      };
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (value: string) => controller.enqueue(new TextEncoder().encode(value));
            const live = {
              ticks: 0,
              finish() {
                if (ended) return;
                send(chunk({}, 'stop'));
                send('data: [DONE]\n\n');
                controller.close();
                release();
              },
            };
            active.set(label, live);
            peak = Math.max(peak, active.size);
            send(
              chunk({
                role: 'assistant',
                content: isChild ? '真实子模型持续正文🙂'.repeat(7000) : `Root ${label} streaming.`,
              }),
            );
            timer = setInterval(() => {
              if (!ended) {
                live.ticks++;
                send(chunk({ content: '持续模型片段🙂'.repeat(12) }));
              }
            }, 100);
          },
          cancel() {
            cancelled.add(label);
            release();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    active,
    cancelled,
    get peak() {
      return peak;
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
async function completeOutput(client: ReturnType<typeof createClient>, executionId: string) {
  const pages = new ExecutionOutputPages(executionId);
  const streams = { stdout: '', stderr: '' };
  const gaps: { stream: string; seq: string; throughSeq: string; droppedBytes: string | null }[] =
    [];
  let rows = 0;
  while (!pages.complete) {
    const page = pages.accept(
      await client.listExecutionOutput(executionId, {
        afterSeq: pages.afterSeq,
        upperSeq: pages.upperSeq,
        limit: 200,
      }),
    );
    for (const row of page.items) {
      rows++;
      if (row.droppedBytes !== '0' || row.throughSeq !== row.seq)
        gaps.push({
          stream: row.stream,
          seq: row.seq,
          throughSeq: row.throughSeq,
          droppedBytes: row.droppedBytes,
        });
      else if (row.stream === 'stdout' || row.stream === 'stderr')
        streams[row.stream] += row.content;
    }
  }
  return { highWaterSeq: pages.upperSeq, complete: pages.complete, rows, streams, gaps };
}
const reports: unknown[] = [];
for (const slots of [4, 16])
  nativeTest(
    `real mixed Shell load with ${slots} Model and process slots`,
    async () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mixed-shell-load-')));
      const workspace = join(directory, 'workspace');
      mkdirSync(workspace);
      const scripts = writeMixedShellScript(workspace);
      const source = provider(scripts.shellCommand, slots);
      const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'mixed' });
      privateDirectory(profile.profilePath);
      const metricsPath = join(directory, 'metrics.json');
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'mixed-parent',
          models: ['mixed-parent', 'mixed-child'].map((id) => ({
            id,
            provider: 'compatible',
            model: id,
            baseURL: source.baseURL,
            // This finite load provider routes by original task markers; compression has its own fixtures.
            modelCapabilities: { contextWindowTokens: 1_000_000 },
          })),
          tools: ['task', 'shell.launch', 'shell.read', 'shell.wait', 'shell.stop'].map((id) => ({
            id,
            definitionVersion: '1',
          })),
        }),
      );
      let host: Awaited<ReturnType<typeof launchPairedService>> | undefined;
      let failed = false;
      const cancelTrace: unknown[] = [];
      const controllers = new Set<AbortController>();
      const observers: Promise<unknown>[] = [];
      const ownPids = new Set<number>();
      const latencies = { body: [] as number[], output: [] as number[], health: [] as number[] };
      const phases: unknown[] = [];
      let ready = 0,
        events = 0,
        aborts = 0,
        readFailures = 0;
      const ledgers = () =>
        Array.from({ length: 4 }, (_, r) => [
          `root-${r}`,
          ...Array.from({ length: 3 }, (_, i) => `child-${r}-${i}`),
        ])
          .flat()
          .filter((label) => existsSync(scripts.ledgerPath(label)))
          .map(
            (label) =>
              JSON.parse(readFileSync(scripts.ledgerPath(label), 'utf8')) as MixedShellLedger,
          );
      try {
        const supervisorPath = await buildMixedShellSupervisor(directory);
        host = await launchPairedService({
          entrypoint: join(import.meta.dir, 'multi-session-shell-load.fixture.ts'),
          profile,
          instanceId: `mixed-shell-${slots}`,
          buildId: 'isolated-real-shell-load',
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history', 'model_outputs', 'events'],
          hostConfiguration: { slots, supervisorPath, metricsPath },
          startupTimeoutMs: 15000,
          shutdownTimeoutMs: 20000,
        });
        const client = host.client,
          storeId = host.bootstrap.storeId!;
        await client.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Mixed owned load',
          rootUri: pathToFileURL(workspace).href,
        });
        await Promise.all(
          Array.from({ length: 4 }, async (_, index) => {
            await client.createSession({
              expectedStoreId: storeId,
              commandId: `create-${index}`,
              sessionId: `root-${index}`,
              workspaceId: 'w',
              title: `Mixed root ${index}`,
            });
            await client.startRun(`root-${index}`, {
              expectedStoreId: storeId,
              commandId: `work-${index}`,
              kind: 'run.start',
              content: `MIXED_ROOT_${index}`,
            });
          }),
        );
        let items: BackgroundExecutionItem[] = [];
        await until(
          async () => {
            items = await client.listAllBackgroundExecutions();
            return (
              items.filter((item) => item.execution.definitionId === 'shell.command').length === 16
            );
          },
          'all-ordinary-shell-requests',
          35000,
        );
        const shellItems = items.filter((item) => item.execution.definitionId === 'shell.command');
        const childItems = items.filter((item) => item.execution.childSessionId);
        expect(childItems).toHaveLength(12);
        const labelsBySession = new Map(
          Array.from({ length: 4 }, (_, r) => [`root-${r}`, `root-${r}`]),
        );
        for (const item of childItems) {
          const view = await client.getView(item.execution.childSessionId!);
          const label = view.messages
            .map((m) => m.content)
            .join(' ')
            .match(/MIXED_CHILD_(\d)_(\d)/);
          if (!label) throw Error('mixed_child_label_missing');
          labelsBySession.set(view.session.id, `child-${label[1]}-${label[2]}`);
        }
        const jobsByLabel = new Map(
          shellItems.map((item) => [
            labelsBySession.get(item.execution.sessionId)!,
            item.execution.id,
          ]),
        );
        expect(jobsByLabel.size).toBe(16);
        await until(
          () => ledgers().length === (slots === 16 ? 16 : 4) && source.active.size === slots,
          'real-process-model-concurrency',
          35000,
        );
        const initial = ledgers();
        expect(initial.every((row) => alive(row.pid) && alive(row.descendantPid))).toBe(true);
        expect(source.peak).toBe(slots);
        const checkReady = async () => {
          let running = 0;
          for (const [label, id] of jobsByLabel) {
            const job = await client.getExecution(id);
            if (job.status !== 'running') continue;
            running++;
            const db = new Database(profile.databasePath, { readonly: true });
            const row = db.query('SELECT reference_json FROM execution WHERE id=?').get(id) as {
              reference_json: string;
            };
            db.close();
            const ref = JSON.parse(row.reference_json) as {
              nonce: string;
              ownedProcesses: unknown;
            };
            const proof = decodeShellProcessEvidence(
              ref.ownedProcesses,
              { sessionId: job.sessionId, executionId: id, nonce: ref.nonce },
              host!.pid,
            );
            expect(proof?.coverage).toBe('shell-owned-coalition');
            if (proof?.version === 1) {
              ownPids.add(proof.broker.pid);
              ownPids.add(proof.guardian.pid);
              ownPids.add(proof.root.identity.pid);
              expect(proof.root.identity.pid).toBe(
                JSON.parse(readFileSync(scripts.ledgerPath(label), 'utf8')).pid,
              );
            }
          }
          expect(running).toBe(slots);
          const views = await Promise.all(
            [...labelsBySession.keys()].map((sessionId) => client.getView(sessionId)),
          );
          const liveModels = views
            .flatMap((view) => view.executions)
            .filter(
              (execution) => execution.kind === 'model' && execution.status === 'dispatching',
            );
          expect(liveModels).toHaveLength(slots);
          if (slots === 16)
            expect(
              views.every((view) =>
                view.runs.some((run) => run.isActive && run.status === 'running'),
              ),
            ).toBe(true);
          for (const row of ledgers()) {
            ownPids.add(row.pid);
            ownPids.add(row.descendantPid);
          }
        };
        await checkReady();
        const phase = async (name: string) => {
          const sample: LoadTelemetry = JSON.parse(readFileSync(metricsPath, 'utf8'));
          phases.push({
            phase: name,
            ...sample,
            descriptors: await descriptors(host!.pid),
            ledgers: ledgers(),
          });
        };
        const startObserver = () => {
          const abort = new AbortController();
          controllers.add(abort);
          const observer = createClient({
            endpoint: host!.bootstrap.endpoint,
            token: host!.bootstrap.token,
            expected: {
              profile: host!.bootstrap.profile,
              apiMajor: 1,
              requiredCapabilities: ['events'],
            },
          });
          const pending = observer
            .connect()
            .then(() =>
              observer.observe({
                signal: abort.signal,
                onReady() {
                  ready++;
                },
                onChange() {
                  events++;
                },
              }),
            )
            .catch((error) => {
              if (!abort.signal.aborted) throw error;
            })
            .finally(() => {
              observer.disposeNetwork();
              controllers.delete(abort);
            });
          observers.push(pending);
          return abort;
        };
        startObserver();
        startObserver();
        const time = async <T>(kind: keyof typeof latencies, work: () => Promise<T>) => {
          const before = performance.now();
          try {
            return await work();
          } catch (error) {
            readFailures++;
            throw error;
          } finally {
            latencies[kind].push(performance.now() - before);
          }
        };
        const runningIds = () =>
          ledgers()
            .filter((row) => !row.complete)
            .map((row) => ({ row, id: jobsByLabel.get(row.label)! }));
        await phase('warmup');
        const started = performance.now();
        let rounds = 0,
          middle = false;
        const duration = slots === 16 ? 30000 : 1500;
        while (performance.now() - started < duration) {
          const running = runningIds();
          const chosen = Array.from(
            { length: 4 },
            (_, i) => running[(rounds * 4 + i) % running.length]!,
          );
          await Promise.all([
            ...chosen.map(({ id }) => time('output', () => completeOutput(client, id))),
            ...(slots === 16
              ? childItems.slice(rounds % 10, (rounds % 10) + 2).map((item) =>
                  time('body', async () => {
                    const messages = await client.listMessages(item.execution.childSessionId!);
                    const model = messages.find((m) => m.outputBody);
                    if (!model?.outputBody) throw Error('mixed_partial_body_missing');
                    await client.getModelOutput(
                      item.execution.childSessionId!,
                      model.outputBody.executionId,
                      { expectedStoreId: storeId },
                    );
                  }),
                )
              : []),
            time('health', async () => {
              const response = await fetch(`${host!.bootstrap.endpoint}/v1/lifecycle`, {
                headers: { authorization: `Bearer ${host!.bootstrap.token}` },
                signal: AbortSignal.timeout(3000),
              });
              if (!response.ok) throw Error('mixed_health_failed');
              await response.arrayBuffer();
            }),
          ]);
          const abort = new AbortController();
          const read = client.listExecutionOutput(chosen[0]!.id, { signal: abort.signal }).then(
            () => false,
            () => true,
          );
          abort.abort();
          if (await read) aborts++;
          if (rounds === 2) {
            for (const controller of controllers) controller.abort();
            startObserver();
            startObserver();
          }
          if (!middle && slots === 16 && performance.now() - started >= 15000) {
            await phase('middle');
            middle = true;
            await checkReady();
          }
          rounds++;
          await Bun.sleep(250);
        }
        const actualDurationMs = performance.now() - started;
        await phase('tail');
        await checkReady();
        expect(source.cancelled.size).toBe(0);
        expect(source.active.size).toBe(slots);
        expect(aborts).toBe(rounds);
        expect(ready).toBe(4);
        const progressed = ledgers();
        expect(
          progressed.every(
            (row) => !row.complete && row.seq > 1 && row.cpuUserUs + row.cpuSystemUs > 0,
          ),
        ).toBe(true);
        if (slots === 16)
          expect(Math.min(...progressed.map((row) => row.elapsedMs))).toBeGreaterThanOrEqual(30000);
        await client.cancelCommand('root-0', {
          expectedStoreId: storeId,
          commandId: 'cancel-root-tree',
          kind: 'command.cancel',
          targetCommandId: 'work-0',
        });
        const stopped = new Set(['root-0', 'child-0-0', 'child-0-1', 'child-0-2']);
        await until(async () => {
          const rows = await Promise.all(
            [...stopped].map((label) => client.getExecution(jobsByLabel.get(label)!)),
          );
          return rows.every((row) => row.status === 'cancelled');
        }, 'attached-root-shell-tree-stopped');
        for (const row of ledgers().filter((row) => stopped.has(row.label)))
          expect(!alive(row.pid) && !alive(row.descendantPid)).toBe(true);
        const childStopDeadline = Date.now() + 20000;
        let selectedChild:
          | {
              target: BackgroundExecutionItem;
              label: string;
              childSessionId: string;
              parentSessionId: string;
              shellExecutionId: string;
            }
          | undefined;
        await until(
          async () => {
            for (const target of childItems) {
              const childSessionId = target.execution.childSessionId!;
              const label = labelsBySession.get(childSessionId)!;
              if (stopped.has(label)) continue;
              const ledger = ledgers().find((row) => row.label === label);
              if (!ledger || ledger.complete) continue;
              if (!alive(ledger.pid) || !alive(ledger.descendantPid)) continue;
              const shellExecutionId = jobsByLabel.get(label)!;
              const shell = await client.getExecution(shellExecutionId);
              const carrier = await client.getExecution(target.execution.id);
              if (shell.status !== 'running' || carrier.status !== 'running') continue;
              ownPids.add(ledger.pid);
              ownPids.add(ledger.descendantPid);
              selectedChild = {
                target,
                label,
                childSessionId,
                parentSessionId: target.execution.sessionId,
                shellExecutionId,
              };
              return true;
            }
            return false;
          },
          'one-child-shell-tree-ready',
          Math.max(0, childStopDeadline - Date.now()),
        );
        if (!selectedChild) throw Error('mixed_running_child_missing');
        const { target, label, childSessionId, parentSessionId, shellExecutionId } = selectedChild;
        const childView = async () => {
          const view = await client.getView(childSessionId);
          return {
            session: view.session,
            runs: view.runs.map(({ id, status, isActive, reason, waitingForResults }) => ({
              id,
              status,
              isActive,
              reason,
              waitingForResults,
            })),
            executions: view.executions.map(({ result, ...execution }) => execution),
          };
        };
        cancelTrace.push({
          phase: 'before-child-stop',
          label,
          childSessionId,
          parentSessionId,
          shellExecutionId,
          target: await client.getExecution(target.execution.id),
          shell: await client.getExecution(shellExecutionId),
          view: await childView(),
        });
        const stopReceipt = await client.cancelExecution(parentSessionId, {
          expectedStoreId: storeId,
          commandId: 'stop-one-child-tree',
          kind: 'execution.cancel',
          executionId: target.execution.id,
        });
        cancelTrace.push({ phase: 'child-stop-receipt', receipt: stopReceipt });
        stopped.add(label);
        await until(
          async () => {
            const shell = await client.getExecution(shellExecutionId);
            cancelTrace.push({
              phase: 'child-stop-poll',
              shell,
              target: await client.getExecution(target.execution.id),
              view: await childView(),
            });
            return shell.status === 'cancelled';
          },
          'one-child-shell-tree-stopped',
          Math.max(0, childStopDeadline - Date.now()),
        );
        const before = new Map(
          ledgers()
            .filter((row) => !stopped.has(row.label))
            .map((row) => [row.label, row.seq]),
        );
        await Bun.sleep(450);
        expect(
          ledgers()
            .filter((row) => before.has(row.label) && !stopped.has(row.label) && !row.complete)
            .every(
              (row) =>
                row.seq > before.get(row.label)! && alive(row.pid) && alive(row.descendantPid),
            ),
        ).toBe(true);
        for (const controller of controllers) controller.abort();
        await Promise.all(observers);
        writeFileSync(scripts.finishPath, 'finish');
        await until(() => ledgers().every((row) => row.complete), 'scripts-normal-finish');
        await until(async () => {
          source.finish();
          const views = await Promise.all(
            [...labelsBySession.keys()].map((sessionId) => client.getView(sessionId)),
          );
          return (
            !source.active.size && views.every((view) => view.runs.every((run) => !run.isActive))
          );
        }, 'all-session-runs-drained');
        const terminalViews = await Promise.all(
          [...labelsBySession.keys()].map((sessionId) => client.getView(sessionId)),
        );
        expect(source.active.size).toBe(0);
        expect(
          terminalViews.every((view) =>
            view.runs.every(
              (run) => !run.isActive && ['completed', 'cancelled'].includes(run.status),
            ),
          ),
        ).toBe(true);
        const terminalModels = terminalViews
          .flatMap((view) => view.executions)
          .filter((execution) => execution.kind === 'model');
        expect(
          terminalModels.every((model) => ['succeeded', 'cancelled'].includes(model.status)),
        ).toBe(true);
        const outputProofs = [];
        for (const [label, id] of jobsByLabel) {
          const job = await client.getExecution(id);
          expect(job.status).toBe(stopped.has(label) ? 'cancelled' : 'succeeded');
          if (!existsSync(scripts.ledgerPath(label))) {
            expect(slots).toBe(4);
            expect(job.status).toBe('cancelled');
            continue;
          }
          const ledger = JSON.parse(
            readFileSync(scripts.ledgerPath(label), 'utf8'),
          ) as MixedShellLedger;
          expect(ledger.complete).toBe(true);
          expect(!alive(ledger.pid) && !alive(ledger.descendantPid)).toBe(true);
          const db = new Database(profile.databasePath, { readonly: true });
          const row = db
            .query('SELECT reference_json,result_json FROM execution WHERE id=?')
            .get(id) as { reference_json: string; result_json: string };
          db.close();
          const ref = JSON.parse(row.reference_json) as { nonce: string };
          const details = JSON.parse(row.result_json).details as { ownedProcesses?: unknown };
          const proof = decodeShellProcessEvidence(
            details.ownedProcesses,
            { sessionId: job.sessionId, executionId: id, nonce: ref.nonce },
            host.pid,
          );
          expect(proof !== undefined && shellProcessEvidenceEnded(proof)).toBe(true);
          const output = await time('output', () => completeOutput(client, id));
          expect(output.complete).toBe(true);
          const streams = [];
          for (const stream of ['stdout', 'stderr'] as const) {
            const text = output.streams[stream];
            expect(text.includes('\ufffd')).toBe(false);
            const retainedBytes = Buffer.byteLength(text);
            const generatedBytes = stream === 'stdout' ? ledger.stdoutBytes : ledger.stderrBytes;
            const gaps = output.gaps.filter((gap) => gap.stream === stream);
            expect(retainedBytes).toBeLessThanOrEqual(generatedBytes);
            if (!gaps.length) {
              expect(retainedBytes).toBe(generatedBytes);
              expect(createHash('sha256').update(text).digest('hex')).toBe(
                stream === 'stdout' ? ledger.stdoutHash : ledger.stderrHash,
              );
            } else {
              const missing = generatedBytes - retainedBytes;
              const knownDropped = gaps.reduce(
                (sum, gap) => sum + Number(gap.droppedBytes ?? '0'),
                0,
              );
              expect(knownDropped).toBeLessThanOrEqual(missing);
              if (gaps.every((gap) => gap.droppedBytes !== null))
                expect(knownDropped).toBe(missing);
            }
            streams.push({
              stream,
              generatedBytes,
              retainedBytes,
              actualMissingBytes: generatedBytes - retainedBytes,
              sha256Verified: !gaps.length,
              gaps,
            });
          }
          outputProofs.push({
            label,
            executionId: id,
            status: job.status,
            ledger,
            highWaterSeq: output.highWaterSeq,
            rows: output.rows,
            streams,
            ownedProcessesEnded: true,
          });
        }
        expect(readFailures).toBe(0);
        await Bun.sleep(1000);
        await phase('quiescent');
        const report = {
          slots,
          roots: 4,
          children: 12,
          actualDurationMs,
          rounds,
          providerPeak: source.peak,
          peakConcurrentShells: initial.length,
          observersReady: ready,
          events,
          aborts,
          readFailures,
          latencies: Object.fromEntries(
            Object.entries(latencies).map(([key, value]) => [
              key,
              {
                requests: value.length,
                p50Ms: percentile(value, 0.5),
                p95Ms: percentile(value, 0.95),
              },
            ]),
          ),
          phases,
          cancelTrace,
          terminal: {
            sessions: terminalViews.length,
            models: terminalModels.length,
            runs: terminalViews
              .flatMap((view) => view.runs)
              .map((run) => ({ id: run.id, status: run.status, isActive: run.isActive })),
            allModelsKnownTerminal: true,
            providerStreams: 0,
          },
          outputProofs,
        };
        await host.close();
        expect(await host.exited).toBe(0);
        expect([...ownPids].some(alive)).toBe(false);
        reports.push({ ...report, serviceExitCode: 0, allObservedOwnedPidsAbsent: true });
        const out = join(import.meta.dir, '../../../../.cache/native-multi-session-rendering');
        mkdirSync(out, { recursive: true });
        writeFileSync(
          join(out, 'service-shell-load.json'),
          JSON.stringify(
            {
              command: 'bun test apps/service/test/isolated/multi-session-shell-load.test.ts',
              forcedGC: false,
              reports,
            },
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            mixedShellLoad: {
              slots,
              actualDurationMs,
              providerPeak: source.peak,
              peakConcurrentShells: initial.length,
              jobs: outputProofs.length,
              readFailures,
              latencies: report.latencies,
              serviceExitCode: 0,
            },
          }),
        );
      } catch (error) {
        failed = true;
        console.error(
          JSON.stringify({
            mixedShellFailure: {
              slots,
              directory,
              code: (error as { code?: string }).code ?? (error as Error).message,
              diagnostics: host?.diagnostics,
              lastMetrics: existsSync(metricsPath)
                ? JSON.parse(readFileSync(metricsPath, 'utf8'))
                : null,
              cancelTrace,
              activeProviders: [...source.active.keys()],
              ledgers: ledgers(),
            },
          }),
        );
        throw error;
      } finally {
        for (const controller of controllers) controller.abort();
        writeFileSync(scripts.finishPath, 'cleanup');
        source.close();
        await Promise.allSettled(observers);
        await host?.close();
        await until(
          () => ledgers().every((row) => !alive(row.pid) && !alive(row.descendantPid)),
          'owned-script-cleanup',
          15000,
        );
        if (!failed) rmSync(directory, { recursive: true, force: true });
      }
    },
    180000,
  );
