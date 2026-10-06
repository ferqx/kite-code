import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

type Physical = {
  path: string;
  query: string;
  method: string;
  bytes?: number;
  entries?: number;
  complete?: boolean;
  revision?: string;
  highWaterSeq?: string;
};
type FixtureGlobals = typeof globalThis & { jobPhysical: Physical[] };
const [candidate, home, storeId] = process.argv.slice(2) as string[];
const started = Date.now(),
  pids: number[] = [],
  physical: Physical[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
const stage = (name: string, facts = {}) =>
  console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts }));
const original = JSON.parse(readFileSync(join(home!, 'original-job.json'), 'utf8')) as {
  jobId: string;
  expected: {
    highWaterSeq: string;
    items: {
      stream: string;
      content: string;
      seq: string;
      throughSeq: string;
      droppedBytes: string | null;
    }[];
  };
};
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
  await page.getByRole('button', { name: 'Job Output Window', exact: true }).waitFor();
  childPid = Number(
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .map((value) => value.trim().split(/\s+/))
      .find(
        (value) =>
          Number(value[1]) === app!.process().pid &&
          value.slice(2).join(' ') === join(candidate!, 'terminal/runtime/bun'),
      )?.[0],
  );
  assert.ok(childPid);
  pids.push(childPid);
  stage('owned_service', { childPid, electronPid: app.process().pid });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await app.evaluate(() => {
    const t = globalThis as FixtureGlobals;
    t.jobPhysical = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        const row: Physical = {
          path: url.pathname,
          query: url.search,
          method: args[1]?.method ?? 'GET',
        };
        t.jobPhysical.push(row);
        const response = await original(...args);
        if (/\/output$/.test(url.pathname) && response.ok) {
          const body = await response.clone().text();
          const dto = JSON.parse(body);
          Object.assign(row, {
            bytes: Buffer.byteLength(body),
            entries: dto.items?.length,
            highWaterSeq: dto.highWaterSeq,
            complete: dto.complete,
            revision: dto.revision,
          });
        }
        return response;
      },
      { preconnect: original.preconnect },
    );
  });
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
  const panel = () =>
    page.getByRole('region', { name: `Job 已保存输出 · ${original.jobId}`, exact: true });
  const details = () =>
    page
      .getByRole('region', { name: 'Runtime logs', exact: true })
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: 'shell.command · succeeded' }) });
  async function select(name: string) {
    await page.getByRole('button', { name, exact: true }).click();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    const state = await page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
    assert.equal(state.selection?.storeId, storeId);
  }
  async function open() {
    assert.equal(await details().count(), 1);
    if ((await details().getAttribute('open')) === null) await details().locator('summary').click();
    await panel().getByRole('button', { name: '读取完整已保存输出', exact: true }).click();
    await complete();
  }
  async function complete() {
    await panel()
      .getByText(`已完整读取截至输出序号 ${original.expected.highWaterSeq} 的已保存内容。`, {
        exact: true,
      })
      .waitFor();
    await panel().getByRole('status').waitFor({ state: 'hidden' });
    const records = await panel()
      .locator('ol[aria-label="已保存输出记录"] > li')
      .evaluateAll((items) =>
        items.map((item) => ({
          stream: item.getAttribute('data-stream'),
          content: item.querySelector('pre')?.textContent,
          paragraphs: Array.from(item.querySelectorAll('p'), (paragraph) => paragraph.textContent),
        })),
      );
    const expected = original.expected.items.map((item) => ({
      stream: item.stream,
      content: item.droppedBytes === '0' && item.seq === item.throughSeq ? item.content : undefined,
      paragraphs: [
        `${item.stream} · 输出序号 ${item.seq}${item.seq !== item.throughSeq ? `–${item.throughSeq}` : ''}`,
        ...(item.droppedBytes !== '0' || item.seq !== item.throughSeq
          ? [
              `输出缺口：${item.droppedBytes === null ? '此区间丢失字节数无法确定' : `丢失 ${item.droppedBytes} 字节`}。`,
            ]
          : []),
      ],
    }));
    assert.equal(records.length, expected.length, 'all original output rows');
    for (let index = 0; index < records.length; index++) {
      assert.equal(records[index]!.stream, expected[index]!.stream);
      assert.deepEqual(
        records[index]!.paragraphs,
        expected[index]!.paragraphs,
        `original row ${index} sequence range and exact gap facts`,
      );
      assert.ok(
        records[index]!.content === expected[index]!.content,
        `original row ${index} content`,
      );
    }
    assert.equal(
      await panel()
        .getByText(/输出缺口：/)
        .count(),
      original.expected.items.filter(
        (item) => item.droppedBytes !== '0' || item.seq !== item.throughSeq,
      ).length,
    );
    assert.equal(await panel().getByRole('alert').count(), 0);
  }
  await select('Job Output Window');
  await open();
  const physicalPages = await app!.evaluate(() =>
    (globalThis as FixtureGlobals).jobPhysical.filter(
      (row) => /\/output$/.test(row.path) && row.bytes !== undefined,
    ),
  );
  const first = [
    ...new Map(
      physicalPages.map((row) => [new URLSearchParams(row.query).get('afterSeq') ?? '0', row]),
    ).values(),
  ];
  assert.ok(first.length > 1, JSON.stringify(first));
  assert.equal(
    first.reduce((sum, row) => sum + row.entries!, 0),
    original.expected.items.length,
  );
  assert.equal(new Set(first.map((row) => row.highWaterSeq)).size, 1);
  assert.ok(first.every((row) => row.bytes! <= 524288));
  assert.ok(
    first.some((row) => row.query.includes('afterSeq=') && !row.query.includes('afterSeq=0&')),
  );
  stage('complete_original_job_output', {
    jobId: original.jobId,
    records: original.expected.items.length,
    highWaterSeq: original.expected.highWaterSeq,
    pages: first,
  });
  await panel().getByRole('button', { name: '关闭输出', exact: true }).click();
  assert.equal(await panel().locator('pre').count(), 0);
  await panel().getByRole('button', { name: '读取完整已保存输出', exact: true }).click();
  await complete();
  await details().locator('summary').click();
  await panel().waitFor({ state: 'hidden' });
  await open();
  await select('Second Output Window');
  assert.equal(await panel().count(), 0);
  await select('Job Output Window');
  await open();
  const beforeRefresh = await app!.evaluate(
    () =>
      (globalThis as FixtureGlobals).jobPhysical.filter((row) => /\/output$/.test(row.path)).length,
  );
  await panel().getByRole('button', { name: '刷新已保存输出', exact: true }).click();
  await complete();
  assert.ok(
    (await app!.evaluate(
      () =>
        (globalThis as FixtureGlobals).jobPhysical.filter((row) => /\/output$/.test(row.path))
          .length,
    )) > beforeRefresh,
  );
  stage('close_details_scope_reopen_and_explicit_refresh');
  physical.push(...(await app!.evaluate(() => (globalThis as FixtureGlobals).jobPhysical)));
  assert.ok(
    physical.every((row) => row.method === 'GET'),
    JSON.stringify(physical),
  );
  await page.context().tracing.stop({ path: join(home!, 'window-trace.zip') });
  await close();
  page = await launch();
  await select('Job Output Window');
  await open();
  const coldPhysical = await app!.evaluate(() => (globalThis as FixtureGlobals).jobPhysical);
  assert.ok(
    coldPhysical.every((row) => row.method === 'GET'),
    JSON.stringify(coldPhysical),
  );
  await page.context().tracing.stop({ path: join(home!, 'cold-trace.zip') });
  await close();
  writeFileSync(
    join(home!, 'job-output-report.json'),
    JSON.stringify({
      pids,
      physical,
      coldPhysical,
      bytePages: first.map((row) => ({
        highWaterSeq: row.highWaterSeq,
        items: row.entries,
        bytes: row.bytes,
      })),
    }),
  );
  stage('complete', {
    ordinaryServiceExits: pids.length,
    businessPosts: 0,
    records: original.expected.items.length,
  });
} catch (error) {
  if (app) {
    try {
      const page = app.windows()[0]!;
      writeFileSync(join(home!, 'window-failure.txt'), await page.locator('body').innerText());
      await page.screenshot({ path: join(home!, 'window-failure.png'), fullPage: true });
      await page.context().tracing.stop({ path: join(home!, 'window-failure-trace.zip') });
      stage('failure', {
        error: String(error),
        state: await page.evaluate(
          async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
        ),
      });
    } catch {}
    try {
      await close();
    } catch {}
  }
  throw error;
} finally {
  writeFileSync(join(home!, 'job-output-owned-pids.json'), JSON.stringify(pids));
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
