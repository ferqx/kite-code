import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [outdir, root, executablePath, control, mode] = process.argv.slice(2) as string[];
const app = await _electron.launch({
  executablePath,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 15000,
});
let phase = 'launch';
const diagnostics: string[] = [];
app.process().stderr?.on('data', (value) => diagnostics.push(String(value).slice(0, 300)));
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => diagnostics.push(error.message));
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, label: string) {
    const deadline = Date.now() + 20000;
    for (;;) {
      const value = await read();
      if (check(value)) return value;
      assert.ok(Date.now() < deadline, label);
      await page.waitForTimeout(20);
    }
  }
  const count = () =>
    fetch(`${control}/count`).then((response) => response.json()) as Promise<{
      calls: string[];
      children: string[];
    }>;
  await page.getByRole('button', { name: 'Stream Parent', exact: true }).click();
  await until(
    state,
    (value) => value.selection?.session.id === 'parent' && !value.selection.viewLoading,
    'parent selected',
  );
  assert.equal(await page.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '保留草稿', exact: true }).count(), 0);
  phase = 'permissions';
  for (const kind of ['permission.trust', 'permission.mode'] as const) {
    await page.evaluate(async (kind) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const fresh = (await window.kiteNative!.request({
          method: 'permission.refresh',
          generation: 1,
        })) as NativeState;
        const observationId = fresh.selection!.permissions!.observationId;
        try {
          await window.kiteNative!.request(
            kind === 'permission.trust'
              ? { method: kind, generation: 1, observationId, trusted: true }
              : { method: kind, generation: 1, observationId, mode: 'full', makeDefault: false },
          );
          return;
        } catch (cause) {
          if (
            attempt === 5 ||
            !(cause instanceof Error) ||
            cause.message !== 'permission_observation_changed'
          )
            throw cause;
        }
      }
    }, kind);
  }
  phase = 'instrument';
  await app.evaluate(() => {
    const global = globalThis as typeof globalThis & {
      childStreamReads: {
        total: number;
        active: number;
        peak: number;
        bytes: number;
        aborted: number;
        paths: Record<string, number>;
      };
    };
    global.childStreamReads = { total: 0, active: 0, peak: 0, bytes: 0, aborted: 0, paths: {} };
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const path = new URL(String(args[0])).pathname;
        const tracked = /\/messages$|\/model-output$|\/background-executions$/.test(path);
        const reads = global.childStreamReads;
        if (tracked) {
          reads.total++;
          reads.active++;
          reads.peak = Math.max(reads.peak, reads.active);
          reads.paths[path] = (reads.paths[path] ?? 0) + 1;
        }
        const signal = args[1]?.signal;
        let finished = false;
        const finish = () => {
          if (!tracked || finished) return;
          finished = true;
          reads.active--;
          signal?.removeEventListener('abort', aborted);
        };
        const aborted = () => {
          if (!finished && tracked) reads.aborted++;
          finish();
        };
        if (tracked) signal?.addEventListener('abort', aborted, { once: true });
        try {
          const response = await original(...args);
          if (tracked && response.body) {
            // AgentClient consumes these finite JSON bodies with getReader. Observe its
            // actual EOF/cancel/error without cloning or retaining any response bytes.
            const body = response.body;
            const getReader = body.getReader.bind(body);
            Reflect.set(body, 'getReader', (...options: unknown[]) => {
              const reader = Reflect.apply(
                getReader,
                body,
                options,
              ) as ReadableStreamDefaultReader<Uint8Array>;
              const read = reader.read.bind(reader),
                cancel = reader.cancel.bind(reader);
              Reflect.set(reader, 'read', async () => {
                try {
                  const result = await read();
                  if (result.done) finish();
                  else reads.bytes += result.value.byteLength;
                  return result;
                } catch (cause) {
                  finish();
                  throw cause;
                }
              });
              Reflect.set(reader, 'cancel', async (reason?: unknown) => {
                try {
                  return await cancel(reason);
                } finally {
                  finish();
                }
              });
              return reader;
            });
          } else finish();
          return response;
        } catch (cause) {
          finish();
          throw cause;
        }
      },
      { preconnect: original.preconnect },
    );
  });
  phase = 'send';
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill('STREAM_PARENT');
  const send = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
  await until(() => send.isEnabled(), Boolean, 'send enabled');
  await send.click();
  await until(
    count,
    (value) => value.children.includes('CHILD_A') && value.children.includes('CHILD_B'),
    'two real worker streams started',
  );
  const selected = await until(
    state,
    (value) => value.selection!.executions.filter((row) => !!row.childSessionId).length === 2,
    'two child tasks recorded',
  );
  const tasks = selected.selection!.executions.filter((row) => !!row.childSessionId);
  const environment = page.getByRole('region', { name: '环境信息', exact: true });
  if (!(await environment.isVisible()))
    await page.getByRole('button', { name: '显示环境信息', exact: true }).click();
  const open = async (index: number) => {
    await environment
      .locator(`[data-execution-id="${tasks[index]!.id}"]`)
      .getByRole('button', { name: /^查看子 Agent 详情/ })
      .click();
    await page.getByRole('button', { name: '返回主会话', exact: true }).waitFor();
  };
  const close = async () => {
    await page.getByRole('button', { name: '返回主会话', exact: true }).click();
    await page.locator('.session-header').getByTitle('Stream Parent', { exact: true }).waitFor();
  };
  const content = () => page.locator('.conversation').innerText();
  phase = 'first-live-child';
  await open(0);
  const first = await until(
    content,
    (value) => /CHILD_[AB]_INITIAL_TAIL/.test(value),
    'full >100KiB active prefix rendered automatically',
  );
  const firstChild = first.includes('CHILD_A_INITIAL_TAIL') ? 'CHILD_A' : 'CHILD_B';
  const liveDelays: number[] = [];
  for (let tick = 0; tick < 5; tick++) {
    const marker = `${firstChild}_LIVE_${tick}`;
    const { sent } = (await fetch(`${control}/step?child=${firstChild}&marker=${marker}`).then(
      (response) => response.json(),
    )) as { sent: number };
    await until(
      content,
      (value) => value.includes(marker),
      'live child marker visible without refresh',
    );
    liveDelays.push(Date.now() - sent);
    console.error('live_tick', tick, Date.now() - sent, (await state()).environmentRevision);
  }
  if (mode === 'capture') {
    await page.screenshot({ path: '/private/tmp/kite-native-child-stream-after.png' });
    console.log(JSON.stringify({ screenshot: '/private/tmp/kite-native-child-stream-after.png' }));
    await fetch(`${control}/finish`);
  } else {
    await close();
    await open(1);
    await until(
      content,
      (value) =>
        /CHILD_[AB]_INITIAL_TAIL/.test(value) && !value.includes(`${firstChild}_INITIAL_TAIL`),
      'second child content isolated',
    );
    await close();
    const baselineProviderCalls = (await count()).calls;
    assert.equal(baselineProviderCalls.filter((call) => call === 'CHILD_A').length, 1);
    assert.equal(baselineProviderCalls.filter((call) => call === 'CHILD_B').length, 1);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const waitForFiniteReads = () =>
      until(
        () =>
          app.evaluate(
            () =>
              (
                globalThis as unknown as {
                  childStreamReads: {
                    total: number;
                    active: number;
                    peak: number;
                    aborted: number;
                    paths: Record<string, number>;
                  };
                }
              ).childStreamReads,
          ),
        (value) => value.active === 0,
        'all finite background network bodies settled before sampling',
      );
    const sample = async () => {
      await waitForFiniteReads();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => queueMicrotask(resolve)));
          }),
      );
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage');
      const dom = await cdp.send('Memory.getDOMCounters');
      return {
        heap: heap.usedSize,
        documents: dom.documents,
        nodes: dom.nodes,
        listeners: dom.jsEventListeners,
      };
    };
    await page.evaluate(() => {
      const global = globalThis as typeof globalThis & { childStreamLongTasks: number[] };
      global.childStreamLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) global.childStreamLongTasks.push(entry.duration);
      }).observe({ type: 'longtask' });
    });
    const switches: number[] = [],
      samples: Awaited<ReturnType<typeof sample>>[] = [];
    phase = 'switch-soak';
    for (let index = 0; index < 100; index++) {
      const before = Date.now();
      await open(index % 2);
      await until(
        content,
        (value) => /CHILD_[AB]_INITIAL_TAIL/.test(value),
        'cached child visible',
      );
      await close();
      switches.push(Date.now() - before);
      if ([19, 59, 99].includes(index)) samples.push(await sample());
    }
    phase = 'settled';
    const reads = await waitForFiniteReads();
    const settledSample = await sample();
    const firstSample = samples[0]!,
      lastSample = settledSample;
    assert.ok(
      lastSample.heap < firstSample.heap + 12 * 1024 * 1024,
      `retained heap grew ${lastSample.heap - firstSample.heap}`,
    );
    assert.ok(
      lastSample.nodes < firstSample.nodes + 300,
      `retained DOM grew ${lastSample.nodes - firstSample.nodes}`,
    );
    assert.ok(
      lastSample.listeners < firstSample.listeners + 20,
      `retained listeners grew ${lastSample.listeners - firstSample.listeners}`,
    );
    assert.deepEqual((await count()).calls, baselineProviderCalls);
    assert.ok(reads.peak < 16, `unbounded parallel readers: ${reads.peak}`);
    const percentile = (values: number[], p: number) =>
      [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
    const longTasks = await page.evaluate(
      () => (globalThis as unknown as { childStreamLongTasks: number[] }).childStreamLongTasks,
    );
    const report = {
      switches: 100,
      switchP50Ms: percentile(switches, 0.5),
      switchP95Ms: percentile(switches, 0.95),
      liveP50Ms: percentile(liveDelays, 0.5),
      liveP95Ms: percentile(liveDelays, 0.95),
      samples,
      settledSample,
      reads,
      longTasks: {
        count: longTasks.length,
        p95Ms: percentile(longTasks, 0.95) ?? 0,
        maximumMs: Math.max(0, ...longTasks),
      },
      providerCalls: (await count()).calls,
      diagnosticsAbsent: true,
    };
    console.log(JSON.stringify(report));
    writeFileSync(
      '/private/tmp/kite-native-child-stream-after-markdown-cache-settled.json',
      JSON.stringify(report, null, 2),
    );
    assert.ok(
      longTasks.length < 10,
      `repeated navigation produced ${longTasks.length} main-thread long tasks`,
    );
    await fetch(`${control}/finish`);
    await until(
      state,
      (value) => value.selection!.runs.every((run) => !run.isActive),
      'all real runs settle',
    );
  }
} catch (cause) {
  console.error('native_child_stream_failed', phase, cause, diagnostics.slice(-15));
  const page = await app.firstWindow().catch(() => undefined);
  if (page) {
    console.error('failure_alerts', await page.getByRole('alert').allTextContents());
    console.error(
      'failure_hooks',
      await page.evaluate(() => {
        const node = document.querySelector('.conversation') as unknown as Record<string, unknown>;
        const key = Object.keys(node).find((name) => name.startsWith('__reactFiber'))!;
        let fiber = node[key] as { return?: unknown; memoizedState?: unknown } | undefined;
        const states: unknown[] = [];
        for (let level = 0; fiber && level < 80; level++, fiber = fiber.return as typeof fiber) {
          let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | undefined;
          for (let index = 0; hook && index < 250; index++, hook = hook.next as typeof hook) {
            const raw = hook.memoizedState as Record<string, unknown> | undefined;
            if (!raw || typeof raw !== 'object') continue;
            const value = (raw.current && typeof raw.current === 'object' ? raw.current : raw) as {
              scope?: string;
              loading?: boolean;
              busy?: boolean;
              queued?: boolean;
              running?: boolean;
              error?: string;
              facts?: {
                observationId?: number;
                upperSeq?: string;
                modelOutputs?: { snapshot: { output: { content: string } } }[];
              };
            };
            if (value.scope)
              states.push({
                scope: value.scope,
                loading: value.loading,
                busy: value.busy,
                queued: value.queued,
                running: value.running,
                error: value.error,
                observationId: value.facts?.observationId,
                upperSeq: value.facts?.upperSeq,
                tail: value.facts?.modelOutputs?.at(-1)?.snapshot.output.content.slice(-120),
              });
          }
        }
        return states;
      }),
    );
    console.error(
      'failure_state',
      await page.evaluate(async () => {
        const value = (await window.kiteNative!.request({
          method: 'state',
          generation: 1,
        })) as NativeState;
        return {
          generation: value.generation,
          environmentRevision: value.environmentRevision,
          backgroundUnavailable: value.backgroundUnavailable,
          historyEpoch: value.historyEpoch,
          selection: value.selection && {
            storeId: value.selection.storeId,
            sessionId: value.selection.session.id,
            viewSelection: value.selection.viewSelection,
            viewLoading: value.selection.viewLoading,
            permissionUnavailable: value.selection.permissionUnavailable,
            runs: value.selection.runs.map((run) => ({
              id: run.id,
              status: run.status,
              isActive: run.isActive,
            })),
          },
        };
      }),
    );
    console.error((await page.locator('body').innerText()).slice(-1000));
  }
  throw cause;
} finally {
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await app.evaluate(({ app }) => app.quit());
  await exited;
}
