import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createWriteStream, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { MixedShellLedger } from '../../service/test/isolated/multi-session-shell-load.shared';
import type { NativeBackgroundPage } from '../src/background-bridge';
import type { NativeJobOutputPage } from '../src/job-output-bridge';
import type { NativeState } from '../src/native-bridge';
import { collectNativeGpuMemory } from './native-gpu-memory.fixture';

type ProviderStatus = {
  calls: string[];
  active: { marker: string; tick: number }[];
  aborted: string[];
  shells: MixedShellLedger[];
};
type Metrics = {
  finite: {
    total: number;
    active: number;
    peak: number;
    aborted: number;
    bytes: number;
    durations: number[];
  };
  observe: { total: number; active: number; peak: number };
  held: boolean;
};
const [outdir, root, executablePath, control, measurement, workload, memoryDirectory] =
  process.argv.slice(2) as string[];
const mixed = workload === 'mixed';
const gpuEnabled = Boolean(memoryDirectory);
const evidence = memoryDirectory
  ? join(memoryDirectory, 'report')
  : join(tmpdir(), `kite-native-multi-session-${mixed ? 'shell-' : ''}stream`);
const app = await _electron.launch({
  executablePath,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 15000,
});
let phase = 'launch',
  servicePid: number | undefined;
const diagnostics: string[] = [];
app.process().stderr?.on('data', (value) => diagnostics.push(String(value).slice(0, 400)));
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
try {
  await (async () => {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => diagnostics.push(error.message));
    const desktopEnvironment = await app.evaluate(({ app, BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const display = screen.getDisplayMatching(window.getBounds());
      return {
        versions: process.versions,
        bounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
        display: { size: display.size, scaleFactor: display.scaleFactor },
        gpuFeatureStatus: app.getGPUFeatureStatus(),
      };
    });
    const state = () =>
      page.evaluate(
        async () =>
          (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
      );
    const provider = () =>
      fetch(`${control}/status`).then((response) => response.json()) as Promise<ProviderStatus>;
    const metrics = () =>
      app.evaluate(
        () => (globalThis as unknown as { multiStreamMetrics: Metrics }).multiStreamMetrics,
      );
    const collectMemory = async (stage: string, physical = false) => {
      const response = await fetch(`${control}/memory-census`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ servicePid, electronPid: app.process().pid, stage, physical }),
      });
      const value = (await response.json()) as {
        businessProcessCount?: number;
        roleSummary?: unknown;
        physical?: { status: string; jointDeduplicatedFootprintBytes: number | null };
        supervisorsPhysical?: { status: string; jointDeduplicatedFootprintBytes: number | null };
        error?: string;
      };
      assert.ok(
        response.ok,
        `memory census failed, unknown rather than zero: ${JSON.stringify(value)}`,
      );
      assert.equal(value.businessProcessCount, 65);
      return {
        stage,
        path: join(memoryDirectory!, `${stage}-census.json`),
        roleSummary: value.roleSummary,
        physical: value.physical,
        supervisorsPhysical: value.supervisorsPhysical,
      };
    };
    async function until<T>(
      read: () => Promise<T>,
      check: (value: T) => boolean,
      label: string,
      timeout = 25000,
    ) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await read();
        if (check(value)) return value;
        assert.ok(Date.now() < deadline, label);
        await page.waitForTimeout(25);
      }
    }
    await page.getByRole('button', { name: 'Live Root 0', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '保留草稿', exact: true }).count(), 0);
    servicePid = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => {
        const row = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return row &&
          Number(row[2]) === app.process().pid &&
          row[3]!.includes(join(root!, 'apps/service/dist/service.js'))
          ? [Number(row[1])]
          : [];
      })[0];
    assert.ok(servicePid, 'real independent Service PID is owned by Electron Main');
    const workerAsset = readdirSync(join(outdir!, 'assets')).find((name) =>
      /^native-markdown-worker-.+\.js$/.test(name),
    );
    assert.ok(workerAsset, 'build emits a concrete fixed Markdown Worker asset');
    const workerProbe = await page.evaluate(
      async (asset) =>
        new Promise<{ kind: string; error?: string; treeType?: string }>((resolve) => {
          let worker: Worker | undefined;
          const done = (value: { kind: string; error?: string; treeType?: string }) => {
            clearTimeout(timer);
            worker?.terminate();
            resolve(value);
          };
          const timer = setTimeout(() => done({ kind: 'timeout' }), 5000);
          try {
            worker = new Worker(new URL(`assets/${asset}`, location.href), { type: 'module' });
            worker.onerror = (event) =>
              done({
                kind: 'error',
                error: `${event.message} ${event.filename}:${event.lineno}:${event.colno}`,
              });
            worker.onmessage = (event) =>
              done({ kind: 'message', error: event.data?.error, treeType: event.data?.tree?.type });
            worker.postMessage({
              id: 1,
              text: '# Worker asset probe\n\n中文🙂 &amp; [safe](https://example.com)',
            });
          } catch (cause) {
            done({ kind: 'constructor-error', error: String(cause) });
          }
        }),
      workerAsset,
    );
    writeFileSync(`${evidence}-worker-probe.json`, JSON.stringify({ workerAsset, ...workerProbe }));
    assert.equal(
      workerProbe.kind,
      'message',
      'actual packaged Worker computes under the normal sandbox and CSP',
    );
    assert.equal(workerProbe.error, undefined);
    assert.equal(workerProbe.treeType, 'root');
    if (measurement === 'worker-probe') {
      console.log(JSON.stringify({ workerAssetProbe: workerProbe, businessWorkStarted: false }));
      return;
    }
    const jobs = new Map<number, { id: string; childId: string; marker: string }[]>();
    async function select(index: number) {
      await page.getByRole('button', { name: `Live Root ${index}`, exact: true }).click();
      await page
        .locator('.session-header')
        .getByTitle(`Live Root ${index}`, { exact: true })
        .waitFor();
      return until(
        state,
        (value) =>
          value.selection?.session.id === `root-${index}` &&
          !value.selection.viewLoading &&
          !value.selection.permissionUnavailable,
        'selected root admitted',
      );
    }
    async function authorize() {
      for (const kind of ['permission.trust', 'permission.mode'] as const)
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
                  : {
                      method: kind,
                      generation: 1,
                      observationId,
                      mode: 'full',
                      makeDefault: false,
                    },
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
    const environment = page.getByRole('region', { name: '环境信息', exact: true });
    async function open(index: number, child: number) {
      if (!(await environment.isVisible()))
        await page.getByRole('button', { name: '显示环境信息', exact: true }).click();
      const target = jobs.get(index)![child]!;
      await environment
        .locator(`[data-execution-id="${target.id}"]`)
        .getByRole('button', { name: /^查看子 Agent 详情/ })
        .click();
      await page
        .locator('.session-tab-child')
        .getByRole('region', { name: '子 Agent 详情', exact: true })
        .waitFor();
      assert.equal(
        await page.locator('.conversation').count(),
        2,
        'one parent plus exactly one active child conversation',
      );
      const immediateMarkers = [...new Set((await content()).match(/CHILD_\d_\d_INITIAL_TAIL/g))];
      assert.ok(
        immediateMarkers.every((marker) => marker === `${target.marker}_INITIAL_TAIL`),
        'entering a child never exposes a previous child while its target loads',
      );
      return target;
    }
    const content = async () =>
      (await page.locator('.session-tab-child .conversation').count())
        ? page.locator('.session-tab-child .conversation').innerText()
        : page.locator('.history-panel .conversation').innerText();
    async function close(index: number) {
      await page.getByRole('button', { name: '收起标签栏', exact: true }).click();
      await until(
        () => page.locator('.session-tab-child').count(),
        (value) => value === 0,
        'child tab unmounted',
      );
      assert.equal(
        await page.locator('.conversation').count(),
        1,
        'memory checkpoints retain only the parent conversation',
      );
      await page
        .locator('.session-header')
        .getByTitle(`Live Root ${index}`, { exact: true })
        .waitFor();
    }
    phase = 'start-four-roots';
    for (let index = 0; index < 4; index++) {
      await select(index);
      await authorize();
      await page
        .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
        .fill(`MULTI_ROOT_${index}`);
      const send = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
      await until(() => send.isEnabled(), Boolean, 'root send enabled');
      await send.click();
      const observed = await until(
        state,
        (value) => value.selection!.executions.filter((row) => !!row.childSessionId).length === 3,
        'three actual spawn_agent workers admitted',
      );
      const toolRows = observed.selection!.executions.filter(
        (row) => row.kind === 'tool' && row.definitionId === 'task.spawn',
      );
      const rootJobs = observed
        .selection!.executions.filter((row) => !!row.childSessionId)
        .map((job) => {
          const tool = toolRows.find((row) => row.id === job.parentExecutionId)!;
          assert.ok(tool, 'each actual child carrier belongs to its precise spawn Tool');
          assert.equal(tool.definitionVersion, '1');
          const input = tool.toolInput as { prompt: string; task_name: string };
          return {
            id: job.id,
            childId: job.childSessionId!,
            marker: input.prompt.replace('MULTI_', ''),
          };
        })
        .sort((a, b) => a.marker.localeCompare(b.marker));
      jobs.set(index, rootJobs);
      assert.deepEqual(
        rootJobs.map((job) => job.marker),
        Array.from({ length: 3 }, (_, child) => `CHILD_${index}_${child}`),
      );
      await until(
        provider,
        (value) =>
          value.active.filter(
            (row) => row.marker === `ROOT_${index}` || row.marker.startsWith(`CHILD_${index}_`),
          ).length === 4,
        'one parent and three children concurrently streaming',
      );
    }
    const allLive = await until(
      provider,
      (value) => value.active.length === 16 && value.active.every((row) => row.tick >= 2),
      'all four parents and twelve children generated repeated SSE frames',
    );
    assert.equal(
      allLive.calls.length,
      mixed ? 32 : 20,
      'only explicit tool-planning and held Model calls',
    );
    const shellStart = mixed
      ? await until(
          provider,
          (value) =>
            value.shells.length === 16 &&
            value.shells.every((row) => !row.complete && row.seq >= 2),
          'sixteen real Shell workloads produce output and CPU ledgers',
        )
      : undefined;
    if (shellStart)
      for (const row of shellStart.shells) {
        process.kill(row.pid, 0);
        process.kill(row.descendantPid, 0);
        assert.ok(row.stdoutBytes + row.stderrBytes >= 256 * 1024);
        assert.ok(row.cpuUserUs + row.cpuSystemUs > 0);
      }
    const backgroundHealth = await page.evaluate(async () => {
      const readId = crypto.randomUUID(),
        entries: {
          marker?: string;
          execution: { id: string; status: string };
          childRun: { status: string; isActive: boolean } | null;
        }[] = [];
      try {
        let result = await window.kiteNative!.request({
          method: 'background.open',
          generation: 1,
          readId,
        });
        for (;;) {
          if (!result || !('kind' in result) || result.kind !== 'background.page')
            throw Error('background_health_invalid');
          const page = result as NativeBackgroundPage;
          for (const entry of page.entries)
            entries.push({
              execution: { id: entry.execution.id, status: entry.execution.status },
              childRun: entry.childRun && {
                status: entry.childRun.status,
                isActive: entry.childRun.isActive,
              },
            });
          if (page.complete) return entries;
          result = await window.kiteNative!.request({
            method: 'background.next',
            generation: 1,
            readId,
          });
        }
      } finally {
        await window.kiteNative!.request({ method: 'background.close', generation: 1, readId });
      }
    });
    const childHealth = backgroundHealth.filter((row) => row.childRun !== null);
    assert.equal(childHealth.length, 12, 'twelve actual persisted child carrier/Run pairs');
    assert.ok(
      childHealth.every(
        (row) =>
          row.execution.status === 'running' &&
          row.childRun?.status === 'running' &&
          row.childRun.isActive,
      ),
      JSON.stringify(backgroundHealth),
    );
    if (mixed)
      assert.equal(
        backgroundHealth.filter(
          (row) => row.childRun === null && row.execution.status === 'running',
        ).length,
        16,
        'sixteen persisted real Shell Jobs are running beside Models',
      );
    const activeRuns: string[] = [];
    for (let index = 0; index < 4; index++) {
      const observed = await select(index);
      assert.ok(
        observed.selection!.runs.some((run) => run.isActive),
        'every parent Run remains active',
      );
      activeRuns.push(observed.selection!.runs.find((run) => run.isActive)!.id);
      assert.ok(
        observed.selection!.executions.some(
          (row) => row.kind === 'model' && ['dispatching', 'running'].includes(row.status),
        ),
        'parent has an actual dispatched streaming Model, beyond merely waiting Run',
      );
      await page
        .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
        .fill(`PRIVATE_DRAFT_ROOT_${index}`);
      if (mixed) {
        // Native's verified built-in adapter uses the product title, rather
        // than exposing the shell.launch implementation identifier.
        const activity = page
          .locator('.history-panel .conversation')
          .getByRole('article', { name: '启动后台 Shell · 成功', exact: true });
        await activity.waitFor();
        await until(
          () => activity.innerText(),
          (value) => value.includes(`'ROOT_${index}'`),
          'ordinary transcript renders the actual Shell tool call',
        );
        if (!(await environment.isVisible()))
          await page.getByRole('button', { name: '显示环境信息', exact: true }).click();
        await until(
          () =>
            environment
              .getByRole('region', { name: '当前运行的 Shell', exact: true })
              .locator('li')
              .count(),
          (count) => count > 0,
          'ordinary environment card renders current running Shell state',
        );
      }
      const target = await open(index, 0);
      await until(
        content,
        (value) => value.includes(`${target.marker}_INITIAL_TAIL`),
        'initial large child body rendered',
      );
      await close(index);
    }
    let shellOutput:
      | { upperSeq: string; records: number; bytes: number; gaps: number; streams: string[] }
      | undefined;
    if (mixed) {
      phase = 'fixed-shell-output-and-cancel';
      await select(0);
      shellOutput = await page.evaluate(async () => {
        const selected = (await window.kiteNative!.request({
          method: 'state',
          generation: 1,
        })) as NativeState;
        const execution = selected.selection!.executions.find(
          (row) => row.kind === 'job' && row.definitionId === 'shell.command',
        )!;
        if (!execution) throw Error('root_shell_missing');
        const readId = crypto.randomUUID();
        let upperSeq = '',
          records = 0,
          bytes = 0,
          gaps = 0;
        const streams = new Set<string>();
        const contents: Record<string, string> = {};
        try {
          let result = await window.kiteNative!.request({
            method: 'jobOutput.open',
            generation: 1,
            readId,
            executionId: execution.id,
            viewSelection: selected.selection!.viewSelection!,
            historyEpoch: selected.historyEpoch ?? 0,
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          for (;;) {
            if (!result || !('kind' in result) || result.kind !== 'jobOutput.page')
              throw Error('shell_output_page_missing');
            const page = result as NativeJobOutputPage;
            upperSeq ||= page.upperSeq;
            if (page.upperSeq !== upperSeq) throw Error('shell_fixed_high_water_changed');
            for (const row of page.page.items) {
              if (BigInt(row.throughSeq) > BigInt(upperSeq))
                throw Error('shell_output_above_fixed_range');
              records++;
              streams.add(row.stream);
              if (
                row.droppedBytes === null ||
                row.droppedBytes !== '0' ||
                row.seq !== row.throughSeq
              )
                gaps++;
              else {
                if (row.content.includes('\uFFFD')) throw Error('shell_invalid_utf8');
                contents[row.stream] = (contents[row.stream] ?? '') + row.content;
                bytes += new TextEncoder().encode(row.content).byteLength;
              }
            }
            if (page.complete) {
              for (const text of Object.values(contents))
                if (!text.includes('ROOT_0|') || /(?:ROOT_[1-3]|CHILD_\d_\d)\|/.test(text))
                  throw Error('shell_wrong_output_target');
              return { upperSeq, records, bytes, gaps, streams: [...streams] };
            }
            result = await window.kiteNative!.request({
              method: 'jobOutput.next',
              generation: 1,
              readId,
            });
          }
        } finally {
          await window.kiteNative!.request({ method: 'jobOutput.close', generation: 1, readId });
        }
      });
      assert.deepEqual([...shellOutput.streams].sort(), ['stderr', 'stdout']);
      assert.ok(shellOutput.records > 0 && shellOutput.bytes > 0);
      await app.evaluate(() => {
        (
          globalThis as unknown as { multiStreamMetrics: { holdNextOutput: boolean } }
        ).multiStreamMetrics.holdNextOutput = true;
      });
      const abortBefore = (await metrics()).finite.aborted;
      const pendingOutput = page.evaluate(async () => {
        const selected = (await window.kiteNative!.request({
          method: 'state',
          generation: 1,
        })) as NativeState;
        const execution = selected.selection!.executions.find(
          (row) => row.kind === 'job' && row.definitionId === 'shell.command',
        )!;
        const readId = crypto.randomUUID();
        try {
          await window.kiteNative!.request({
            method: 'jobOutput.open',
            generation: 1,
            readId,
            executionId: execution.id,
            viewSelection: selected.selection!.viewSelection!,
            historyEpoch: selected.historyEpoch ?? 0,
          });
          return 'read';
        } catch {
          return 'cancelled';
        } finally {
          await window.kiteNative!.request({ method: 'jobOutput.close', generation: 1, readId });
        }
      });
      await until(
        metrics,
        (value) => value.held,
        'actual Shell output response held before reading',
      );
      await select(1);
      assert.equal(await pendingOutput, 'cancelled');
      await until(
        metrics,
        (value) => !value.held && value.finite.active === 0 && value.finite.aborted > abortBefore,
        'navigation cancels Shell output read without stopping its workload',
      );
      assert.equal((await provider()).shells.filter((row) => !row.complete).length, 16);
    }
    const liveDelays: number[] = [];
    phase = 'live-main-and-child';
    await select(0);
    const rootBefore = (await provider()).active.find((row) => row.marker === 'ROOT_0')!.tick;
    const rootStarted = Date.now();
    await until(
      content,
      (value) => value.includes(`ROOT_0_TICK_${rootBefore + 1}`),
      'main Agent live prefix grows without explicit refresh',
    );
    liveDelays.push(Date.now() - rootStarted);
    const current = await open(0, 0);
    const childBefore = (await provider()).active.find(
      (row) => row.marker === current.marker,
    )!.tick;
    const childStarted = Date.now();
    await until(
      content,
      (value) => value.includes(`${current.marker}_TICK_${childBefore + 1}`),
      'child Agent live prefix grows without explicit refresh',
    );
    liveDelays.push(Date.now() - childStarted);
    await close(0);
    phase = 'cancel-held-view-read';
    await app.evaluate(() => {
      (
        globalThis as unknown as { multiStreamMetrics: { holdNextModel: boolean } }
      ).multiStreamMetrics.holdNextModel = true;
    });
    await open(0, 0);
    await until(
      metrics,
      (value) => value.held,
      'real selected child Model body reader held externally',
    );
    const abortsBefore = (await metrics()).finite.aborted;
    await select(1);
    await until(
      metrics,
      (value) => !value.held && value.finite.active === 0 && value.finite.aborted > abortsBefore,
      'view navigation aborts held real body reader',
    );
    assert.equal(
      (await provider()).active.length,
      16,
      'read cancellation leaves every business stream running',
    );
    const cdp = await page.context().newCDPSession(page);
    const sample = async (stage: string) => {
      const snapshotBarrier = {
        deferredChanges: 0,
        elapsedMs: 0,
        overflow: false,
        postReleaseSettledMs: 0,
      };
      // Test-host snapshot boundary only. Backend streams, Shells, HTTP reads,
      // request replies and lifecycle messages continue. Queue changed notices
      // in order so a new React commit cannot race the retained-object census.
      await app.evaluate(({ BrowserWindow }) => {
        const host = globalThis as typeof globalThis & {
          nativeSnapshotRelease?: () => {
            deferredChanges: number;
            elapsedMs: number;
            overflow: boolean;
          };
        };
        if (host.nativeSnapshotRelease) throw Error('overlapping_native_snapshot');
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        const original = contents.send;
        const queue: Parameters<typeof contents.send>[] = [];
        const started = Date.now();
        let deferredChanges = 0,
          overflow = false;
        const flush = () => {
          for (const args of queue.splice(0)) original.apply(contents, args);
        };
        contents.send = (channel, ...args) => {
          if (channel === 'kite:native:changed' && args[0]?.kind === 'changed' && !overflow) {
            if (queue.length < 4096) {
              deferredChanges++;
              queue.push([channel, ...args]);
              return;
            }
            overflow = true;
            flush();
          }
          original.apply(contents, [channel, ...args]);
        };
        host.nativeSnapshotRelease = () => {
          contents.send = original;
          delete host.nativeSnapshotRelease;
          flush();
          return { deferredChanges, elapsedMs: Date.now() - started, overflow };
        };
      });
      const snapshot = await (async () => {
        try {
          assert.equal(
            (await state()).selection!.session.id,
            'root-3',
            'equivalent main root is sampled at each checkpoint',
          );
          await page.locator('.history-panel .conversation-viewport').evaluate((element) => {
            element.scrollTop = 0;
          });
          await until(
            metrics,
            (value) => value.finite.active === 0,
            'finite body reads settled before GC',
          );
          await until(
            () => page.getByRole('status').allTextContents(),
            (texts) => !texts.some((text) => /正在完整校准历史|历史尚未完整校准/.test(text)),
            'equivalent fully calibrated UI before retained-object snapshot',
          );
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => queueMicrotask(resolve))),
              ),
          );
          await cdp.send('HeapProfiler.collectGarbage');
          const firstGcDom = await cdp.send('Memory.getDOMCounters');
          // Chromium's weak handle callbacks can finish on the next task. Sample
          // every checkpoint after the same two-pass GC, keeping the original
          // retained-node/listener limits rather than counting pending disposal.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                setTimeout(
                  () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  0,
                ),
              ),
          );
          await cdp.send('HeapProfiler.collectGarbage');
          const heap = await cdp.send('Runtime.getHeapUsage'),
            dom = await cdp.send('Memory.getDOMCounters');
          const connectedNodes = await page.evaluate(() => {
            const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
            let count = 1;
            while (walker.nextNode()) count++;
            return count;
          });
          const processRow = execFileSync(
            '/bin/ps',
            ['-p', String(servicePid), '-o', '%cpu=,rss='],
            {
              encoding: 'utf8',
            },
          )
            .trim()
            .split(/\s+/)
            .map(Number);
          const serviceTreeRows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], {
            encoding: 'utf8',
          })
            .split('\n')
            .flatMap((line) => {
              const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)$/);
              return match
                ? [
                    {
                      pid: Number(match[1]),
                      parent: Number(match[2]),
                      cpu: Number(match[3]),
                      rss: Number(match[4]),
                    },
                  ]
                : [];
            });
          const serviceTree = new Set([servicePid!]);
          for (let changed = true; changed; ) {
            changed = false;
            for (const row of serviceTreeRows)
              if (serviceTree.has(row.parent) && !serviceTree.has(row.pid)) {
                serviceTree.add(row.pid);
                changed = true;
              }
          }
          const serviceProcesses = serviceTreeRows.filter((row) => serviceTree.has(row.pid));
          // macOS coalition launches need not remain physical descendants of the
          // Service. Include the ledger's actual workload/sleep PIDs explicitly.
          const shellPids = new Set(
            shellStart?.shells.flatMap((row) => [row.pid, row.descendantPid]) ?? [],
          );
          const shellProcesses = serviceTreeRows.filter((row) => shellPids.has(row.pid));
          const measuredOwnedProcesses = serviceTreeRows.filter(
            (row) => serviceTree.has(row.pid) || shellPids.has(row.pid),
          );
          const fileDescriptors = execFileSync(
            '/usr/sbin/lsof',
            ['-n', '-P', '-p', String(servicePid), '-F', 'f'],
            {
              encoding: 'utf8',
              maxBuffer: 8 * 1024 * 1024,
            },
          )
            .trim()
            .split('\n')
            .filter((line) => /^f[0-9]+$/.test(line)).length;
          return {
            snapshotBarrier,
            heap: heap.usedSize,
            firstGcDom,
            documents: dom.documents,
            nodes: dom.nodes,
            listeners: dom.jsEventListeners,
            connectedNodes,
            retainedOutsideDocumentNodes: dom.nodes - connectedNodes,
            serviceCpuPercent: processRow[0],
            serviceRssKiB: processRow[1],
            serviceTreeProcesses: serviceProcesses.length,
            serviceTreeRssKiB: serviceProcesses.reduce((sum, row) => sum + row.rss, 0),
            serviceTreeCpuPercent: serviceProcesses.reduce((sum, row) => sum + row.cpu, 0),
            observedShellProcesses: shellProcesses.length,
            measuredOwnedProcesses: measuredOwnedProcesses.length,
            measuredOwnedRssKiB: measuredOwnedProcesses.reduce((sum, row) => sum + row.rss, 0),
            measuredOwnedCpuPercent: measuredOwnedProcesses.reduce((sum, row) => sum + row.cpu, 0),
            serviceFileDescriptors: fileDescriptors,
          };
        } finally {
          Object.assign(
            snapshotBarrier,
            await app.evaluate(() => {
              const host = globalThis as typeof globalThis & {
                nativeSnapshotRelease?: () => {
                  deferredChanges: number;
                  elapsedMs: number;
                  overflow: boolean;
                };
              };
              if (!host.nativeSnapshotRelease) throw Error('native_snapshot_boundary_missing');
              return host.nativeSnapshotRelease();
            }),
          );
          assert.equal(snapshotBarrier.overflow, false, 'snapshot queue must never drop updates');
          assert.ok(snapshotBarrier.elapsedMs < 30000, 'snapshot boundary is finite');
        }
      })();
      const releasedAt = Date.now();
      // Let the queued notices reach the renderer and finish their body reads
      // before measuring footprint or starting the next timed navigation.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await until(
        metrics,
        (value) => value.finite.active === 0,
        'released snapshot notices finish their finite reads',
      );
      await until(
        () => page.getByRole('status').allTextContents(),
        (texts) => !texts.some((text) => /正在完整校准历史|历史尚未完整校准/.test(text)),
        'released snapshot notices finish UI calibration',
      );
      snapshotBarrier.postReleaseSettledMs = Date.now() - releasedAt;
      return {
        ...snapshot,
        ...(memoryDirectory ? { memoryCensus: await collectMemory(stage) } : {}),
      };
    };
    await page.evaluate(() => {
      const global = globalThis as typeof globalThis & {
        multiLongTasks: number[];
        multiLongTaskEntries: { startTime: number; duration: number }[];
        multiLongTaskObserver: PerformanceObserver;
      };
      global.multiLongTasks = [];
      global.multiLongTaskEntries = [];
      global.multiLongTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          global.multiLongTasks.push(entry.duration);
          global.multiLongTaskEntries.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      global.multiLongTaskObserver.observe({ type: 'longtask' });
    });
    if (measurement === 'profile') {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
      await cdp.send('Profiler.start');
    }
    const navigation: number[] = [],
      samples: Awaited<ReturnType<typeof sample>>[] = [];
    phase = '120-cross-root-child-navigations';
    for (let round = 0; round < 120; round++) {
      const index = round % 4,
        child = Math.floor(round / 4) % 3,
        started = Date.now();
      await select(index);
      assert.equal(
        await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).innerText(),
        `PRIVATE_DRAFT_ROOT_${index}`,
        'per-root private draft survives other live views',
      );
      const target = await open(index, child);
      await until(
        content,
        (value) => value.includes(`${target.marker}_INITIAL_TAIL`),
        'exact target child visible',
      );
      const displayed = await content();
      assert.deepEqual(
        [...new Set(displayed.match(/CHILD_\d_\d_INITIAL_TAIL/g))],
        [`${target.marker}_INITIAL_TAIL`],
        'old child result never enters another root/child page',
      );
      if (round % 2 === 0) await close(index);
      // Odd iterations switch directly from a child to another root on the next round.
      navigation.push(Date.now() - started);
      if ([19, 59, 119].includes(round)) {
        if (round % 2) await close(index);
        samples.push(await sample(`checkpoint-${round + 1}`));
      }
    }
    if (await page.locator('.session-tab-child').count()) await close(3);
    if (measurement === 'profile') {
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(
        join(tmpdir(), 'kite-native-multi-session-navigation.cpuprofile'),
        JSON.stringify(profile),
      );
      writeFileSync(
        join(tmpdir(), 'kite-native-multi-session-longtasks.json'),
        JSON.stringify(
          await page.evaluate(
            () =>
              (globalThis as unknown as { multiLongTaskEntries: unknown[] }).multiLongTaskEntries,
          ),
        ),
      );
    }
    const settled = await sample('settled'),
      reading = await metrics(),
      beforeStops = await provider();
    const longTasks = await page.evaluate(() => {
      const global = globalThis as unknown as {
        multiLongTasks: number[];
        multiLongTaskObserver: PerformanceObserver;
      };
      global.multiLongTaskObserver.disconnect();
      return [...global.multiLongTasks];
    });
    assert.equal(beforeStops.active.length, 16);
    assert.deepEqual(
      beforeStops.calls,
      allLive.calls,
      '120 navigation cycles create no Provider requests',
    );
    assert.deepEqual(
      reading.observe,
      { total: 1, active: 1, peak: 1 },
      'one global observer serves every root and child',
    );
    writeFileSync(
      `${evidence}-pre-stop.json`,
      JSON.stringify(
        {
          samples,
          settled,
          reading: {
            ...reading,
            finite: {
              ...reading.finite,
              durations: undefined,
              requestP50Ms: percentile(reading.finite.durations, 0.5),
              requestP95Ms: percentile(reading.finite.durations, 0.95),
            },
          },
          navigationP50Ms: percentile(navigation, 0.5),
          navigationP95Ms: percentile(navigation, 0.95),
          providerCalls: beforeStops.calls,
        },
        null,
        2,
      ),
    );
    if (
      settled.retainedOutsideDocumentNodes >= samples[0]!.retainedOutsideDocumentNodes + 400 ||
      settled.listeners >= samples[0]!.listeners + 30
    ) {
      const heapFile = createWriteStream(`${evidence}-retained.heapsnapshot`);
      const receive = ({ chunk }: { chunk: string }) => {
        heapFile.write(chunk);
      };
      cdp.on('HeapProfiler.addHeapSnapshotChunk', receive);
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      cdp.off('HeapProfiler.addHeapSnapshotChunk', receive);
      await new Promise<void>((resolve, reject) => {
        heapFile.on('error', reject);
        heapFile.end(resolve);
      });
      const detached: unknown[] = [];
      for (const constructorName of [
        'HTMLDivElement',
        'HTMLParagraphElement',
        'HTMLButtonElement',
        'HTMLTextAreaElement',
      ]) {
        const prototype = await cdp.send('Runtime.evaluate', {
          expression: `${constructorName}.prototype`,
          objectGroup: 'multi-leak-diagnostic',
        });
        const queried = await cdp.send('Runtime.queryObjects', {
          prototypeObjectId: prototype.result.objectId!,
          objectGroup: 'multi-leak-diagnostic',
        });
        const summary = await cdp.send('Runtime.callFunctionOn', {
          objectId: queried.objects.objectId!,
          functionDeclaration: `function() { const nodes = this.filter(node => !node.isConnected); return { count: nodes.length, examples: nodes.slice(0, 12).map(node => ({ tag: node.tagName, class: node.className, html: node.outerHTML.slice(0, 180) })) }; }`,
          returnByValue: true,
        });
        detached.push({ constructorName, ...summary.result.value });
      }
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'multi-leak-diagnostic' });
      writeFileSync(`${evidence}-detached.json`, JSON.stringify(detached, null, 2));
    }
    assert.ok(
      settled.heap < samples[0]!.heap + 16 * 1024 * 1024,
      'bounded settled renderer growth',
    );
    // Raw DOM is expected to grow with the deliberately appended live Markdown
    // paragraphs. Keep the original 400-node retention allowance after subtracting
    // the current connected document, and retain both raw counts in the evidence.
    assert.ok(
      settled.retainedOutsideDocumentNodes < samples[0]!.retainedOutsideDocumentNodes + 400,
      `retained DOM excess grew: raw ${samples[0]!.nodes}→${settled.nodes}, connected ${samples[0]!.connectedNodes}→${settled.connectedNodes}, excess ${samples[0]!.retainedOutsideDocumentNodes}→${settled.retainedOutsideDocumentNodes}`,
    );
    assert.ok(settled.listeners < samples[0]!.listeners + 30);
    const pidAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const shellBeforeStops = mixed
      ? await until(
          provider,
          (value) =>
            value.shells.length === 16 &&
            value.shells.every(
              (row) =>
                !row.complete &&
                row.elapsedMs >= 30000 &&
                pidAlive(row.pid) &&
                pidAlive(row.descendantPid),
            ),
          'sixteen real Shell trees overlap for at least thirty seconds',
        )
      : undefined;
    let heavyMemory: unknown;
    let gpuPid: number | undefined;
    const gpuEvidence: unknown[] = [];
    const captureGpu = async (stage: string) => {
      assert.ok(memoryDirectory && gpuPid);
      const response = await fetch(`${control}/gpu-memory-census`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, pid: gpuPid }),
      });
      assert.ok(response.ok, `GPU OS census failed: ${await response.text()}`);
      const traced = await collectNativeGpuMemory({
        cdp,
        gpuPid,
        evidenceDir: memoryDirectory,
        stage,
      });
      const summary = {
        stage,
        gpuPid,
        status: traced.status,
        elapsedMs: traced.elapsedMs,
        gpuRoot: traced.gpuRoot,
        unknown: traced.unknown,
        errors: traced.errors,
        reportPath: traced.reportPath,
      };
      gpuEvidence.push(summary);
      assert.equal(traced.status, 'ok', `GPU trace incomplete: ${JSON.stringify(summary)}`);
      return summary;
    };
    if (memoryDirectory) {
      phase = 'joint-physical-memory-outside-navigation-timing';
      const startedAt = Date.now(),
        before = await provider();
      const census = await collectMemory('physical-after-navigation', true);
      const after = await provider();
      heavyMemory = {
        ...census,
        startedAt,
        finishedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        before: { ticks: before.active, shells: before.shells },
        after: { ticks: after.active, shells: after.shells },
      };
      writeFileSync(
        join(memoryDirectory, 'heavy-window.json'),
        JSON.stringify(heavyMemory, null, 2),
      );
      assert.equal(
        census.physical?.status,
        'ok',
        'complete joint physical memory is required; unknown is not zero',
      );
      assert.ok(typeof census.physical.jointDeduplicatedFootprintBytes === 'number');
      if (gpuEnabled) {
        assert.equal(census.supervisorsPhysical?.status, 'ok');
        assert.ok(typeof census.supervisorsPhysical.jointDeduplicatedFootprintBytes === 'number');
      }
      if (gpuEnabled) {
        const identities = JSON.parse(
          readFileSync(join(memoryDirectory, 'physical-after-navigation-census.json'), 'utf8'),
        ) as { processes: { role: string; pid: number }[] };
        gpuPid = identities.processes.find((row) => row.role === 'desktop-gpu')?.pid;
        phase = 'gpu-attribution-after-navigation-and-footprint';
        const before = await provider();
        const trace = await captureGpu('gpu-after-navigation');
        await collectMemory('gpu-after-navigation-post-trace');
        const after = await provider();
        writeFileSync(
          join(memoryDirectory, 'gpu-attribution-live-window.json'),
          JSON.stringify({ trace, before, after }, null, 2),
        );
        assert.equal(after.active.length, 16, 'all Model streams remain live through GPU dump');
        assert.ok(
          after.shells.every((row) => !row.complete && pidAlive(row.pid)),
          'all sixteen Shell workloads remain live through GPU dump',
        );
      }
    }
    phase = 'accurate-root-cancel';
    const rootZero = await select(0);
    const commandId = `cancel-root-zero-${Date.now()}`;
    const rootCancelStartedAt = Date.now();
    await page.evaluate(
      async ({ commandId, originCommandId, storeId }) => {
        await window.kiteNative!.request({
          method: 'caller.prepare',
          generation: 1,
          sessionId: 'root-0',
          intent: {
            kind: 'command.cancel',
            commandId,
            expectedStoreId: storeId,
            targetCommandId: originCommandId,
          },
        });
        await window.kiteNative!.request({ method: 'caller.submit', generation: 1, commandId });
      },
      {
        commandId,
        originCommandId: rootZero.selection!.runs.find((run) => run.isActive)!.originCommandId,
        storeId: rootZero.selection!.storeId,
      },
    );
    const afterRootStop = await until(
      provider,
      (value) =>
        !value.active.some((row) => row.marker === 'ROOT_0' || row.marker.startsWith('CHILD_0_')) &&
        value.active.length === 12,
      'root cancel stops its actual attached parent/three-child domain only',
    );
    const rootStreamStopMs = Date.now() - rootCancelStartedAt;
    await until(
      state,
      (value) => value.selection!.runs.every((run) => !run.isActive),
      'root zero real terminal state observed',
    );
    if (shellBeforeStops)
      await until(
        provider,
        (value) =>
          value.shells
            .filter((row) => row.label === 'ROOT_0' || row.label.startsWith('CHILD_0_'))
            .every((row) => !pidAlive(row.pid) && !pidAlive(row.descendantPid)) &&
          value.shells
            .filter((row) => row.label !== 'ROOT_0' && !row.label.startsWith('CHILD_0_'))
            .every((row) => pidAlive(row.pid) && pidAlive(row.descendantPid)),
        'root cancel stops only its attached four real Shell trees',
      );
    const rootTreeStopMs = Date.now() - rootCancelStartedAt;
    phase = 'accurate-child-stop';
    await select(1);
    if (!(await environment.isVisible()))
      await page.getByRole('button', { name: '显示环境信息', exact: true }).click();
    await environment.waitFor({ state: 'visible' });
    const stoppedChild = jobs.get(1)![0]!;
    const childCancelStartedAt = Date.now();
    await environment
      .locator(`[data-execution-id="${stoppedChild.id}"]`)
      .getByRole('button', { name: '停止', exact: true })
      .click();
    const afterChildStop = await until(
      provider,
      (value) =>
        !value.active.some((row) => row.marker === stoppedChild.marker) &&
        value.active.length === 11,
      'exact child stop leaves parent and siblings/other roots streaming',
    );
    const childStreamStopMs = Date.now() - childCancelStartedAt;
    let childTreeStopMs: number | undefined;
    if (shellBeforeStops) {
      const stoppedLabels = new Set([
        'ROOT_0',
        ...jobs.get(0)!.map((row) => row.marker),
        stoppedChild.marker,
      ]);
      await until(
        provider,
        (value) =>
          value.shells.every((row) =>
            stoppedLabels.has(row.label)
              ? !pidAlive(row.pid) && !pidAlive(row.descendantPid)
              : pidAlive(row.pid) &&
                pidAlive(row.descendantPid) &&
                row.seq > shellBeforeStops.shells.find((before) => before.label === row.label)!.seq,
          ),
        'exact child stop ends its own Shell tree while all eleven unrelated trees continue',
      );
      childTreeStopMs = Date.now() - childCancelStartedAt;
    }
    await page.waitForTimeout(800);
    const continued = await provider();
    for (const row of continued.active)
      assert.ok(
        row.tick > afterChildStop.active.find((before) => before.marker === row.marker)!.tick,
        'unrelated stream continues producing real frames after stops',
      );
    assert.deepEqual(continued.calls, allLive.calls, 'stops do not replay Model work');
    const finalReads = await until(
      metrics,
      (value) => value.finite.active === 0,
      'finite reads settled after explicit stops',
    );
    const report = {
      ...(memoryDirectory ? { memoryEvidenceDirectory: memoryDirectory, heavyMemory } : {}),
      gpuEvidence,
      rendererBuildEnvironment: 'production',
      desktopEnvironment,
      roots: 4,
      childrenPerRoot: 3,
      actualSimultaneousStreams: 16,
      testHostModelConcurrency: 16,
      productionDefaultModelConcurrency: 4,
      ...(mixed
        ? {
            testHostProcessConcurrency: 16,
            productionDefaultProcessConcurrency: 4,
            actualSimultaneousShellTrees: 16,
            shellStart: shellStart!.shells,
            shellBeforeStops: shellBeforeStops!.shells,
            shellOutput,
            shellMeasured: {
              overlapMs: Math.min(...shellBeforeStops!.shells.map((row) => row.elapsedMs)),
              producedBytes: shellBeforeStops!.shells.reduce(
                (total, row) => total + row.stdoutBytes + row.stderrBytes,
                0,
              ),
              cpuUserUs: shellBeforeStops!.shells.reduce((total, row) => total + row.cpuUserUs, 0),
              cpuSystemUs: shellBeforeStops!.shells.reduce(
                (total, row) => total + row.cpuSystemUs,
                0,
              ),
              steadyBytesPerSecond: shellBeforeStops!.shells.reduce((sum, row) => {
                const before = shellStart!.shells.find((item) => item.label === row.label)!;
                return (
                  sum +
                  ((row.stdoutBytes + row.stderrBytes - before.stdoutBytes - before.stderrBytes) *
                    1000) /
                    (row.elapsedMs - before.elapsedMs)
                );
              }, 0),
              scriptWindowCpuPercent: shellBeforeStops!.shells.reduce((sum, row) => {
                const before = shellStart!.shells.find((item) => item.label === row.label)!;
                return (
                  sum +
                  ((row.cpuUserUs + row.cpuSystemUs - before.cpuUserUs - before.cpuSystemUs) /
                    1000 /
                    (row.elapsedMs - before.elapsedMs)) *
                    100
                );
              }, 0),
              fixedOutputIsNormalPrivateProtocol: true,
              ordinaryClientHasFullOutputUI: false,
            },
          }
        : {}),
      navigations: 120,
      navigationP50Ms: percentile(navigation, 0.5),
      navigationP95Ms: percentile(navigation, 0.95),
      navigationSamplesMs: navigation,
      liveWaitP50Ms: percentile(liveDelays, 0.5),
      liveWaitP95Ms: percentile(liveDelays, 0.95),
      longTasks: {
        count: longTasks.length,
        p95Ms: percentile(longTasks, 0.95),
        maximumMs: Math.max(0, ...longTasks),
      },
      samples,
      settled,
      reads: {
        ...finalReads,
        finite: {
          ...finalReads.finite,
          durations: undefined,
          requestP50Ms: percentile(finalReads.finite.durations, 0.5),
          requestP95Ms: percentile(finalReads.finite.durations, 0.95),
        },
      },
      providerCalls: allLive.calls,
      activeRuns,
      rootStop: {
        stopped: ['ROOT_0', ...jobs.get(0)!.map((row) => row.marker)],
        remainingStreams: afterRootStop.active.length,
        streamStopMs: rootStreamStopMs,
        treeStopMs: rootTreeStopMs,
      },
      childStop: {
        stopped: stoppedChild.marker,
        remainingStreams: continued.active.length,
        streamStopMs: childStreamStopMs,
        treeStopMs: childTreeStopMs,
      },
      servicePid,
      diagnosticsAbsent: true,
    };
    writeFileSync(`${evidence}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    assert.ok(
      longTasks.length < 12,
      'no repeated navigation long-task pattern across 120 switches',
    );
    await fetch(`${control}/finish`);
    for (let index = 1; index < 4; index++) {
      await select(index);
      await until(
        state,
        (value) => value.selection!.runs.every((run) => !run.isActive),
        'remaining business runs settle',
      );
    }
    if (shellStart)
      await until(
        provider,
        (value) =>
          value.shells.length === 16 &&
          value.shells.every((row) => !pidAlive(row.pid) && !pidAlive(row.descendantPid)),
        'every owned real Shell tree has ended after normal finish',
      );
    if (gpuEnabled) {
      phase = 'gpu-attribution-after-business-settled';
      await page.waitForTimeout(500);
      await captureGpu('gpu-after-business-settled');
      writeFileSync(
        join(memoryDirectory!, 'gpu-attribution-summary.json'),
        JSON.stringify(gpuEvidence, null, 2),
      );
    }
  })();
} catch (cause) {
  console.error('native_multi_stream_failed', phase, cause, diagnostics.slice(-12));
  const page = await app.firstWindow().catch(() => undefined);
  if (page) {
    await page
      .screenshot({ path: join(root!, 'failure.png'), fullPage: true })
      .catch(() => undefined);
    console.error(
      'failure_selection',
      await page
        .evaluate(async () => {
          const value = (await window.kiteNative!.request({
            method: 'state',
            generation: 1,
          })) as NativeState;
          return {
            sessionId: value.selection?.session.id,
            viewLoading: value.selection?.viewLoading,
            permissionUnavailable: value.selection?.permissionUnavailable,
          };
        })
        .catch(() => undefined),
    );
    console.error(
      'failure_header',
      await page
        .locator('.session-header')
        .innerText()
        .catch(() => undefined),
    );
    console.error('alerts', await page.getByRole('alert').allTextContents());
    console.error(
      'tool_groups',
      await page.locator('.history-panel .conversation .tool-activity').evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: node.getAttribute('aria-label'),
          text: node.textContent?.slice(0, 200),
        })),
      ),
    );
    console.error('body_tail', (await page.locator('body').innerText()).slice(-1600));
  }
  throw cause;
} finally {
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await app.evaluate(({ app }) => app.quit());
  await exited;
  if (servicePid) {
    assert.throws(
      () => process.kill(servicePid!, 0),
      'owned independent Service process exits with Main',
    );
    writeFileSync(
      `${evidence}-exit.json`,
      JSON.stringify({ servicePid, serviceAbsent: true, electronExited: true }),
    );
  }
}
