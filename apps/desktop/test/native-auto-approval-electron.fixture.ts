import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Execution } from '@kite-ai/client';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [candidate, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const cases = ['approved', 'rejected', 'manual', 'unavailable', 'stopped'] as const;
const records: {
  id: string;
  executionId: string;
  runId: string;
  authorization: Execution['authorization'];
}[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let stopCommandId = '';
let answerPosts = 0,
  coldReads = 0;
try {
  async function launch() {
    app = await _electron.launch({
      executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
      args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
      cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 10000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => console.error('auto_renderer_error', error.message));
    return page;
  }
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, message: string) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const value = await read();
      if (test(value)) return value;
      assert.ok(Date.now() < deadline, message);
      await page.waitForTimeout(20);
    }
  }
  async function select(id: string) {
    console.log(JSON.stringify({ stage: 'select_original', id }));
    await page
      .getByRole('button', { name: `Auto ${id}`, exact: true })
      .and(page.locator('button.session-row'))
      .click();
    await page.locator('.session-header').getByTitle(`Auto ${id}`, { exact: true }).waitFor();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    assert.equal((await state()).selection?.session.id, id);
  }
  async function mode(index: number) {
    await page.locator('[data-permission-trigger]').click();
    await page.getByRole('menuitemradio').nth(index).click();
  }
  async function modeRead(expected: string) {
    await until(
      state,
      (value) => value.selection?.permissions?.mode.mode === expected,
      `original mode ${expected}`,
    );
    assert.equal((await state()).selection?.permissions?.mode.defaultMode, 'auto');
  }
  async function expandRun() {
    const process = page.locator('.agent-turn-summary').first();
    await process.waitFor();
    if ((await process.getAttribute('aria-expanded')) !== 'true') await process.click();
  }
  async function label(text: string) {
    await expandRun();
    await page.locator('.tool-edit-heading').filter({ hasText: text }).first().waitFor();
  }
  await select('approved');
  assert.equal((await state()).selection!.permissions!.trust.trusted, false);
  assert.equal(await page.locator('[data-permission-trigger]').isDisabled(), true);
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await page.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  assert.equal(await page.locator('[data-permission-trigger]').isDisabled(), false);
  await mode(0);
  await modeRead('ask');
  await mode(2);
  const full = page.getByRole('alertdialog');
  await full.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
  await modeRead('ask');
  await mode(2);
  await full.getByRole('button', { name: /^(Enable Full|启用完全权限)$/ }).click();
  await modeRead('full');
  await mode(0);
  await modeRead('ask');
  assert.equal(await (await fetch(`${control}/count`)).text(), '0');
  await app!.evaluate(() => {
    const target = globalThis as typeof globalThis & { autoAnswerPosts: number };
    target.autoAnswerPosts = 0;
    const original = target.fetch;
    target.fetch = Object.assign(
      (...args: Parameters<typeof original>) => {
        if (
          args[1]?.method === 'POST' &&
          /\/interactions\/[^/]+\/answer$/.test(new URL(String(args[0])).pathname)
        )
          target.autoAnswerPosts++;
        return original(...args);
      },
      { preconnect: original.preconnect },
    );
  });
  for (const id of cases) {
    await select(id);
    if (id === 'approved') {
      await mode(1);
      await modeRead('auto');
    } else await modeRead('auto');
    await page
      .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
      .fill(`NATIVE_AUTO_${id.toUpperCase()} original task`);
    await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
    console.log(JSON.stringify({ stage: 'original_input_sent', id }));
    const view = await state();
    console.log(
      JSON.stringify({
        stage: 'original_pending_view',
        id,
        unavailable: view.selection?.permissionUnavailable,
        runs: view.selection?.runs.map((run) => ({ id: run.id, status: run.status })),
        executions: view.selection?.executions.map((execution) => ({
          id: execution.id,
          kind: execution.kind,
          status: execution.status,
          authorization: execution.authorization,
        })),
      }),
    );
    const pending = await until(
      state,
      (value) =>
        value.selection!.executions.some(
          (execution) =>
            execution.kind === 'tool' && execution.authorization?.review?.status === 'running',
        ),
      'exact live authorization review',
    );
    const target = pending.selection!.executions.find(
      (execution) =>
        execution.kind === 'tool' && execution.authorization?.review?.status === 'running',
    )!;
    assert.equal(target.originStoreId, storeId);
    assert.equal(target.sessionId, id);
    assert.equal(target.authorization!.dispatched, false);
    assert.equal(existsSync(join(home, 'workspace', `auto-${id}.txt`)), false);
    console.log(JSON.stringify({ stage: 'original_review_observed', id }));
    await label('正在自动审批');
    if (id === 'stopped') {
      await page.getByRole('button', { name: '停止任务', exact: true }).click();
      await until(
        state,
        (value) =>
          value.selection!.runs.some(
            (run) => run.id === target.runId && !run.isActive && run.status === 'cancelled',
          ),
        'original Run cancelled',
      );
      const stopped = await state();
      const original = stopped.callerSubmissions!.find(
        (row) => row.request.kind === 'command.cancel',
      )!;
      assert.equal(original.scope.storeId, storeId);
      assert.equal(original.scope.sessionId, id);
      stopCommandId = original.request.commandId;
      assert.equal((await fetch(`${control}/release?case=${id}`, { method: 'POST' })).status, 200);
    } else {
      assert.equal((await fetch(`${control}/release?case=${id}`, { method: 'POST' })).status, 200);
      if (id === 'manual' || id === 'unavailable') {
        const waiting = await until(
          state,
          (value) =>
            value.selection!.interactions.some(
              (card) => card.executionId === target.id && card.state === 'pending',
            ),
          'original fallback approval',
        );
        const card = waiting.selection!.interactions.find(
          (card) => card.executionId === target.id && card.state === 'pending',
        )!;
        assert.equal(card.sessionId, id);
        assert.equal(card.originStoreId, storeId);
        assert.equal(existsSync(join(home, 'workspace', `auto-${id}.txt`)), false);
        await label('等待人工审批');
        const reason = waiting.selection!.executions.find(
          (execution) => execution.id === target.id,
        )!.authorization!.review!.reason;
        assert.ok(reason);
        assert.ok(
          (await page
            .locator('.tool-edit-heading')
            .filter({ hasText: '等待人工审批' })
            .first()
            .textContent())!.includes(reason),
        );
        await page.getByRole('button', { name: '仅批准这一次', exact: true }).click();
      }
      await until(
        state,
        (value) =>
          value.selection!.runs.some(
            (run) =>
              run.id === target.runId &&
              !run.isActive &&
              run.status === (id === 'rejected' ? 'cancelled' : 'completed'),
          ),
        'original Run reached its exact terminal status',
      );
    }
    const finished = await state();
    const original = finished.selection!.executions.find(
      (execution) => execution.id === target.id,
    )!;
    assert.equal(original.runId, target.runId);
    if (id === 'approved') await label('已自动批准');
    else if (id === 'rejected') {
      await label('自动审批未通过');
      assert.equal(original.authorization!.dispatched, false);
    } else if (id === 'stopped') {
      await label('自动审批已停止');
      assert.equal(original.authorization!.dispatched, false);
    } else await label('已人工批准');
    const effects = id !== 'rejected' && id !== 'stopped';
    assert.equal(existsSync(join(home, 'workspace', `auto-${id}.txt`)), effects);
    if (effects)
      assert.equal(
        readFileSync(join(home, 'workspace', `auto-${id}.txt`), 'utf8'),
        `Actual ${id} effect\r\n雪🙂`,
      );
    records.push({
      id,
      executionId: target.id,
      runId: target.runId!,
      authorization: original.authorization,
    });
    console.log(
      JSON.stringify({
        stage: 'original_auto_case',
        id,
        status: original.status,
        authorization: original.authorization,
      }),
    );
  }
  answerPosts = await app!.evaluate(
    () => (globalThis as typeof globalThis & { autoAnswerPosts: number }).autoAnswerPosts,
  );
  assert.equal(answerPosts, 2);
  const beforeCold = await (await fetch(`${control}/count`)).text();
  assert.equal(beforeCold, '13');
  await app!.evaluate(({ app }) => app.quit());
  await app!.close();
  app = undefined;
  page = await launch();
  for (const record of records) {
    await select(record.id);
    const original = (await state()).selection!.executions.find(
      (execution) => execution.id === record.executionId,
    )!;
    assert.deepEqual(original.authorization, record.authorization);
    await label(
      record.id === 'approved'
        ? '已自动批准'
        : record.id === 'rejected'
          ? '自动审批未通过'
          : record.id === 'stopped'
            ? '自动审批已停止'
            : '已人工批准',
    );
    coldReads++;
  }
  assert.equal(await (await fetch(`${control}/count`)).text(), beforeCold);
  await app!.evaluate(({ app }) => app.quit());
  await app!.close();
  app = undefined;
  writeFileSync(
    join(home, 'auto-report.json'),
    JSON.stringify({ records, stopCommandId, answerPosts, coldReads }),
  );
  console.log(
    JSON.stringify({
      stage: 'original_auto_cold',
      answerPosts,
      coldReads,
      providerCalls: Number(beforeCold),
    }),
  );
} catch (error) {
  console.error('original_auto_driver_failure', error);
  for (const id of cases)
    await fetch(`${control}/release?case=${id}`, { method: 'POST' }).catch(() => {});
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
}
