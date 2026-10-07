import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

type Physical = {
  path: string;
  method: string;
  query: string;
  body?: string;
  bytes?: number;
  responseStoreId?: string;
  executionOrigins?: { id: string; originStoreId: string }[];
  model?: {
    sessionId: string;
    runId: string;
    executionId: string;
    contentBytes: number;
    complete: boolean;
  };
};
type Globals = typeof globalThis & { backgroundPhysical: Physical[] };
const [candidate, home, originalStoreId, control] = process.argv.slice(2) as string[];
const { unicode } = JSON.parse(readFileSync(join(home!, 'original-background.json'), 'utf8')) as {
  unicode: string;
};
const started = Date.now(),
  pids: number[] = [];
const stage = (name: string, facts = {}) => {
  const line = JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts });
  appendFileSync(join(home!, 'background-stages.log'), `${line}\n`);
  console.log(line);
};
let storeId = originalStoreId!;
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
async function launch() {
  app = await _electron.launch({
    executablePath: join(candidate!, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate!, 'app'), `--user-data-dir=${join(home!, 'electron-data')}`],
    cwd: home,
    env: { HOME: home!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'Original Background', exact: true }).waitFor();
  childPid = Number(
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .map((row) => row.trim().split(/\s+/))
      .find(
        (row) =>
          Number(row[1]) === app!.process().pid &&
          row.slice(2).join(' ') === join(candidate!, 'terminal/runtime/bun'),
      )?.[0],
  );
  assert.ok(childPid);
  pids.push(childPid);
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await app.evaluate(() => {
    const global = globalThis as Globals;
    global.backgroundPhysical = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        const row: Physical = {
          path: url.pathname,
          query: url.search,
          method: args[1]?.method ?? 'GET',
          ...(typeof args[1]?.body === 'string' ? { body: args[1].body } : {}),
        };
        global.backgroundPhysical.push(row);
        const response = await original(...args);
        if (response.ok && /background|messages|model-output/.test(url.pathname)) {
          const text = await response.clone().text();
          row.bytes = Buffer.byteLength(text);
          const value = JSON.parse(text);
          row.responseStoreId = value.storeId;
          if (url.pathname === '/v1/background-executions')
            row.executionOrigins = value.items.map(
              ({ execution }: { execution: { id: string; originStoreId: string } }) => ({
                id: execution.id,
                originStoreId: execution.originStoreId,
              }),
            );
          if (url.pathname.endsWith('/model-output'))
            row.model = {
              sessionId: value.sessionId,
              runId: value.runId,
              executionId: value.executionId,
              contentBytes: Buffer.byteLength(value.output.content),
              complete: value.output.complete,
            };
        }
        return response;
      },
      { preconnect: original.preconnect },
    );
  });
  stage('owned_service', { childPid, electronPid: app.process().pid });
  return page;
}
async function close() {
  if (!app) return;
  const owned = app,
    exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  assert.throws(() => process.kill(childPid!, 0));
  stage('ordinary_exit_service_absent', { childPid });
  childPid = undefined;
}
try {
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, label: string) {
    const end = Date.now() + 20000;
    for (;;) {
      const value = await read();
      if (ok(value)) return value;
      assert.ok(Date.now() < end, label);
      await page.waitForTimeout(30);
    }
  }
  async function select(title: string, id: string) {
    await page.getByRole('button', { name: title, exact: true }).click();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    await until(
      state,
      (value) => value.selection?.session.id === id && !value.selection.viewLoading,
      'original selection',
    );
    assert.equal((await state()).selection?.storeId, storeId);
  }
  async function authorize() {
    const permissions = page.getByRole('region', { name: '权限与工作区信任', exact: true });
    if (!(await permissions.innerText()).includes('信任状态：trusted')) {
      await permissions
        .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
        .check();
      await permissions.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
      await permissions.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
    }
    await permissions.getByRole('radio', { name: 'Full', exact: true }).check();
    await permissions.getByRole('button', { name: '保存模式选择', exact: true }).click();
    await permissions.getByText(/^当前模式：full；默认模式：/).waitFor();
  }
  async function send(content: string) {
    await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(content);
    const button = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
    await until(
      async () => button.isEnabled(),
      (value) => value,
      'send enabled',
    );
    await button.click();
  }
  const overview = () => page.getByRole('region', { name: '后台总览', exact: true });
  const card = (id: string) =>
    overview().getByRole('article', { name: `后台执行 · ${id}`, exact: true });
  const log = (id: string) =>
    card(id).getByRole('region', { name: `子 Agent 完整日志 · ${id}`, exact: true });
  async function fullLog(id: string) {
    await log(id).getByRole('button', { name: '读取完整子日志', exact: true }).click();
    await log(id)
      .getByText(/^已完整读取子会话 /)
      .waitFor();
    const texts = await log(id).locator('article > pre').allTextContents();
    assert.ok(
      texts.includes(unicode),
      'exact complete original Unicode model output, no preview truncation',
    );
    assert.equal(await log(id).getByRole('alert').count(), 0);
  }
  const count = () =>
    fetch(`${control}/count`).then((response) => response.json()) as Promise<{
      count: number;
      held: string[];
    }>;
  await select('Original Background', 'original-root');
  await authorize();
  await send('ORIGINAL_PARENT');
  await until(
    count,
    (value) =>
      ['UNICODE_CHILD', 'STOP_CHILD', 'DETACHED_CHILD'].every((key) => value.held.includes(key)),
    'three default worker child SDKHTTP calls held',
  );
  const originalState = await until(
    state,
    (value) => value.selection!.runs.some((row) => row.status === 'waiting_execution'),
    'original required parent waiting',
  );
  const originalRun = originalState.selection!.runs.find(
    (row) => row.status === 'waiting_execution',
  )!;
  const tasks = originalState.selection!.executions.filter((row) => !!row.childSessionId);
  assert.equal(tasks.length, 3);
  // Task keys and child Session IDs are original durable facts, not manufactured lifecycle rows.
  const taskKeys = tasks.map((row) => ({ id: row.id, childSessionId: row.childSessionId }));
  stage('original_waiting_tasks', {
    runId: originalRun.id,
    status: originalRun.status,
    required: originalRun.waitingForResults,
    taskKeys,
  });
  await fetch(`${control}/release/UNICODE_CHILD`);
  const settled = await until(
    state,
    (value) =>
      value.selection!.executions.some((row) => !!row.childSessionId && row.status === 'succeeded'),
    'one original child settled',
  );
  const completed = settled.selection!.executions.find(
    (row) => !!row.childSessionId && row.status === 'succeeded',
  )!;
  assert.equal(
    settled.selection!.runs.find((row) => row.id === originalRun.id)!.status,
    'waiting_execution',
  );
  const stillRequired = settled.selection!.runs.find(
    (row) => row.id === originalRun.id,
  )!.waitingForResults;
  const stopId = tasks.find(
    (row) => stillRequired?.includes(row.id) && row.id !== completed.id,
  )!.id;
  const detachedId = tasks.find((row) => row.id !== completed.id && row.id !== stopId)!.id;
  await select('Newer Background', 'newer-root');
  await authorize();
  await send('NEWER_PARENT');
  await until(count, (value) => value.held.includes('NEWER_CHILD'), 'newer original task held');
  const newerState = await until(
    state,
    (value) => value.selection!.executions.some((row) => !!row.childSessionId),
    'newer task',
  );
  const newerTask = newerState.selection!.executions.find((row) => !!row.childSessionId)!;
  const beforeReadonly = (await count()).count;
  const readOnlyStart = await app!.evaluate(
    () => (globalThis as Globals).backgroundPhysical.length,
  );
  await overview().getByRole('button', { name: '打开后台总览', exact: true }).click();
  await card(completed.id).waitFor();
  assert.match(await card(completed.id).innerText(), /· succeeded/);
  assert.match(
    await card(stopId).innerText(),
    new RegExp(`原父轮次 ${originalRun.id} · waiting_execution`),
  );
  const savedOutput = card(completed.id).getByRole('region', {
    name: `Job 已保存输出 · ${completed.id}`,
    exact: true,
  });
  await savedOutput.getByRole('button', { name: '读取完整已保存输出', exact: true }).click();
  await savedOutput.getByText('已完整读取截至输出序号 1 的已保存内容。', { exact: true }).waitFor();
  const progressRows = savedOutput.locator('ol[aria-label="已保存输出记录"] > li');
  assert.equal(await progressRows.count(), 1);
  assert.equal(await progressRows.first().getAttribute('data-stream'), 'progress');
  const childProgress = JSON.parse(await progressRows.first().locator('pre').innerText()) as {
    childSessionId: string;
    runId: string;
  };
  assert.equal(childProgress.childSessionId, completed.childSessionId);
  assert.equal(typeof childProgress.runId, 'string');
  assert.equal(await savedOutput.getByRole('alert').count(), 0);
  await savedOutput.getByRole('button', { name: '关闭输出', exact: true }).click();
  await fullLog(completed.id);
  assert.ok(
    (await log(completed.id).innerText()).includes(childProgress.runId),
    'original saved child Run matches complete child log',
  );
  await select('Original Background', 'original-root');
  await select('Newer Background', 'newer-root');
  await card(completed.id).waitFor();
  await log(completed.id).getByRole('button', { name: '关闭子日志', exact: true }).click();
  assert.equal(await log(completed.id).locator('pre').count(), 0);
  await fullLog(completed.id);
  await overview().getByRole('button', { name: '刷新后台总览', exact: true }).click();
  await card(stopId)
    .getByRole('button', { name: `停止后台执行 · ${stopId}`, exact: true })
    .waitFor();
  assert.equal(
    (await count()).count,
    beforeReadonly,
    'directory/full log/refresh create no Provider work',
  );
  const readonlyPhysical = await app!.evaluate(() => (globalThis as Globals).backgroundPhysical);
  assert.ok(
    readonlyPhysical.slice(readOnlyStart).every((row) => row.method === 'GET'),
    'overview, full log, close and refresh are GET-only',
  );
  const beforeStop = readonlyPhysical.length;
  await card(stopId)
    .getByRole('button', { name: `停止后台执行 · ${stopId}`, exact: true })
    .click();
  await overview()
    .getByText(`停止请求已受理：${stopId}；实际执行和清理仍以随后状态为准。`, { exact: true })
    .waitFor();
  await until(
    async () => card(stopId).innerText(),
    (value) => /停止已请求/.test(value),
    'original stop observed',
  );
  assert.match(await card(detachedId).innerText(), /· running/);
  assert.doesNotMatch(await card(detachedId).innerText(), /停止已请求/);
  assert.match(await card(newerTask.id).innerText(), /· running/);
  assert.doesNotMatch(await card(newerTask.id).innerText(), /停止已请求/);
  const stopPhysical = await app!.evaluate(() => (globalThis as Globals).backgroundPhysical);
  const stops = stopPhysical.slice(beforeStop).filter((row) => row.method === 'POST');
  assert.equal(stops.length, 1, 'one physical original stop');
  const stopBody = JSON.parse(stops[0]!.body!);
  assert.ok(JSON.stringify(stopBody).includes(stopId));
  assert.ok(!JSON.stringify(stopBody).includes(newerTask.id));
  assert.ok(stops[0]!.path.includes('original-root'), 'stop targets original actual Session');
  const journal = (await state()).callerSubmissions!;
  const stopJournal = journal.filter(
    (row) => row.target.kind === 'execution' && row.target.id === stopId,
  );
  assert.equal(stopJournal.length, 1, 'original caller stop journal retained');
  assert.equal(stopJournal[0]!.scope.sessionId, 'original-root');
  assert.equal(stopJournal[0]!.scope.storeId, storeId);
  assert.equal(stopJournal[0]!.request.commandId, stopBody.commandId);
  stage('exact_original_stop', { stopId, detachedId, newerId: newerTask.id, stops });
  await fetch(`${control}/release/all`);
  await select('Original Background', 'original-root');
  await until(
    state,
    (value) =>
      value.selection!.runs.find((row) => row.id === originalRun.id)?.status === 'completed',
    'original parent complete after precise stop',
  );
  await select('Newer Background', 'newer-root');
  await until(
    state,
    (value) => !value.selection!.runs.some((row) => row.isActive),
    'newer parent settled',
  );
  await overview().getByRole('button', { name: '刷新后台总览', exact: true }).click();
  await until(
    async () => card(detachedId).innerText(),
    (value) => /· succeeded/.test(value),
    'detached task settled through original provider gate',
  );
  await until(
    async () => card(newerTask.id).innerText(),
    (value) => /· succeeded/.test(value),
    'newer task settled through original provider gate',
  );
  await overview().getByRole('button', { name: '关闭后台总览', exact: true }).click();
  assert.equal(await overview().getByRole('article').count(), 0);
  const physical = await app!.evaluate(() => (globalThis as Globals).backgroundPhysical);
  assert.ok(
    physical
      .slice(physical.map((row) => row.method).lastIndexOf('POST') + 1)
      .every((row) => row.method === 'GET'),
  );
  await page.context().tracing.stop({ path: join(home!, 'window-trace.zip') });
  const originalServicePid = childPid!;
  await close();
  const restoreResponse = await fetch(`${control}/restore?pid=${originalServicePid}`);
  assert.equal(restoreResponse.status, 200, await restoreResponse.clone().text());
  const baseline = (await restoreResponse.json()) as {
    cursor: string;
    calls: number;
    originalStoreId: string;
    restoredStoreId: string;
  };
  assert.equal(baseline.originalStoreId, originalStoreId);
  assert.notEqual(baseline.restoredStoreId, originalStoreId);
  storeId = baseline.restoredStoreId;
  stage('restored_cold_launch', {
    originalStoreId,
    restoredStoreId: storeId,
    cursor: baseline.cursor,
  });
  const callsBeforeCold = (await count()).count;
  assert.equal(baseline.calls, callsBeforeCold);
  page = await launch();
  await select('Newer Background', 'newer-root');
  await overview().getByRole('button', { name: '打开后台总览', exact: true }).click();
  await card(completed.id).waitFor();
  for (const id of [...tasks.map((row) => row.id), newerTask.id]) {
    await card(id).getByText(`原 Store ${originalStoreId}`, { exact: true }).waitFor();
    await card(id).getByText('恢复历史，只读。当前连接已使用新 Store。', { exact: true }).waitFor();
    assert.equal(
      await card(id)
        .getByRole('button', { name: `停止后台执行 · ${id}`, exact: true })
        .count(),
      0,
    );
  }
  const coldJournal = (await state()).callerSubmissions!.filter(
    (row) => row.target.kind === 'execution' && row.target.id === stopId,
  );
  assert.equal(coldJournal.length, 1);
  assert.equal(coldJournal[0]!.scope.storeId, originalStoreId);
  assert.equal(coldJournal[0]!.request.expectedStoreId, originalStoreId);
  assert.equal(coldJournal[0]!.request.commandId, stopBody.commandId);
  const coldSavedOutput = card(completed.id).getByRole('region', {
    name: `Job 已保存输出 · ${completed.id}`,
    exact: true,
  });
  await coldSavedOutput.getByRole('button', { name: '读取完整已保存输出', exact: true }).click();
  await coldSavedOutput
    .getByText('已完整读取截至输出序号 1 的已保存内容。', { exact: true })
    .waitFor();
  const coldProgress = coldSavedOutput.locator('ol[aria-label="已保存输出记录"] > li');
  assert.equal(await coldProgress.count(), 1);
  assert.equal(await coldProgress.first().getAttribute('data-stream'), 'progress');
  assert.deepEqual(
    JSON.parse(await coldProgress.first().locator('pre').innerText()),
    childProgress,
  );
  assert.equal(await coldSavedOutput.getByRole('alert').count(), 0);
  await fullLog(completed.id);
  assert.ok((await log(completed.id).innerText()).includes(childProgress.runId));
  await log(completed.id).getByRole('button', { name: '刷新子日志', exact: true }).click();
  // Refresh preserves the last complete facts while loading; their old heading
  // cannot prove the new physical GET and full transfer have finished.
  await until(
    () => app!.evaluate(() => (globalThis as Globals).backgroundPhysical),
    (rows) => rows.filter((row) => row.model?.runId === childProgress.runId).length >= 2,
    'second complete original child ModelOutput response',
  );
  await log(completed.id)
    .getByText('正在读取完整子会话日志…', { exact: true })
    .waitFor({ state: 'hidden' });
  await log(completed.id)
    .getByText(/^已完整读取子会话 /)
    .waitFor();
  assert.equal(await log(completed.id).getByRole('alert').count(), 0);
  assert.ok((await log(completed.id).locator('article > pre').allTextContents()).includes(unicode));
  await overview().getByRole('button', { name: '刷新后台总览', exact: true }).click();
  await card(completed.id).waitFor();
  const coldPhysical = await app!.evaluate(() => (globalThis as Globals).backgroundPhysical);
  assert.ok(
    coldPhysical.every((row) => row.method === 'GET'),
    JSON.stringify(coldPhysical),
  );
  const coldDirectory = coldPhysical.filter(
    (row) => row.path === '/v1/background-executions' && row.responseStoreId !== undefined,
  );
  assert.ok(coldDirectory.length > 0);
  for (const row of coldDirectory) {
    assert.equal(new URLSearchParams(row.query).get('storeId'), storeId);
    assert.equal(row.responseStoreId, storeId);
    assert.ok(
      row.executionOrigins!.every((execution) => execution.originStoreId === originalStoreId),
    );
  }
  const childModels = coldPhysical.filter(
    (row) => row.path.endsWith('/model-output') && row.model?.runId === childProgress.runId,
  );
  assert.ok(childModels.length >= 2, 'original child full ModelOutput read and refresh');
  for (const row of childModels) {
    assert.equal(new URLSearchParams(row.query).get('storeId'), storeId);
    assert.equal(row.responseStoreId, storeId);
    assert.equal(row.model!.sessionId, completed.childSessionId);
    assert.equal(row.model!.contentBytes, Buffer.byteLength(unicode));
    assert.equal(row.model!.complete, true);
  }
  assert.ok(
    coldPhysical.some((row) => row.path === `/v1/sessions/${completed.childSessionId}/messages`),
  );
  assert.ok(coldPhysical.some((row) => row.path.includes(`/executions/${completed.id}/output`)));
  const coldProviderCalls = (await count()).count;
  assert.equal(coldProviderCalls, callsBeforeCold);
  await page.context().tracing.stop({ path: join(home!, 'cold-trace.zip') });
  await close();
  writeFileSync(
    join(home!, 'background-report.json'),
    JSON.stringify({
      pids,
      originalStoreId,
      restoredStoreId: storeId,
      childSessionId: completed.childSessionId,
      childRunId: childProgress.runId,
      physical,
      coldPhysical,
      callsBeforeCold,
      coldProviderCalls,
      executionIds: [...tasks.map((row) => row.id), newerTask.id],
      stoppedId: stopId,
    }),
  );
  stage('complete', {
    originalStoreId,
    restoredStoreId: storeId,
    childSessionId: completed.childSessionId,
    childRunId: childProgress.runId,
    stoppedId: stopId,
    fullUnicodeBytes: Buffer.byteLength(unicode),
    coldCursor: baseline.cursor,
    pids,
  });
} catch (error) {
  if (app)
    try {
      const page = app.windows()[0]!;
      writeFileSync(join(home!, 'window-failure.txt'), await page.locator('body').innerText());
      writeFileSync(
        join(home!, 'background-failure-physical.json'),
        JSON.stringify(await app.evaluate(() => (globalThis as Globals).backgroundPhysical)),
      );
      await page.screenshot({ path: join(home!, 'window-failure.png'), fullPage: true });
      await page.context().tracing.stop({ path: join(home!, 'window-failure-trace.zip') });
      stage('failure', {
        error: String(error),
        state: await page.evaluate(
          async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
        ),
      });
    } catch {}
  await fetch(`${control}/release/all`).catch(() => {});
  try {
    await close();
  } catch {}
  throw error;
} finally {
  writeFileSync(join(home!, 'background-owned-pids.json'), JSON.stringify(pids));
  if (childPid)
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  if (app) {
    const owned = app,
      timer = setTimeout(() => owned.process().kill('SIGKILL'), 2000);
    try {
      await owned.close();
    } finally {
      clearTimeout(timer);
    }
  }
}
