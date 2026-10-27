import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [outdir, root, executablePath, control, protocol, mode] = process.argv.slice(2) as string[];
const app = await _electron.launch({
  executablePath,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 15000,
});
// Read editor text without CSS paragraph margins adding visual blank lines.
// Keep every actual line break and leading/trailing space in the original draft.
const promptText = (input: import('playwright').Locator) =>
  input.evaluate((element) => {
    const text = (node: Node): string =>
      node.nodeName === 'BR'
        ? '\n'
        : node.nodeType === 3
          ? (node.textContent ?? '')
          : [...node.childNodes].map(text).join('');
    return [...element.children]
      .map((child) => (child.textContent ? text(child) : ''))
      .join('\n')
      .replace(/\r\n?/g, '\n');
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
  await page.evaluate(() => {
    const host = globalThis as typeof globalThis & {
      childStreamProcess?: {
        observations: number;
        welcomeFrames: number;
        duplicateFrames: number;
        stages: { phase: string; text: string; busy: string | null }[];
      };
    };
    const process = {
      observations: 0,
      welcomeFrames: 0,
      duplicateFrames: 0,
      stages: [] as { phase: string; text: string; busy: string | null }[],
    };
    host.childStreamProcess = process;
    const observe = () => {
      const child = document.querySelector('.session-tab-child .conversation');
      if (!child) return;
      process.observations++;
      const text = child.textContent ?? '';
      if (child.querySelector('.welcome')) process.welcomeFrames++;
      if (
        ['CHILD_A_INITIAL_TAIL', 'CHILD_B_INITIAL_TAIL'].some(
          (marker) => text.split(marker).length > 2,
        )
      )
        process.duplicateFrames++;
    };
    new MutationObserver(observe).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  const capture = async (stage: 'first' | 'live' | 'complete') => {
    const result = await page.evaluate((phase) => {
      const child = document.querySelector('.session-tab-child .conversation');
      const process = (
        globalThis as typeof globalThis & {
          childStreamProcess: {
            observations: number;
            welcomeFrames: number;
            duplicateFrames: number;
            stages: { phase: string; text: string; busy: string | null }[];
          };
        }
      ).childStreamProcess;
      process.stages.push({
        phase,
        text: (child?.textContent ?? '').slice(-220),
        busy: child?.querySelector('.conversation-viewport')?.getAttribute('aria-busy') ?? null,
      });
      return process;
    }, stage);
    assert.ok(result.observations > 0, 'child DOM mutations were observed throughout navigation');
    assert.equal(
      result.welcomeFrames,
      0,
      'unread child history never becomes a new conversation welcome',
    );
    assert.equal(
      result.duplicateFrames,
      0,
      'streamed child messages do not duplicate across handoff',
    );
    await page.screenshot({ path: join(root!, `child-stream-${stage}.png`) });
    writeFileSync(
      join(root!, 'child-stream-process.json'),
      JSON.stringify({ protocol, ...result }, null, 2),
    );
  };
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
  const model = page.locator('[data-model-picker] [data-model-trigger]');
  await model.click();
  await page.getByRole('button', { name: '选择模型，当前 未选择', exact: true }).click();
  await page.getByRole('option', { name: '选择模型 fixture', exact: true }).click();
  await page.keyboard.press('Escape');
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
  const spawnTools = selected.selection!.executions.filter(
    (row) => row.kind === 'tool' && row.definitionId === 'task.spawn',
  );
  assert.equal(spawnTools.length, 2);
  const tasks = selected
    .selection!.executions.filter((row) => !!row.childSessionId)
    .map((carrier) => {
      const tool = spawnTools.find((row) => row.id === carrier.parentExecutionId);
      assert.ok(tool, 'each actual child carrier belongs to its precise spawn Tool');
      assert.equal(tool.definitionVersion, '1');
      const input = tool.toolInput as { prompt: string; taskName: string };
      return { ...carrier, prompt: input.prompt, taskName: input.taskName };
    })
    .sort((a, b) => a.taskName.localeCompare(b.taskName));
  assert.deepEqual(
    tasks.map((task) => [task.taskName, task.prompt]),
    [
      ['child-0', 'CHILD_A'],
      ['child-1', 'CHILD_B'],
    ],
  );
  assert.equal(new Set(tasks.map((task) => task.childSessionId)).size, 2);
  phase = 'actual-parent-long-wait';
  const waiting = await until(
    state,
    (value) =>
      value.selection!.executions.some((row) => {
        const input = row.toolInput as { afterSeq?: string; waitMs?: number } | undefined;
        return (
          row.kind === 'tool' &&
          row.definitionId === 'task.events' &&
          ['dispatching', 'running'].includes(row.status) &&
          input?.afterSeq === '0' &&
          input.waitMs === 180000 &&
          value.selection!.runs.some((run) => run.id === row.runId && run.isActive)
        );
      }),
    'actual parent Tool waits 180000ms while its original Run remains active',
  );
  const parentWait = waiting.selection!.executions.find(
    (row) =>
      row.kind === 'tool' &&
      row.definitionId === 'task.events' &&
      ['dispatching', 'running'].includes(row.status),
  )!;
  assert.equal((parentWait.toolInput as { waitMs: number }).waitMs, 180000);
  console.error(
    'actual_parent_wait',
    JSON.stringify({
      executionId: parentWait.id,
      runId: parentWait.runId,
      status: parentWait.status,
      input: parentWait.toolInput,
    }),
  );
  const environment = page.getByRole('region', { name: '环境信息', exact: true });
  if (!(await environment.isVisible()))
    await page.getByRole('button', { name: '显示环境信息', exact: true }).click();
  const parentContent = () => page.locator('.history-panel .conversation').innerText();
  const content = async () =>
    (await page.locator('.session-tab-child .conversation').count())
      ? page.locator('.session-tab-child .conversation').innerText()
      : parentContent();
  const appended = new Map<string, string[]>();
  const open = async (index: number) => {
    await environment
      .locator(`[data-execution-id="${tasks[index]!.id}"]`)
      .getByRole('button', { name: /^查看子 Agent 详情/ })
      .click();
    await page
      .locator('.session-tab-child')
      .getByRole('region', { name: '子 Agent 详情', exact: true })
      .waitFor();
    assert.equal(
      await page.locator('.session-tab-child .native-child-detail-heading').count(),
      0,
      'child detail has no refresh or read-only notice heading',
    );
    assert.equal(
      await page.getByRole('tab', { name: '新标签页', exact: true }).count(),
      0,
      'child navigation never creates an unrelated empty browser tab',
    );
    assert.equal(
      await page.locator('.conversation').count(),
      2,
      'parent and active child are the only connected conversations',
    );
    const expected = tasks[index]!.prompt;
    const body = await until(
      content,
      (value) => value.includes(`${expected}_INITIAL_TAIL`),
      `exact ${expected} history visible`,
    );
    for (const other of tasks.filter((_, otherIndex) => otherIndex !== index))
      assert.ok(!body.includes(`${other.prompt}_INITIAL_TAIL`), 'another child history is absent');
    for (const marker of appended.get(expected) ?? [])
      assert.ok(body.includes(marker), `retained actual appended tail ${marker}`);
  };
  const close = async (viaSidebar = false) => {
    if (viaSidebar) await page.getByRole('button', { name: 'Stream Parent', exact: true }).click();
    await page.getByRole('button', { name: '收起标签栏', exact: true }).click();
    await until(
      () => page.locator('.session-tab-child').count(),
      (value) => value === 0,
      'child tab reader unmounted',
    );
    assert.equal(
      await page.locator('.conversation').count(),
      1,
      'collapsing the child retains only parent conversation',
    );
    await page.locator('.session-header').getByTitle('Stream Parent', { exact: true }).waitFor();
    await until(
      async () => ({ facts: await state(), body: await content() }),
      ({ facts, body }) => {
        const wait = facts.selection!.executions.find((row) => row.id === parentWait.id);
        const run = facts.selection!.runs.find((row) => row.id === parentWait.runId);
        return wait && ['dispatching', 'running'].includes(wait.status) && run?.isActive
          ? body.includes('PARENT_WAITING')
          : !!run && !run.isActive && body.includes('PARENT_DONE');
      },
      'return restores parent body qualified by its actual original wait and Run state',
    );
    await until(
      () => page.locator('.history-panel .conversation-loading').count(),
      (value) => value === 0,
      'parent history loading ends',
    );
    const draft = page.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
    const original = await promptText(draft);
    const probe = `${original}NAVIGATION_DRAFT_PROBE`;
    await draft.fill(probe);
    await until(
      () => promptText(draft),
      (value) => value === probe,
      'parent composer responds after child return',
    );
    // Exercise the editor's actual delete command. Playwright fill('') emits
    // a synthetic empty insertText which Lexical can restore from its state.
    await draft.press('ControlOrMeta+A');
    await draft.press('Backspace');
    if (original) await draft.fill(original);
    await until(
      () => promptText(draft),
      (value) => value === original,
      'original parent private draft restored',
    );
  };
  phase = 'cold-first-child-held-full-directory';
  const firstCard = environment
    .locator(`[data-execution-id="${tasks[0]!.id}"]`)
    .getByRole('button', { name: /^查看子 Agent 详情/ });
  const firstLabel = await firstCard.getAttribute('aria-label');
  assert.ok(firstLabel?.startsWith('查看子 Agent 详情：'));
  const firstTitle = firstLabel!.slice('查看子 Agent 详情：'.length);
  const beforeColdCalls = (await count()).calls;
  await app.evaluate(() => {
    const host = globalThis as typeof globalThis & {
      coldChildDirectoryGate?: {
        heldFull: number;
        exactQueries: number;
        businessPosts: number;
        status?: number;
        released: boolean;
        release(): void;
      };
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = {
      heldFull: 0,
      exactQueries: 0,
      businessPosts: 0,
      status: undefined as number | undefined,
      released: false,
      release() {
        gate.released = true;
        release();
      },
    };
    host.coldChildDirectoryGate = gate;
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
        if (!gate.released && method === 'POST') gate.businessPosts++;
        const directory = method === 'GET' && url.pathname === '/v1/background-executions';
        if (!gate.released && directory && url.searchParams.has('executionId')) gate.exactQueries++;
        const response = await original(...args);
        if (
          !gate.released &&
          directory &&
          url.searchParams.get('rootSessionId') === 'parent' &&
          !url.searchParams.has('executionId')
        ) {
          gate.heldFull++;
          gate.status = response.status;
          await pending;
        }
        return response;
      },
      { preconnect: original.preconnect },
    );
  });
  try {
    // Ordinary UI has no diagnostic refresh control. Publish a real streamed
    // child update so its public notification starts the full directory read.
    const refreshMarker = `${tasks[0]!.prompt}_COLD_DIRECTORY_REFRESH`;
    const refreshed = await fetch(
      `${control}/step?child=${tasks[0]!.prompt}&marker=${refreshMarker}`,
    );
    assert.equal(refreshed.status, 200);
    appended.set(tasks[0]!.prompt, [refreshMarker]);
    await until(
      () =>
        app.evaluate(() => {
          const gate = (
            globalThis as typeof globalThis & {
              coldChildDirectoryGate?: { heldFull: number; status?: number; released: boolean };
            }
          ).coldChildDirectoryGate;
          return gate && { heldFull: gate.heldFull, status: gate.status, released: gate.released };
        }),
      (gate) => (gate?.heldFull ?? 0) > 0 && gate?.status === 200 && !gate.released,
      'actual same-parent full directory HTTP200 held; exact executionId GETs remain unheld',
    );
    const firstOpenedAt = Date.now();
    await open(0);
    await page.getByRole('tab', { name: firstTitle, exact: true }).waitFor();
    assert.equal(await page.getByRole('tab').count(), 1, 'first child opens only its detail tab');
    const firstOpenMs = Date.now() - firstOpenedAt;
    const active = await state();
    assert.ok(active.selection!.runs.some((run) => run.id === parentWait.runId && run.isActive));
    assert.ok(
      active.selection!.executions.some(
        (row) => row.id === parentWait.id && ['dispatching', 'running'].includes(row.status),
      ),
    );
    assert.equal((await count()).children.length, 2);
    assert.deepEqual(
      (await count()).calls,
      beforeColdCalls,
      'cold readonly child open creates no Model replay',
    );
    const gate = await app.evaluate(() => {
      const value = (
        globalThis as typeof globalThis & {
          coldChildDirectoryGate?: {
            heldFull: number;
            exactQueries: number;
            businessPosts: number;
            status?: number;
            released: boolean;
          };
        }
      ).coldChildDirectoryGate;
      return (
        value && {
          heldFull: value.heldFull,
          exactQueries: value.exactQueries,
          businessPosts: value.businessPosts,
          status: value.status,
          released: value.released,
        }
      );
    });
    assert.equal(gate!.released, false);
    assert.ok(
      gate!.exactQueries > 0,
      'fresh exact carrier query ran while full directory remained held',
    );
    assert.equal(gate!.businessPosts, 0);
    console.log(
      JSON.stringify({
        coldFirstChild: {
          gate,
          firstOpenMs,
          title: firstTitle,
          exactCarrierId: tasks[0]!.id,
          exactChildSessionId: tasks[0]!.childSessionId,
          expectedTail: `${tasks[0]!.prompt}_INITIAL_TAIL`,
          originalWaitStillActive: true,
          activeChildren: 2,
          priorChildOpens: 0,
        },
      }),
    );
  } finally {
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { coldChildDirectoryGate?: { release(): void } }
      ).coldChildDirectoryGate?.release();
    });
  }
  await close();
  phase = 'first-live-child';
  await open(0);
  const first = await until(
    content,
    (value) => value.includes(`${tasks[0]!.prompt}_INITIAL_TAIL`),
    'full >100KiB active prefix rendered automatically',
  );
  const firstChild = first.includes('CHILD_A_INITIAL_TAIL') ? 'CHILD_A' : 'CHILD_B';
  assert.equal(firstChild, tasks[0]!.prompt, 'rendered child matches its exact parent Tool prompt');
  await capture('first');
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
    appended.set(firstChild, [...(appended.get(firstChild) ?? []), marker]);
    liveDelays.push(Date.now() - sent);
    console.error('live_tick', tick, Date.now() - sent, (await state()).environmentRevision);
  }
  await capture('live');
  if (mode === 'capture') {
    const screenshot = join(tmpdir(), 'kite-native-child-stream-after.png');
    await page.screenshot({ path: screenshot });
    console.log(JSON.stringify({ screenshot }));
    await fetch(`${control}/finish`);
  } else {
    await close();
    await open(1);
    await until(
      content,
      (value) =>
        value.includes(`${tasks[1]!.prompt}_INITIAL_TAIL`) &&
        !value.includes(`${firstChild}_INITIAL_TAIL`),
      'second child content isolated',
    );
    const secondChild = tasks[1]!.prompt;
    const secondTail = `${secondChild}_REENTRY_TAIL`;
    await fetch(`${control}/step?child=${secondChild}&marker=${secondTail}`);
    await until(
      content,
      (value) => value.includes(secondTail),
      'second child actual appended tail visible',
    );
    appended.set(secondChild, [secondTail]);
    await close();
    const baselineProviderCalls = (await count()).calls;
    assert.equal(
      baselineProviderCalls.filter((call) => call === 'CHILD_A').length,
      protocol === 'responses' ? 2 : 1,
    );
    assert.equal(
      baselineProviderCalls.filter((call) => call === 'CHILD_B').length,
      protocol === 'responses' ? 2 : 1,
    );
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
    const assertOriginalWaitActive = async () => {
      const facts = await state();
      const wait = facts.selection!.executions.find((row) => row.id === parentWait.id);
      const run = facts.selection!.runs.find((row) => row.id === parentWait.runId);
      assert.ok(wait && ['dispatching', 'running'].includes(wait.status));
      assert.equal((wait.toolInput as { waitMs: number }).waitMs, 180000);
      assert.equal(run?.isActive, true, 'original parent Run still waits for child events');
    };
    await assertOriginalWaitActive();
    for (let index = 0; index < 100; index++) {
      const before = Date.now();
      await open(index % 2);
      await until(
        content,
        (value) => value.includes(`${tasks[index % 2]!.prompt}_INITIAL_TAIL`),
        'exact cached child visible',
      );
      await close();
      switches.push(Date.now() - before);
      if ([19, 59, 99].includes(index)) samples.push(await sample());
    }
    await assertOriginalWaitActive();
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
      parentWait: {
        executionId: parentWait.id,
        runId: parentWait.runId,
        input: parentWait.toolInput,
      },
    };
    console.log(JSON.stringify(report));
    writeFileSync(
      join(tmpdir(), 'kite-native-child-stream-after-markdown-cache-settled.json'),
      JSON.stringify(report, null, 2),
    );
    assert.ok(
      longTasks.length < 10,
      `repeated navigation produced ${longTasks.length} main-thread long tasks`,
    );
    phase = 'held-parent-tool-metadata';
    const toolTarget = spawnTools[0]!;
    assert.equal(toolTarget.status, 'succeeded', 'hold only original successful spawn metadata');
    const beforeToolSelection = (await state()).selection!.viewSelection;
    const beforeToolCalls = (await count()).calls;
    await app.evaluate((_electron, executionId) => {
      const host = globalThis as typeof globalThis & {
        childToolMetadataGate?: {
          held: number;
          status?: number;
          path: string;
          released: boolean;
          release(): void;
        };
      };
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate = {
        held: 0,
        status: undefined as number | undefined,
        path: `/v1/executions/${encodeURIComponent(executionId)}`,
        released: false,
        release() {
          gate.released = true;
          release();
        },
      };
      host.childToolMetadataGate = gate;
      const original = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          const path = new URL(String(args[0])).pathname;
          const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
          const response = await original(...args);
          if (!gate.released && method === 'GET' && path === gate.path) {
            gate.held++;
            gate.status = response.status;
            await pending;
          }
          return response;
        },
        { preconnect: original.preconnect },
      );
    }, toolTarget.id);
    try {
      // Formal readonly reselect creates a new real Main viewSelection. The
      // renderer must reopen auxiliary Tool metadata for that observation scope.
      await page.evaluate(async () => {
        await window.kiteNative!.request({ method: 'select', generation: 1, sessionId: 'parent' });
      });
      const selectedAgain = await until(
        state,
        (value) =>
          value.selection!.viewSelection !== beforeToolSelection &&
          value.selection!.session.id === 'parent' &&
          !value.selection!.viewLoading,
        'readonly same-parent select publishes a new actual viewSelection',
      );
      const metadataGate = await until(
        () =>
          app.evaluate(() => {
            const gate = (
              globalThis as typeof globalThis & {
                childToolMetadataGate?: {
                  held: number;
                  status?: number;
                  path: string;
                  released: boolean;
                };
              }
            ).childToolMetadataGate;
            return (
              gate && {
                held: gate.held,
                status: gate.status,
                path: gate.path,
                released: gate.released,
              }
            );
          }),
        (value) => (value?.held ?? 0) > 0 && value?.status === 200 && !value.released,
        'actual exact successful spawn getExecution HTTP200 response held',
      );
      const active = await state();
      assert.ok(active.selection!.runs.some((run) => run.id === parentWait.runId && run.isActive));
      assert.ok(
        active.selection!.executions.some(
          (row) => row.id === parentWait.id && ['dispatching', 'running'].includes(row.status),
        ),
      );
      assert.equal((await count()).children.length, 2, 'both original child streams remain active');
      await open(0);
      await close(true);
      assert.ok(
        (await content()).includes('PARENT_WAITING'),
        'EOF parent history stays visible while Tool metadata is held',
      );
      await open(0);
      const stillActive = await state();
      assert.ok(
        stillActive.selection!.runs.some((run) => run.id === parentWait.runId && run.isActive),
      );
      assert.ok(
        stillActive.selection!.executions.some(
          (row) => row.id === parentWait.id && ['dispatching', 'running'].includes(row.status),
        ),
      );
      assert.deepEqual(
        (await count()).calls,
        beforeToolCalls,
        'readonly Tool metadata navigation creates no Model replay',
      );
      console.log(
        JSON.stringify({
          heldToolMetadata: {
            metadataGate,
            previousViewSelection: beforeToolSelection,
            actualViewSelection: selectedAgain.selection!.viewSelection,
            originalWaitId: parentWait.id,
            originalWaitStillActive: true,
            exactSpawnToolId: toolTarget.id,
            activeChildren: 2,
            readonlySelect: 1,
            singleSidebarParentReturn: true,
            businessPOST: 0,
          },
        }),
      );
    } finally {
      await app.evaluate(() => {
        (
          globalThis as typeof globalThis & { childToolMetadataGate?: { release(): void } }
        ).childToolMetadataGate?.release();
      });
    }
    await close();
    phase = 'held-parent-metadata-refresh';
    await app.evaluate(() => {
      const host = globalThis as typeof globalThis & {
        navigationRefreshGate?: {
          held: number;
          released: boolean;
          path?: string;
          status?: number;
          release(): void;
        };
      };
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate = {
        renameStarted: false,
        renamePosts: 0,
        held: 0,
        released: false,
        path: undefined as string | undefined,
        status: undefined as number | undefined,
        release() {
          gate.released = true;
          release();
        },
      };
      host.navigationRefreshGate = gate;
      const original = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          const path = new URL(String(args[0])).pathname;
          const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
          if (method === 'POST' && path === '/v1/sessions/parent/rename') {
            gate.renameStarted = true;
            gate.renamePosts++;
          }
          const hold =
            gate.renameStarted &&
            !gate.released &&
            method === 'GET' &&
            path === '/v1/sessions/parent/view';
          if (hold) {
            gate.held++;
            gate.path = path;
          }
          const response = await original(...args);
          if (hold) {
            gate.status = response.status;
            await pending;
          }
          return response;
        },
        { preconnect: original.preconnect },
      );
    });
    try {
      // One owned same-title rename is an explicit persisted fixture mutation.
      // Its persisted input also legitimately wakes task.events; test only after
      // the 100 original-wait navigations, and qualify later parent state afresh.
      await page.evaluate(async () => {
        const facts = await window.kiteNative!.request({
          method: 'session.observe',
          generation: 1,
          sessionId: 'parent',
        });
        if (!facts || !('observationId' in facts))
          throw Error('parent_rename_observation_unavailable');
        const host = window as typeof window & { navigationRefreshResult?: string };
        void window
          .kiteNative!.request({
            method: 'session.rename',
            generation: 1,
            observationId: facts.observationId,
            title: 'Stream Parent',
          })
          .then(() => {
            host.navigationRefreshResult = 'resolved';
          })
          .catch((cause) => {
            host.navigationRefreshResult = String(cause);
          });
      });
      const gate = await until(
        () =>
          app.evaluate(() => {
            const value = (
              globalThis as typeof globalThis & {
                navigationRefreshGate?: {
                  held: number;
                  renamePosts: number;
                  path?: string;
                  status?: number;
                  released: boolean;
                };
              }
            ).navigationRefreshGate;
            return (
              value && {
                held: value.held,
                renamePosts: value.renamePosts,
                path: value.path,
                status: value.status,
                released: value.released,
              }
            );
          }),
        (value) => (value?.held ?? 0) >= 1 && value?.status === 200 && !value.released,
        'actual post-rename parent GET view responses held after HTTP200',
      );
      assert.equal(gate!.renamePosts, 1, 'one isolated same-title metadata POST');
      console.log(JSON.stringify({ heldParentRefreshGate: gate, controlledSameTitleRename: 1 }));
      const refreshing = await until(
        state,
        (value) =>
          value.selection?.viewLoading === true && value.selection.permissionUnavailable === true,
        'Main state remains available with refreshing parent writes unavailable',
      );
      assert.equal(
        refreshing.environmentReadUnavailable,
        false,
        'qualified environment readonly access survives metadata refresh',
      );
      assert.equal(typeof refreshing.selectedEnvironmentRevision, 'number');
      await open(0);
      await close();
      console.log(
        JSON.stringify({
          heldParentRefreshState: {
            viewLoading: refreshing.selection!.viewLoading,
            permissionUnavailable: refreshing.selection!.permissionUnavailable,
            environmentReadUnavailable: refreshing.environmentReadUnavailable,
            selectedEnvironmentRevision: refreshing.selectedEnvironmentRevision,
          },
        }),
      );
      for (const label of ['引导当前轮次', '发送明确的新轮次']) {
        const action = page.getByRole('button', { name: label, exact: true });
        assert.ok(
          (await action.count()) === 0 || !(await action.isEnabled()),
          `${label} is absent or disabled; cached history never grants a write`,
        );
      }
      const permission = page.locator('[data-permission-trigger]');
      assert.ok(
        (await permission.count()) === 0 || !(await permission.isEnabled()),
        'permission writes remain gated',
      );
      await open(0);
      const stillRefreshing = await state();
      assert.equal(stillRefreshing.selection!.viewLoading, true);
      assert.equal(stillRefreshing.selection!.permissionUnavailable, true);
      console.log(
        JSON.stringify({
          heldParentRefresh: {
            gate,
            viewLoading: stillRefreshing.selection!.viewLoading,
            permissionUnavailable: stillRefreshing.selection!.permissionUnavailable,
            environmentReadUnavailable: stillRefreshing.environmentReadUnavailable,
            selectedEnvironmentRevision: stillRefreshing.selectedEnvironmentRevision,
          },
        }),
      );
    } finally {
      await app.evaluate(() => {
        (
          globalThis as typeof globalThis & { navigationRefreshGate?: { release(): void } }
        ).navigationRefreshGate?.release();
      });
    }
    await close();
    await fetch(`${control}/finish`);
    await until(
      state,
      (value) => value.selection!.runs.every((run) => !run.isActive),
      'all real runs settle',
    );
    await until(
      content,
      (value) => value.includes('PARENT_DONE'),
      'parent actually finishes after child release',
    );
    phase = 'completed-child-history-reentry';
    for (let index = 0; index < tasks.length; index++) {
      await open(index);
      const expected = tasks[index]!.prompt;
      await until(
        content,
        (value) => value.includes(`${expected}_DONE`),
        `completed ${expected} history preserves final tail`,
      );
      if (index === 0) await capture('complete');
      await close();
    }
    // Normal child completion may create legitimate parent report turns. Snapshot
    // after settlement; only these later readonly navigations must have zero replay.
    const completedCalls = (await count()).calls;
    for (let index = 0; index < tasks.length; index++) {
      await open(index);
      assert.ok((await content()).includes(`${tasks[index]!.prompt}_DONE`));
      await close();
    }
    assert.deepEqual(
      (await count()).calls,
      completedCalls,
      'completed-history navigation creates no Provider replay',
    );
    for (const child of ['CHILD_A', 'CHILD_B'])
      assert.equal(
        completedCalls.filter((call) => call === child).length,
        protocol === 'responses' ? 2 : 1,
        'each original child Model step executes exactly once',
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
        const node = (document.querySelector('.session-tab-child .conversation') ??
          document.querySelector('.history-panel .conversation')) as unknown as Record<
          string,
          unknown
        >;
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
  await app
    .evaluate(() => {
      (
        globalThis as typeof globalThis & { coldChildDirectoryGate?: { release(): void } }
      ).coldChildDirectoryGate?.release();
    })
    .catch(() => {});
  await app
    .evaluate(() => {
      (
        globalThis as typeof globalThis & { childToolMetadataGate?: { release(): void } }
      ).childToolMetadataGate?.release();
    })
    .catch(() => {});
  await app
    .evaluate(() => {
      (
        globalThis as typeof globalThis & { navigationRefreshGate?: { release(): void } }
      ).navigationRefreshGate?.release();
    })
    .catch(() => {});
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await app.evaluate(({ app }) => app.quit());
  await exited;
}
