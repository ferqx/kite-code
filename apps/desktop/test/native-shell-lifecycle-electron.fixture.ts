import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Execution } from '@kite-ai/client';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

type Output = {
  executionId: string;
  highWaterSeq: string;
  items: {
    stream: string;
    content: string;
    seq: string;
    throughSeq: string;
    droppedBytes: string | null;
  }[];
};
type Snapshot = {
  storeId: string;
  cursor: string;
  runs: { id: string; status: string }[];
  executions: (Execution & { input: { command?: string }; originCommandId: string })[];
  jobs: Output[];
};
type Physical = {
  method: string;
  path: string;
  body?: string;
  bytes?: number;
  highWaterSeq?: string;
};
type FixtureGlobals = typeof globalThis & { shellPhysical: Physical[] };
const [candidate, home, storeId, control, launcher] = process.argv.slice(2) as string[],
  started = Date.now(),
  servicePids: number[] = [],
  mainPids: number[] = [],
  physical: Physical[] = [],
  coldPhysical: Physical[] = [],
  jobs: { label: string; id: string; originCommandId: string; runId: string | null }[] = [];
const completeOutput = '默认后台输出🙂漢字𠮷\n'.repeat(6000);
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined,
  page!: Awaited<ReturnType<NonNullable<typeof app>['firstWindow']>>,
  servicePid!: number;
const stage = (name: string, facts = {}) => {
  const value = { stage: name, elapsedMs: Date.now() - started, ...facts };
  appendFileSync(join(home!, 'shell-lifecycle-stages.log'), `${JSON.stringify(value)}\n`);
  console.log(JSON.stringify(value));
};
async function read<T>(operation: string, query: Record<string, string> = {}) {
  const response = await fetch(`${control}/control/${operation}?${new URLSearchParams(query)}`, {
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value as T;
}
async function until<T>(readValue: () => Promise<T>, ok: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await readValue();
    if (ok(value)) return value;
    if (Date.now() >= deadline) throw Error(`native_shell_step_timeout:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
const state = () =>
  page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
async function released() {
  const leases = await until(
    () => read<{ outer: boolean; inner: boolean }>('leases'),
    (value) => !value.outer && !value.inner,
    'installed candidate leases released',
  );
  assert.deepEqual(leases, { outer: false, inner: false });
}
async function launch() {
  app = await _electron.launch({
    executablePath: launcher!,
    args: [`--user-data-dir=${join(home!, 'electron-data')}`],
    cwd: home,
    env: { HOME: home!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'Default Host Shell', exact: true }).waitFor();
  await openSessionTools(page);
  const mainPid = app.process().pid!;
  mainPids.push(mainPid);
  servicePid = Number(
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .map((row) => row.trim().split(/\s+/))
      .find(
        (row) =>
          Number(row[1]) === mainPid &&
          row.slice(2).join(' ') === join(candidate!, 'terminal/runtime/bun'),
      )?.[0],
  );
  assert.ok(servicePid > 0);
  servicePids.push(servicePid);
  const main = await read<{ parent: number }>('process', { pid: String(mainPid) }),
    service = await read<{ parent: number }>('process', { pid: String(servicePid) });
  assert.equal(service.parent, mainPid);
  assert.equal(main.parent, process.pid);
  assert.deepEqual(await read('leases'), { outer: true, inner: true });
  await read('uninstall-busy');
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  assert.deepEqual(
    await app
      .evaluate(({ app, BrowserWindow }) => ({
        noSandbox: app.commandLine.hasSwitch('no-sandbox'),
        appPath: app.getAppPath(),
        preferences: (
          BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
            getLastWebPreferences(): {
              sandbox?: boolean;
              contextIsolation?: boolean;
              nodeIntegration?: boolean;
            };
          }
        ).getLastWebPreferences(),
      }))
      .then((value) => ({
        noSandbox: value.noSandbox,
        appPath: value.appPath,
        sandbox: value.preferences.sandbox,
        contextIsolation: value.preferences.contextIsolation,
        nodeIntegration: value.preferences.nodeIntegration,
      })),
    {
      noSandbox: false,
      appPath: join(candidate!, 'app'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  );
  await app.evaluate(() => {
    const global = globalThis as FixtureGlobals;
    global.shellPhysical = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0])),
          row: Physical = {
            method: args[1]?.method ?? 'GET',
            path: url.pathname,
            ...(typeof args[1]?.body === 'string' ? { body: args[1].body } : {}),
          };
        global.shellPhysical.push(row);
        const response = await original(...args);
        if (response.ok && url.pathname.endsWith('/output')) {
          const text = await response.clone().text(),
            value = JSON.parse(text);
          row.bytes = Buffer.byteLength(text);
          row.highWaterSeq = value.highWaterSeq;
        }
        return response;
      },
      { preconnect: original.preconnect },
    );
  });
  await page.getByRole('button', { name: 'Default Host Shell', exact: true }).click();
  await page
    .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
    .waitFor();
  const selected = await until(
    state,
    (value) => value.selection?.session.id === 'native-shell' && !value.selection.viewLoading,
    'original session',
  );
  assert.equal(selected.selection!.storeId, storeId);
  stage('default_native_window', { mainPid, servicePid, storeId });
}
async function close() {
  if (!app) return;
  await page
    .context()
    .tracing.stop({ path: join(home!, `shell-window-${servicePids.length}.zip`) });
  const owned = app,
    pid = owned.process().pid!,
    exited = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exited;
  await read('process-absent', { pid: String(servicePid) });
  await read('process-absent', { pid: String(pid) });
  app = undefined;
  await released();
  stage('ordinary_native_exit', { mainPid: pid, servicePid });
}
async function send(marker: string, count: number) {
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(marker);
  const button = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
  await until(
    () => button.isEnabled(),
    (value) => value,
    'send enabled',
  );
  await button.click();
  await until(
    state,
    (value) => value.selection!.runs.filter((run) => run.status === 'completed').length === count,
    'parent actual completed',
  );
}
const overview = () => page.getByRole('region', { name: '后台总览', exact: true });
const card = (id: string) =>
  overview().getByRole('article', { name: `后台执行 · ${id}`, exact: true });
async function directory() {
  const open = overview().getByRole('button', { name: '打开后台总览', exact: true });
  if (await open.count()) await open.click();
  else await overview().getByRole('button', { name: '刷新后台总览', exact: true }).click();
  await overview()
    .getByText(/^后台目录已完整读取，共 /)
    .waitFor();
  await overview().getByText('正在核对完整后台目录…', { exact: true }).waitFor({ state: 'hidden' });
}
async function fullOutput(output: Output) {
  const panel = card(output.executionId).getByRole('region', {
      name: `Job 已保存输出 · ${output.executionId}`,
      exact: true,
    }),
    open = panel.getByRole('button', { name: '读取完整已保存输出', exact: true });
  if (await open.count()) await open.click();
  else await panel.getByRole('button', { name: '刷新已保存输出', exact: true }).click();
  await panel
    .getByText(`已完整读取截至输出序号 ${output.highWaterSeq} 的已保存内容。`, { exact: true })
    .waitFor();
  await panel.getByRole('status').waitFor({ state: 'hidden' });
  assert.equal(await panel.getByRole('alert').count(), 0);
  const rows = await panel.locator('ol[aria-label="已保存输出记录"] > li').evaluateAll((entries) =>
    entries.map((entry) => ({
      stream: entry.getAttribute('data-stream'),
      content: entry.querySelector('pre')?.textContent,
      seq: entry.querySelector('p')?.textContent,
    })),
  );
  assert.deepEqual(
    rows,
    output.items.map((item) => ({
      stream: item.stream,
      content: item.content,
      seq: `${item.stream} · 输出序号 ${item.seq}`,
    })),
  );
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(
      output.items
        .filter((item) => item.stream === stream)
        .map((item) => item.content)
        .join(''),
      completeOutput,
    );
  }
  assert.ok(
    output.items.every((item) => item.seq === item.throughSeq && item.droppedBytes === '0'),
  );
  stage('complete_original_unicode_output', {
    executionId: output.executionId,
    highWaterSeq: output.highWaterSeq,
    records: rows.length,
  });
}
async function originalJob(label: string) {
  await read('tree', { label });
  const facts = await read<Snapshot>('snapshot'),
    execution = facts.executions.find(
      (entry) =>
        entry.definitionId === 'shell.command' &&
        entry.input.command?.endsWith(`'${label}' '${new URL(control!).port}'`),
    );
  assert.ok(execution);
  assert.equal(execution.originStoreId, storeId);
  assert.equal(execution.sessionId, 'native-shell');
  assert.equal(execution.status, 'running');
  assert.equal(execution.cancelRequestedAt, null);
  jobs.push({
    label,
    id: execution.id,
    originCommandId: execution.originCommandId,
    runId: execution.runId,
  });
  await directory();
  await until(
    async () => card(execution.id).innerText(),
    (text) => text.includes('· running'),
    'actual original running Job',
  );
  const output = await until(
    () => read<Snapshot>('snapshot'),
    (value) =>
      value.jobs
        .find((item) => item.executionId === execution.id)
        ?.items.filter((item) => item.stream === 'stderr')
        .map((item) => item.content)
        .join('') === completeOutput,
    'all producer bytes durably saved',
  );
  await fullOutput(output.jobs.find((item) => item.executionId === execution.id)!);
  return execution;
}
async function currentPhysical(cold = false) {
  const rows = await app!.evaluate(() => (globalThis as FixtureGlobals).shellPhysical);
  (cold ? coldPhysical : physical).push(...rows);
  return rows;
}
async function coldRead(baseline: Snapshot, count: number) {
  await launch();
  await directory();
  for (const output of baseline.jobs) await fullOutput(output);
  const rows = await currentPhysical(true);
  assert.ok(rows.length > 0 && rows.every((row) => row.method === 'GET'));
  assert.equal((await read<{ calls: number }>('count')).calls, count);
  assert.deepEqual(await read('snapshot'), baseline);
  stage('cold_original_read_without_replay', {
    jobs: baseline.jobs.map((job) => job.executionId),
    cursor: baseline.cursor,
    providerCalls: count,
    posts: 0,
  });
}
try {
  assert.ok(completeOutput.length > 65536 && Buffer.byteLength(completeOutput) > 65536);
  await launch();
  const permissions = page.getByRole('region', { name: '权限与工作区信任', exact: true });
  await permissions
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await permissions.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await permissions.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await permissions.getByRole('radio', { name: 'Full', exact: true }).check();
  await permissions.getByRole('button', { name: '保存模式选择', exact: true }).click();
  await permissions.getByText(/^当前模式：full；默认模式：/).waitFor();
  await send('HOST_FIRST', 1);
  const exact = await originalJob('exact'),
    main = await originalJob('main');
  await page
    .getByRole('status', { name: '当前会话后台状态', exact: true })
    .filter({ hasText: /^后台状态：2 项未结束，0 项未知$/ })
    .waitFor();
  const showEnvironment = page.getByRole('button', { name: '显示环境信息', exact: true });
  if (await showEnvironment.isVisible()) await showEnvironment.click();
  await page
    .getByRole('region', { name: '环境信息', exact: true })
    .locator(`[data-execution-id="${exact.id}"]`)
    .getByRole('button', { name: '停止', exact: true })
    .click();
  await until(
    state,
    (value) =>
      value.selection!.executions.some(
        (entry) => entry.id === exact.id && entry.status === 'cancelled',
      ),
    'exact terminal stop',
  );
  const stopped = (await state()).selection!.executions.find((entry) => entry.id === exact.id)!;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(
    (stopped.result as { details?: { processTreeStopped?: boolean } }).details?.processTreeStopped,
    true,
  );
  await read('absent', { label: 'exact' });
  const other = (await state()).selection!.executions.find((entry) => entry.id === main.id)!;
  assert.equal(other.status, 'running');
  assert.equal(other.cancelRequestedAt, null);
  await page
    .getByRole('status', { name: '当前会话后台状态', exact: true })
    .filter({ hasText: /^后台状态：1 项未结束，0 项未知$/ })
    .waitFor();
  await read('tree', { label: 'main' });
  const posts = await currentPhysical();
  const stops = posts.filter(
    (row) =>
      row.method === 'POST' &&
      row.path === '/v1/sessions/native-shell/commands' &&
      row.body?.includes('execution.cancel'),
  );
  assert.equal(stops.length, 1);
  assert.equal(JSON.parse(stops[0]!.body!).executionId, exact.id);
  stage('exact_default_job_stopped_other_job_running', {
    entry: 'retained_environment_card',
    executionId: exact.id,
    result: stopped.result,
    survivingExecutionId: main.id,
    stopPosts: stops.length,
  });
  const mainPid = app!.process().pid!;
  await page.context().tracing.stop({ path: join(home!, 'shell-window-1.zip') });
  const exited = new Promise<void>((resolve) => app!.process().once('exit', () => resolve()));
  await read('signal', { pid: String(mainPid) });
  await exited;
  app = undefined;
  await read('process-absent', { pid: String(mainPid) });
  await read('process-absent', { pid: String(servicePid) });
  await read('absent', { label: 'main' });
  await released();
  const afterMain = await read<Snapshot>('snapshot'),
    afterMainCalls = (await read<{ calls: number }>('count')).calls;
  assert.equal(afterMainCalls, 2);
  stage('main_sigkill_default_service_and_tree_absent', {
    mainPid,
    servicePid,
    originalJobId: main.id,
  });
  await coldRead(afterMain, afterMainCalls);
  await send('HOST_SERVICE', 2);
  const service = await originalJob('service');
  await currentPhysical();
  await read('signal', { pid: String(servicePid) });
  await read('process-absent', { pid: String(servicePid) });
  await read('absent', { label: 'service' });
  assert.equal(app!.windows().length, 1);
  assert.deepEqual(await read('leases'), { outer: true, inner: true });
  await read('uninstall-busy');
  await close();
  const afterService = await read<Snapshot>('snapshot'),
    afterServiceCalls = (await read<{ calls: number }>('count')).calls,
    unconfirmed = afterService.executions.find((entry) => entry.id === service.id)!;
  assert.equal(afterServiceCalls, 4);
  assert.ok(['running', 'dispatching', 'outcome_unknown'].includes(unconfirmed.status));
  assert.notEqual(
    (unconfirmed.result as { details?: { processTreeStopped?: boolean } } | null)?.details
      ?.processTreeStopped,
    true,
  );
  stage('service_sigkill_physical_cleanup_original_result_unconfirmed', {
    servicePid,
    executionId: service.id,
    persistedStatus: unconfirmed.status,
  });
  await coldRead(afterService, afterServiceCalls);
  const finalSnapshot = await read<Snapshot>('snapshot');
  await close();
  const outputPages = [...physical, ...coldPhysical].filter((row) => row.bytes !== undefined);
  assert.ok(outputPages.length > 3);
  assert.ok(outputPages.every((row) => row.bytes! <= 524288));
  writeFileSync(
    join(home!, 'shell-lifecycle-report.json'),
    JSON.stringify({ storeId, mainPids, servicePids, jobs, physical, coldPhysical, finalSnapshot }),
  );
  stage('native_default_shell_lifecycle_passed', { storeId, servicePids, jobs });
} catch (cause) {
  stage('native_default_shell_lifecycle_failed', { cause: String(cause) });
  if (page) await page.screenshot({ path: join(home!, 'shell-failure.png') }).catch(() => {});
  throw cause;
} finally {
  if (app) {
    await close().catch(() => {});
    await app?.close().catch(() => {});
  }
}
