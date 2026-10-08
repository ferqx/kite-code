import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeMcpSubmission, NativeState } from '../src/native-bridge';

async function openSettings(page: import('playwright').Page) {
  if (!(await page.locator('.desktop-settings-dialog').isVisible()))
    await page
      .locator('.session-header')
      .getByRole('button', { name: '设置', exact: true })
      .click();
}
async function closeSettings(page: import('playwright').Page) {
  if (await page.locator('.desktop-settings-dialog').isVisible())
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
}

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

type Physical = { path: string; method: string };
type Globals = typeof globalThis & { mcpBrowserPhysical: Physical[] };
const [candidate, home, control, storeId, serverId] = process.argv.slice(2) as string[];
const started = Date.now(),
  pids: number[] = [],
  submissions: NativeMcpSubmission[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, servicePid: number | undefined;
const stage = (name: string, facts = {}) =>
  console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts }));
async function counts() {
  return (await (await fetch(`${control}/counts`)).json()) as Record<string, number>;
}
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
  await page.getByRole('button', { name: 'MCP Browser', exact: true }).waitFor();
  await openSessionTools(page);
  servicePid = Number(
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
  assert.ok(servicePid);
  pids.push(servicePid);
  stage('owned_service', { servicePid, electronPid: app.process().pid });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await app.evaluate(() => {
    const t = globalThis as Globals;
    t.mcpBrowserPhysical = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        t.mcpBrowserPhysical.push({ path: url.pathname, method: args[1]?.method ?? 'GET' });
        return original(...args);
      },
      { preconnect: original.preconnect },
    );
  });
  await closeSettings(page);
  await page.getByRole('button', { name: 'MCP Browser', exact: true }).click();
  await page
    .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
    .waitFor();
  return page;
}
async function close(trace: string) {
  if (!app) return;
  const owned = app,
    pid = servicePid!;
  await owned
    .windows()[0]!
    .context()
    .tracing.stop({ path: join(home!, trace) });
  const exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  servicePid = undefined;
  assert.throws(() => process.kill(pid, 0));
  stage('owned_service_dead', { servicePid: pid });
}
try {
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  const panel = () => page.getByRole('region', { name: 'MCP settings', exact: true });
  async function settings() {
    await openSettings(page);
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await panel().getByRole('heading', { name: 'Safe directory', exact: true }).waitFor();
  }
  async function refresh() {
    await panel().getByRole('button', { name: 'Refresh MCP settings', exact: true }).click();
    await panel().getByRole('heading', { name: 'Safe directory', exact: true }).waitFor();
  }
  async function settle(
    actionId: string,
    phase: 'completed' | 'cancelled' = 'completed',
    cancelWhenAuthorized = false,
  ) {
    const deadline = Date.now() + 130000;
    let cancelled = false;
    for (;;) {
      const facts = await state();
      const original = facts.mcpSubmissions
        ?.filter(
          (value) =>
            value.actionId === actionId &&
            !submissions.some((old) => old.commandId === value.commandId),
        )
        .at(-1);
      for (const card of facts.selection?.interactions ?? []) {
        if (card.state !== 'pending' || card.kind !== 'approval') continue;
        const approval = page.getByRole('article', { name: `approval ${card.id}`, exact: true });
        if (await approval.count()) {
          await approval.getByRole('button', { name: 'Approve once', exact: true }).click();
          stage('independent_job_approval', {
            definitionId: card.definitionId,
            revision: card.revision,
          });
        }
      }
      if (original && cancelWhenAuthorized && !cancelled && (await counts()).held! > 0) {
        assert.ok(original.executionId);
        await panel()
          .getByRole('button', { name: `Cancel exact original ${original.commandId}`, exact: true })
          .click();
        cancelled = true;
        stage('exact_business_cancel', {
          commandId: original.commandId,
          executionId: original.executionId,
        });
      }
      if (original && !['pending', 'submitting', 'outcome_unknown'].includes(original.phase)) {
        assert.equal(original.phase, phase, JSON.stringify(original));
        submissions.push(original);
        stage('original_result', {
          actionId,
          commandId: original.commandId,
          phase: original.phase,
          fact: original.fact,
        });
        return original;
      }
      if (original) {
        const check = panel().getByRole('button', {
          name: `Check original ${original.commandId}`,
          exact: true,
        });
        if ((await check.count()) && (await check.isEnabled())) await check.click();
      }
      assert.ok(Date.now() < deadline, `original not settled: ${JSON.stringify(original)}`);
      await page.waitForTimeout(100);
    }
  }
  async function auth(label: string, action: string, cancel = false) {
    await refresh();
    await panel()
      .getByRole('button', { name: `${label} ${serverId}`, exact: true })
      .click();
    await panel().getByRole('button', { name: 'Confirm exact MCP operation', exact: true }).click();
    return settle(action, cancel ? 'cancelled' : 'completed', cancel);
  }
  async function presence(expected: boolean) {
    await refresh();
    await panel()
      .getByRole('button', { name: `Read auth status ${serverId}`, exact: true })
      .click();
    await panel()
      .getByText(new RegExp(`"credentialPresent": ${expected}`))
      .waitFor();
  }
  assert.equal((await state()).selection?.storeId, storeId);
  await page
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await page.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await page.getByRole('radio', { name: 'Ask', exact: true }).check();
  await page.getByRole('button', { name: '保存模式选择', exact: true }).click();
  await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
  await settings();
  await panel()
    .getByRole('button', { name: `Select user ${serverId}: enable`, exact: true })
    .click();
  await panel().getByRole('button', { name: 'Confirm exact MCP operation', exact: true }).click();
  await settle('mcp.server.select');
  await presence(false);
  stage('default_browser_login_ready');
  await auth('Login', 'mcp.auth.login');
  await presence(true);
  const first = await counts();
  assert.equal(first.authorize, 1);
  assert.equal(first.codeExchange, 1);
  assert.equal(first.register, 1);
  assert.equal(first.initialize, 0);
  stage('default_browser_pkce_complete', { counts: first, connectionStillIndependent: true });
  await close('browser-login-trace.zip');
  page = await launch();
  await settings();
  const coldBefore = await counts();
  await presence(true);
  assert.deepEqual(await counts(), coldBefore);
  const originalId = submissions.find((value) => value.actionId === 'mcp.auth.login')!.commandId;
  for (const original of submissions) {
    await panel()
      .getByRole('button', { name: `Check original ${original.commandId}`, exact: true })
      .click();
    const deadline = Date.now() + 15000;
    while (
      (await state()).mcpSubmissions?.find((row) => row.commandId === original.commandId)?.phase !==
      'completed'
    ) {
      assert.ok(Date.now() < deadline, 'cold original confirmation incomplete');
      await page.waitForTimeout(80);
    }
  }
  const physical = await app!.evaluate(() => (globalThis as Globals).mcpBrowserPhysical);
  assert.equal(physical.filter((value) => value.method === 'POST').length, 0);
  assert.equal(physical.filter((value) => value.path === `/v1/commands/${originalId}`).length, 1);
  await refresh();
  await panel()
    .getByRole('button', { name: `Connect ${serverId}`, exact: true })
    .click();
  const connection = await settle('mcp.connect');
  assert.ok(connection.fact && 'ready' in connection.fact && connection.fact.ready);
  const afterConnect = await counts();
  assert.equal(afterConnect.authorize, 1);
  assert.equal(afterConnect.register, 1);
  assert.equal(afterConnect.codeExchange, 1);
  assert.equal(afterConnect.initialize, 1);
  assert.equal(afterConnect.list, 1);
  stage('fresh_service_default_vault_resume', {
    counts: afterConnect,
    coldPosts: 0,
    coldOriginalGets: submissions.length - 1,
  });
  await auth('Refresh authentication', 'mcp.auth.refresh');
  const refreshed = await counts();
  assert.equal(refreshed.refresh, 1);
  assert.equal(refreshed.authorize, 1);
  assert.equal(refreshed.register, 1);
  await auth('Clear authentication', 'mcp.auth.clear');
  await presence(false);
  assert.equal((await counts()).revoke, 0);
  stage('local_clear_without_remote_revoke');
  await auth('Login', 'mcp.auth.login');
  await presence(true);
  await auth('Revoke authentication', 'mcp.auth.revoke');
  await presence(false);
  const revoked = await counts();
  assert.equal(revoked.revoke, 1);
  assert.equal(revoked.authorize, 2);
  assert.equal(revoked.codeExchange, 2);
  await fetch(`${control}/hold`, { method: 'POST' });
  await auth('Login', 'mcp.auth.login', true);
  const cancelled = await counts();
  assert.equal(cancelled.held, 1);
  assert.equal(cancelled.codeExchange, 2);
  await presence(false);
  await auth('Clear authentication', 'mcp.auth.clear');
  await presence(false);
  await close('browser-actions-trace.zip');
  page = await launch();
  await settings();
  const absenceBefore = await counts();
  await presence(false);
  assert.deepEqual(await counts(), absenceBefore);
  const persisted = await app!.evaluate((_, home) => {
    const { DatabaseSync } = process.getBuiltinModule(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(
      `${home}/.kite-code/unified-agent/default/desktop-private/data.sqlite`,
      { readOnly: true },
    );
    try {
      return {
        version: db.prepare('PRAGMA user_version').get()!.user_version,
        rows: db.prepare('SELECT command_id,state FROM mcp_intents').all(),
      };
    } finally {
      db.close();
    }
  }, home!);
  assert.equal(persisted.version, 7);
  await close('browser-absence-trace.zip');
  writeFileSync(
    join(home!, 'browser-report.json'),
    JSON.stringify({
      pids,
      submissions,
      first,
      afterConnect,
      refreshed,
      revoked,
      cancelled,
      physical,
      persisted,
    }),
  );
  stage('complete', { counts: await counts(), services: pids.length });
} catch (error) {
  if (app) {
    try {
      const page = app.windows()[0]!;
      writeFileSync(
        join(home!, 'browser-window-failure.txt'),
        await page.locator('body').innerText(),
      );
      await page.screenshot({ path: join(home!, 'browser-window-failure.png'), fullPage: true });
    } catch {}
    try {
      await close('browser-failure-trace.zip');
    } catch {}
  }
  throw error;
} finally {
  writeFileSync(join(home!, 'browser-owned-pids.json'), JSON.stringify(pids));
  if (servicePid)
    try {
      process.kill(servicePid, 'SIGTERM');
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
