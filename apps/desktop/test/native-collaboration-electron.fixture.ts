import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [candidate, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let phase = 'launch',
  frameNumber = 0;
const frames: { file: string; phase: string; at: number }[] = [];
let frameTimer: ReturnType<typeof setInterval> | undefined;
let frameSaving: Promise<void> | undefined;
const frameDirectory = join(home, 'process-frames');
mkdirSync(frameDirectory, { recursive: true });
const log = (stage: string, facts = {}) => {
  phase = stage;
  console.log(JSON.stringify({ stage, ...facts }));
};

async function close() {
  if (!app) return;
  clearInterval(frameTimer);
  await frameSaving;
  writeFileSync(join(frameDirectory, 'manifest.json'), JSON.stringify(frames));
  const owned = app,
    exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
}
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
    frameTimer = setInterval(() => {
      if (frameSaving || frameNumber >= 500) return;
      const samplePhase = phase;
      const file = `${String(frameNumber++).padStart(4, '0')}-${samplePhase}.png`;
      frameSaving = page
        .screenshot({ path: join(frameDirectory, file) })
        .then(() => {
          frames.push({ file, phase: samplePhase, at: Date.now() });
        })
        .catch(() => {})
        .finally(() => {
          frameSaving = undefined;
        });
    }, 150);
    return page;
  }
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string) {
    const end = Date.now() + 15000;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      assert.ok(Date.now() < end, label);
      await page.waitForTimeout(20);
    }
  }
  async function showApproval(id: string) {
    const card = page.getByRole('article', { name: `approval ${id}`, exact: true });
    await until(
      async () => {
        if (await card.isVisible()) return true;
        const next = page.getByRole('button', { name: '下一项审批', exact: true });
        if (await next.count()) await next.click();
        return false;
      },
      Boolean,
      `exact approval ${id} is visible in pager`,
    );
    return card;
  }
  async function select() {
    await page.locator('button.session-row').first().click();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    await until(
      state,
      (value) => value.selection?.session.id === 'collaboration' && !value.selection.viewLoading,
      'selected original root',
    );
  }
  async function mode(index: number, expected: string) {
    await page.locator('[data-permission-trigger]').click();
    await page.getByRole('menuitemradio').nth(index).click();
    if (expected === 'full')
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: /^(Enable Full|启用完全权限)$/ })
        .click();
    await until(
      state,
      (value) => value.selection?.permissions?.mode.mode === expected,
      `current root mode ${expected}`,
    );
  }
  async function send(content: string) {
    await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(content);
    const button = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
    await until(() => button.isEnabled(), Boolean, 'ordinary send enabled');
    await button.click();
  }
  await select();
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await page.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await mode(2, 'full');
  await send('NATIVE_COLLAB_START');
  await until(
    async () => (await (await fetch(`${control}/state`)).json()) as { held: string[] },
    (value) => ['CHILD_A', 'CHILD_B'].every((id) => value.held.includes(id)),
    'both child Models reached their owned hold',
  );
  const created = await until(
    state,
    (value) =>
      value.selection!.executions.filter((row) => !!row.childSessionId).length === 2 &&
      !value.selection!.runs.some((run) => run.isActive),
    'ordinary parent completed while both children live',
  );
  const carriers = created.selection!.executions.filter((row) => !!row.childSessionId);
  const carrier = (prompt: string) =>
    carriers.find((row) =>
      created.selection!.executions.some(
        (tool) =>
          tool.id === row.parentExecutionId &&
          tool.toolInput &&
          typeof tool.toolInput === 'object' &&
          !Array.isArray(tool.toolInput) &&
          tool.toolInput.prompt === prompt,
      ),
    )!;
  const a = carrier('CHILD_A'),
    b = carrier('CHILD_B');
  assert.ok(a && b);
  assert.notEqual(a.childSessionId, b.childSessionId);
  // Tighten within the same accepted children; no child or Run is rebuilt.
  await mode(1, 'auto');
  await fetch(`${control}/release`);
  await until(
    async () =>
      (await (await fetch(`${control}/state`)).json()) as {
        heldChecks: string[];
        titleCalls: number;
      },
    (value) => value.heldChecks.length === 2 && value.titleCalls === 1,
    'both real automatic checks and title model observed',
  );
  await page.getByRole('button', { name: '显示环境信息', exact: true }).click();
  // Native group sections are labelled through aria-label rather than an inferred role.
  const group = page.locator('.background-execution-group[aria-label="子智能体"]');
  await until(
    () => group.locator('li[data-execution-id]').count(),
    (count) => count === 2,
    'exactly two ordinary children while checks run',
  );
  assert.equal(await group.locator('.background-execution-count').textContent(), '2');
  assert.deepEqual(
    (
      await group
        .locator('li[data-execution-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-execution-id')))
    ).sort(),
    [a.id, b.id].sort(),
  );
  assert.equal((await state()).directory!.sessions.length, 1);
  assert.equal((await state()).selection!.session.title, '协作审批测试');
  await page.screenshot({ path: join(home, '00-two-children-checks-title.png') });
  log('two_children_with_checks_title', { childIds: [a.id, b.id], count: 2 });
  await page.getByRole('button', { name: '隐藏环境信息', exact: true }).click();
  await fetch(`${control}/release-checks`);
  const pending = await until(
    state,
    (value) =>
      value.selection!.interactions.filter(
        (card) =>
          card.kind === 'approval' &&
          card.state === 'pending' &&
          [a.childSessionId, b.childSessionId].includes(card.sessionId),
      ).length === 2,
    'both original child actions require accurate human approval',
  );
  const oldA = pending.selection!.interactions.find(
    (card) => card.sessionId === a.childSessionId && card.state === 'pending',
  )!;
  const oldB = pending.selection!.interactions.find(
    (card) => card.sessionId === b.childSessionId && card.state === 'pending',
  )!;
  assert.notEqual(oldA.executionId, oldB.executionId);
  assert.equal(oldA.originStoreId, storeId);
  assert.equal(existsSync(join(home, 'workspace', 'child-a.txt')), false);
  assert.equal(existsSync(join(home, 'workspace', 'child-b.txt')), false);
  await page.screenshot({ path: join(home, '01-dual-child-pending.png') });
  log('dual_child_pending', { a: a.id, b: b.id, aRun: oldA.runId, bRun: oldB.runId });
  await page.getByRole('button', { name: '显示环境信息', exact: true }).click();
  await page
    .locator(`li[data-execution-id="${a.id}"]`)
    .getByRole('button', { name: /^查看子 Agent 详情：/ })
    .click();
  await page
    .locator('.session-tab-child')
    .getByText('等待你的批准', { exact: false })
    .first()
    .waitFor();
  await page.getByRole('button', { name: '收起标签栏', exact: true }).click();
  await page.getByRole('button', { name: '隐藏环境信息', exact: true }).click();
  await (await showApproval(oldA.id))
    .getByRole('button', { name: '更多批准方式', exact: true })
    .click();
  const sessionOption = page.getByRole('menuitem', { name: '本次会话批准', exact: false });
  await sessionOption.waitFor();
  await page.screenshot({ path: join(home, '02-child-session-approval-menu.png') });
  await sessionOption.click();
  log('first_A_answer_clicked');
  const jobPending = await until(
    state,
    (value) =>
      value.selection!.interactions.some(
        (card) =>
          card.sessionId === a.childSessionId &&
          card.definitionId === 'shell.command' &&
          card.state === 'pending',
      ),
    'original A Job requires its separate decision',
  );
  const jobA = jobPending.selection!.interactions.find(
    (card) =>
      card.sessionId === a.childSessionId &&
      card.definitionId === 'shell.command' &&
      card.state === 'pending',
  )!;
  await (await showApproval(jobA.id))
    .getByRole('button', { name: '更多批准方式', exact: true })
    .click();
  await page.getByRole('menuitem', { name: '本次会话批准', exact: false }).click();
  log('first_A_job_answer_clicked', { interactionId: jobA.id });
  await until(
    async () => existsSync(join(home, 'workspace', 'child-a.txt')),
    Boolean,
    'only approved A effect',
  );
  assert.equal(
    readFileSync(join(home, 'workspace', 'child-a.txt'), 'utf8'),
    'A original approved\n',
  );
  assert.equal(existsSync(join(home, 'workspace', 'child-b.txt')), false);
  await until(
    state,
    (value) =>
      value.selection!.executions.some((row) => row.id === a.id && row.status === 'succeeded') &&
      !value.selection!.runs.some((run) => run.isActive),
    'A settled and its result parent turn completed',
  );
  const approved = await state();
  for (const original of [oldA, jobA]) {
    const submitted = approved.interactionSubmissions.find(
      (entry) => entry.interaction.id === original.id,
    )!;
    assert.equal(submitted.interaction.sessionId, a.childSessionId);
    assert.equal((submitted.intent.answer as { grant?: string }).grant, 'same_command');
    assert.equal(submitted.phase, 'accepted');
  }
  assert.equal(
    approved.selection!.interactions.find((card) => card.id === oldB.id)!.state,
    'pending',
  );
  assert.equal(
    approved.selection!.interactions.filter((card) => card.sessionId === a.childSessionId).length,
    0,
  );
  assert.equal(
    readFileSync(join(home, 'workspace', 'session-command.txt'), 'utf8'),
    'approved\napproved\n',
  );
  await showApproval(oldB.id);
  await page.screenshot({ path: join(home, '03-a-completed-b-pending.png') });
  log('same_command_child_scope', {
    sessionId: a.childSessionId,
    siblingSessionId: b.childSessionId,
    grant: 'same_command',
    effects: 2,
  });
  await fetch(`${control}/follow?agent=${encodeURIComponent(a.childSessionId!)}`);
  // Continue this work with new instructions while B retains its original work ownership.
  await send('Follow up: NATIVE_COLLAB_FOLLOW');
  const followPending = await until(
    state,
    (value) =>
      value.selection!.interactions.some(
        (card) =>
          card.sessionId === a.childSessionId && card.state === 'pending' && card.id !== oldA.id,
      ),
    'same stable A Session follow-up has a new exact approval',
  );
  const newA = followPending.selection!.interactions.find(
    (card) =>
      card.sessionId === a.childSessionId && card.state === 'pending' && card.id !== oldA.id,
  )!;
  assert.notEqual(newA.runId, oldA.runId);
  assert.notEqual(newA.executionId, oldA.executionId);
  const nextCarrier = followPending.selection!.executions.find(
    (row) => row.childSessionId === a.childSessionId && row.id !== a.id,
  )!;
  assert.ok(nextCarrier);
  assert.equal(nextCarrier.childSessionId, a.childSessionId);
  // A late old-card answer is submitted through the same real renderer bridge; it cannot authorize A2.
  const lateA = await page.evaluate(
    async ({ id, revision }) => {
      try {
        return await window.kiteNative!.request({
          method: 'interaction.answer',
          generation: 1,
          interactionId: id,
          revision,
          answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
        });
      } catch (error) {
        return { code: (error as { code?: string }).code ?? (error as Error).message };
      }
    },
    { id: oldA.id, revision: oldA.revision },
  );
  assert.equal(existsSync(join(home, 'workspace', 'child-a-follow.txt')), false);
  assert.equal(
    (await state()).selection!.interactions.find((card) => card.id === newA.id)!.state,
    'pending',
  );
  const oldStop = await page.evaluate(async (executionId) => {
    const readId = 'completed-original-A';
    try {
      const opened = (await window.kiteNative!.request({
        method: 'background.open',
        generation: 1,
        readId,
      })) as { observationId: number };
      try {
        return await window.kiteNative!.request({
          method: 'background.stop',
          generation: 1,
          observationId: opened.observationId,
          executionId,
          commandId: 'stop-original-A-after-followup',
        });
      } catch (error) {
        return { code: (error as { code?: string }).code ?? (error as Error).message };
      }
    } finally {
      await window.kiteNative!.request({ method: 'background.close', generation: 1, readId });
    }
  }, a.id);
  assert.equal((oldStop as { code?: string }).code, 'background_stop_unavailable');
  const afterOldStop = await state();
  assert.equal(
    afterOldStop.selection!.interactions.find((card) => card.id === newA.id)!.state,
    'pending',
  );
  assert.equal(
    afterOldStop.selection!.executions.find((row) => row.id === nextCarrier.id)!.cancelRequestedAt,
    null,
  );
  log('same_session_followup_old_answer_isolated', {
    first: a.id,
    next: nextCarrier.id,
    oldRun: oldA.runId,
    newRun: newA.runId,
    lateA,
    oldStop,
  });
  await (await showApproval(newA.id))
    .getByRole('button', { name: '批准一次', exact: true })
    .click();
  await until(
    async () => existsSync(join(home, 'workspace', 'child-a-follow.txt')),
    Boolean,
    'new precise A approval effect',
  );
  assert.equal(
    readFileSync(join(home, 'workspace', 'child-a-follow.txt'), 'utf8'),
    'A follow-up approved\n',
  );
  assert.equal(existsSync(join(home, 'workspace', 'child-b.txt')), false);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const overview = page.getByRole('region', { name: '后台总览', exact: true });
  await overview.getByRole('button', { name: '打开后台总览', exact: true }).click();
  const bCard = overview.getByRole('article', { name: `后台执行 · ${b.id}`, exact: true });
  await bCard.getByRole('button', { name: `停止后台执行 · ${b.id}`, exact: true }).click();
  await until(
    state,
    (value) =>
      value.selection!.interactions.find((card) => card.id === oldB.id)?.state !== 'pending',
    'B original pending card revoked by exact stop',
  );
  const lateB = await page.evaluate(
    async ({ id, revision }) => {
      try {
        return await window.kiteNative!.request({
          method: 'interaction.answer',
          generation: 1,
          interactionId: id,
          revision,
          answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
        });
      } catch (error) {
        return { code: (error as { code?: string }).code ?? (error as Error).message };
      }
    },
    { id: oldB.id, revision: oldB.revision },
  );
  assert.equal(existsSync(join(home, 'workspace', 'child-b.txt')), false);
  await until(
    state,
    (value) =>
      value
        .selection!.executions.filter((row) => !!row.childSessionId)
        .every((row) => ['succeeded', 'failed', 'cancelled'].includes(row.status)) &&
      !value.selection!.runs.some((run) => run.isActive),
    'all exact child carriers and result turns settled',
  );
  const final = await state();
  assert.equal(final.selection!.executions.find((row) => row.id === a.id)!.cancelRequestedAt, null);
  assert.equal(
    final.selection!.executions.find((row) => row.id === nextCarrier.id)!.cancelRequestedAt,
    null,
  );
  assert.notEqual(
    final.selection!.executions.find((row) => row.id === b.id)!.cancelRequestedAt,
    null,
  );
  const beforeCold = (await (await fetch(`${control}/state`)).json()) as { calls: number };
  await close();
  page = await launch();
  await select();
  const cold = await state();
  const coldTasks = cold.selection!.executions.filter(
    (row) =>
      row.childSessionId &&
      row.definitionId === 'agent/worker' &&
      cold.selection!.executions.some(
        (parent) =>
          parent.id === row.parentExecutionId &&
          ['task.spawn', 'task.follow_up'].includes(parent.definitionId ?? ''),
      ),
  );
  assert.deepEqual(coldTasks.map((row) => row.id).sort(), [a.id, b.id, nextCarrier.id].sort());
  assert.equal(existsSync(join(home, 'workspace', 'child-b.txt')), false);
  assert.equal(
    ((await (await fetch(`${control}/state`)).json()) as { calls: number }).calls,
    beforeCold.calls,
  );
  assert.equal(
    readFileSync(join(home, 'workspace', 'session-command.txt'), 'utf8'),
    'approved\napproved\n',
  );
  await page.screenshot({ path: join(home, '04-cold-reopened.png') });
  const report = {
    storeId,
    a: a.id,
    b: b.id,
    next: nextCarrier.id,
    agentId: a.childSessionId,
    oldRun: oldA.runId,
    nextRun: newA.runId,
    lateA,
    oldStop,
    lateB,
    calls: beforeCold.calls,
    coldZeroReplay: true,
  };
  writeFileSync(join(home, 'collaboration-report.json'), JSON.stringify(report));
  log('six_tool_native_collaboration_complete', report);
  await close();
} catch (error) {
  console.error(error);
  if (app)
    try {
      const page = await app.firstWindow();
      console.error(
        JSON.stringify({
          stage: 'collaboration_failure_state',
          text: (await page.locator('body').innerText()).slice(-10000),
          state: await page.evaluate(
            async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
          ),
        }),
      );
    } catch {}
  throw error;
} finally {
  await close();
}
