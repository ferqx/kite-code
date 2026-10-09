import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
type FixtureGlobals = typeof globalThis & { mcpPhysical: Physical[] };
const [candidate, home, control, storeId] = process.argv.slice(2) as string[];
const started = Date.now(),
  pids: number[] = [],
  submissions: NativeMcpSubmission[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
const stage = (name: string, facts = {}) =>
  console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts }));
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
  await page.getByRole('button', { name: 'MCP Window', exact: true }).waitFor();
  await openSessionTools(page);
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
    t.mcpPhysical = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        t.mcpPhysical.push({ path: url.pathname, method: args[1]?.method ?? 'GET' });
        return original(...args);
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
  stage('owned_service_dead', { childPid });
  childPid = undefined;
}
try {
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function select() {
    await closeSettings(page);
    await page.getByRole('button', { name: 'MCP Window', exact: true }).click();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    assert.equal((await state()).selection?.storeId, storeId);
  }
  await select();
  await page
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await page.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await page.getByRole('radio', { name: 'Ask', exact: true }).check();
  await page.getByRole('button', { name: '保存模式选择', exact: true }).click();
  await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
  await openSettings(page);
  await page.getByRole('button', { name: '提供商', exact: true }).click();
  await page.getByRole('button', { name: '配置 OpenAI-compatible', exact: true }).click();
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${control}/model/v1`);
  await page.getByRole('combobox', { name: '凭据处理', exact: true }).selectOption('none');
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('owned-mcp-model');
  await page.getByRole('button', { name: '保存提供商配置', exact: true }).click();
  await page
    .getByRole('region', { name: '提供商设置', exact: true })
    .getByText('已保存提供商配置。', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '关闭提供商配置', exact: true }).click();
  const model = JSON.parse(
    readFileSync(join(home!, '.kite-code/unified-agent/default/config.jsonc'), 'utf8'),
  ).models.find((value: { model: string }) => value.model === 'owned-mcp-model');
  assert.ok(model);
  await openSettings(page);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '读取用户模型配置', exact: true }).click();
  await page.getByRole('button', { name: `启用模型 ${model.id}`, exact: true }).click();
  await page.getByRole('button', { name: `禁用模型 ${model.id}`, exact: true }).waitFor();
  await page.getByRole('button', { name: `设为默认 ${model.id}`, exact: true }).click();
  await openSettings(page);
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  const panel = () => page.getByRole('region', { name: 'MCP settings', exact: true });
  await panel().getByRole('heading', { name: 'Safe directory', exact: true }).waitFor();
  async function refresh() {
    await openSettings(page);
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await panel().getByRole('button', { name: 'Refresh MCP settings', exact: true }).click();
    await panel().getByRole('heading', { name: 'Safe directory', exact: true }).waitFor();
  }
  async function settle(actionId: string, decision?: 'approved' | 'bind' | 'revoke') {
    const deadline = Date.now() + 20000;
    let original: NativeMcpSubmission | undefined;
    for (;;) {
      const facts = await state();
      original = facts.mcpSubmissions
        ?.filter(
          (value) =>
            value.actionId === actionId &&
            !submissions.some((old) => old.commandId === value.commandId),
        )
        .at(-1);
      for (const card of facts.selection?.interactions ?? []) {
        if (card.state !== 'pending') continue;
        if (card.kind === 'question' && decision) {
          await closeSettings(page);
          const review = page.getByRole('region', { name: 'MCP Source Review', exact: true });
          await review.waitFor();
          await review.getByRole('button', { name: decision, exact: true }).click();
          stage('exact_source_review', {
            definitionId: card.definitionId,
            revision: card.revision,
            decision,
          });
        } else if (card.kind === 'approval') {
          await closeSettings(page);
          const approval = page.getByRole('article', { name: `approval ${card.id}`, exact: true });
          await approval.waitFor();
          if (await approval.count()) {
            assert.equal(
              await approval.getByRole('button', { name: '仅批准这一次', exact: true }).count(),
              1,
            );
            await approval.getByRole('button', { name: '仅批准这一次', exact: true }).click();
            stage('independent_job_approval', {
              definitionId: card.definitionId,
              revision: card.revision,
            });
          }
        } else continue;
        await openSettings(page);
        await page.getByRole('button', { name: 'MCP', exact: true }).click();
        await panel().getByRole('heading', { name: 'Safe directory', exact: true }).waitFor();
      }
      if (original && !['submitting', 'pending', 'outcome_unknown'].includes(original.phase)) {
        submissions.push(original);
        stage('original_result', {
          actionId,
          commandId: original.commandId,
          phase: original.phase,
          error: original.error,
          fact: original.fact,
        });
        assert.equal(original.phase, 'completed', JSON.stringify(original));
        return original;
      }
      if (original) {
        const check = panel().getByRole('button', {
          name: `Check original ${original.commandId}`,
          exact: true,
        });
        if ((await check.count()) && (await check.isEnabled())) await check.click();
      }
      assert.ok(
        Date.now() < deadline,
        `original not settled: ${JSON.stringify({ actionId, original, interactions: facts.selection?.interactions })}`,
      );
      await page.waitForTimeout(80);
    }
  }
  async function confirm() {
    await panel().getByRole('button', { name: 'Confirm exact MCP operation', exact: true }).click();
  }
  async function add(
    name: string,
    scope: 'user' | 'workspace',
    transport: 'http' | 'stdio',
    address: string,
  ) {
    await refresh();
    const form = panel().getByRole('form', { name: 'Add MCP source', exact: true });
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await form.getByRole('combobox', { name: 'Scope', exact: true }).selectOption(scope);
    await form.getByRole('combobox', { name: 'Transport', exact: true }).selectOption(transport);
    await form.getByRole('textbox', { name: 'URL or command', exact: true }).fill(address);
    await form.getByRole('button', { name: 'Review add source', exact: true }).click();
    await confirm();
    await settle('mcp.source.add');
    await refresh();
    const source = panel()
      .getByRole('region', { name: 'MCP sources', exact: true })
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: new RegExp(`^${name} · mcp-`) }) });
    const text = await source.innerText();
    const id = text.match(/mcp-[a-f0-9]{64}/)?.[0];
    assert.ok(id);
    return id;
  }
  async function selectServer(id: string, scope: 'user' | 'workspace') {
    await refresh();
    await panel()
      .getByRole('button', { name: `Select ${scope} ${id}: enable`, exact: true })
      .click();
    await confirm();
    await settle('mcp.server.select');
  }
  const manual = panel()
    .getByRole('region', { name: 'MCP sources', exact: true })
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: /^window-manual · mcp-/ }) });
  const manualId = (await manual.innerText()).match(/mcp-[a-f0-9]{64}/)?.[0];
  assert.ok(manualId);
  const beforeBinding = Number(await (await fetch(`${control}/count`)).text());
  for (const decision of ['bind', 'revoke'] as const) {
    await refresh();
    await panel()
      .getByRole('textbox', { name: 'Binding expiry (Unix milliseconds)', exact: true })
      .fill(String(Date.now() + 3600000));
    await panel()
      .getByRole('button', { name: `Review existing credential binding ${manualId}`, exact: true })
      .click();
    await confirm();
    const bound = await settle('mcp.credential.bind', decision);
    const execution = (await state()).selection?.executions.find(
      (value) => value.id === bound.executionId,
    );
    assert.equal(execution?.status, 'succeeded');
    const details = (
      execution?.result as {
        details?: {
          decision?: string;
          credentialLookupAttempted?: boolean;
          connectionAttempted?: boolean;
        };
      }
    )?.details;
    assert.equal(details?.decision, decision);
    assert.equal(details?.credentialLookupAttempted, false);
    assert.equal(details?.connectionAttempted, false);
  }
  assert.equal(Number(await (await fetch(`${control}/count`)).text()), beforeBinding);
  stage('existing_default_os_credential_binding', {
    decisions: ['bind', 'revoke'],
    transportCalls: 0,
  });
  const stdioId = await add('window-stdio', 'user', 'stdio', join(home!, 'mcp-stdio'));
  await selectServer(stdioId, 'user');
  await refresh();
  await panel()
    .getByRole('button', { name: `Connect ${stdioId}`, exact: true })
    .click();
  const connected = await settle('mcp.connect');
  assert.ok(connected.fact && 'ready' in connected.fact && connected.fact.ready);
  await refresh();
  const beforeDescriptorWire = readFileSync(join(home!, 'stdio-wire.jsonl'), 'utf8');
  const open = panel()
    .getByRole('button', { name: /^Open tools / })
    .first();
  await open.click();
  await panel().getByRole('button', { name: 'Read full descriptor 0', exact: true }).click();
  const full = panel().locator('[data-mcp-descriptor="verified"]');
  await full.waitFor();
  const descriptor = await full.innerText();
  assert.ok(new TextEncoder().encode(descriptor).length > 65536);
  assert.ok(descriptor.includes('UNICODE_FULL_TAIL'));
  assert.equal(readFileSync(join(home!, 'stdio-effects'), 'utf8'), '');
  assert.equal(readFileSync(join(home!, 'stdio-wire.jsonl'), 'utf8'), beforeDescriptorWire);
  stage('full_descriptor', {
    bytes: new TextEncoder().encode(descriptor).length,
    additionalRpc: 0,
  });
  await panel()
    .getByRole('button', { name: `Refresh catalogue from ${connected.commandId}`, exact: true })
    .click();
  await settle('mcp.catalogue.refresh');
  await refresh();
  await panel()
    .getByRole('button', { name: `Strong reconnect from ${connected.commandId}`, exact: true })
    .click();
  await confirm();
  const replacement = await settle('mcp.reconnect');
  assert.ok(
    replacement.fact && 'oldStop' in replacement.fact && replacement.fact.oldStop.confirmed,
  );
  stage('strong_reconnect', { commandId: replacement.commandId });
  await closeSettings(page);
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('NATIVE_MCP_OWNED_EFFECT');
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  const toolDeadline = Date.now() + 25000;
  let ordinaryToolApproval = false;
  for (;;) {
    const observed = await state();
    for (const card of observed.selection?.interactions ?? []) {
      if (card.state !== 'pending' || card.kind !== 'approval') continue;
      assert.notEqual(card.definitionId, 'builtin.mcp.sources/mcp.source.approve');
      const approval = page.getByRole('article', { name: `approval ${card.id}`, exact: true });
      if (await approval.count()) {
        ordinaryToolApproval = true;
        await approval.getByRole('button', { name: '仅批准这一次', exact: true }).click();
        stage('independent_remote_tool_approval', {
          definitionId: card.definitionId,
          revision: card.revision,
        });
      }
    }
    const run = observed.selection?.runs.find((value) => value.status === 'completed');
    if (run) {
      assert.ok(ordinaryToolApproval, 'remote Tool must retain independent Ask');
      break;
    }
    assert.ok(Date.now() < toolDeadline, 'Model remote Tool effect incomplete');
    await page.waitForTimeout(80);
  }
  assert.equal(readFileSync(join(home!, 'stdio-effects'), 'utf8').trim().split('\n').length, 1);
  stage('one_remote_effect');
  const projectId = await add('window-project', 'workspace', 'http', `${control}/mcp`);
  await refresh();
  await panel()
    .getByRole('button', { name: `Request project approval ${projectId}`, exact: true })
    .click();
  await settle('mcp.source.approve', 'approved');
  await selectServer(projectId, 'workspace');
  await refresh();
  await panel()
    .getByRole('button', { name: `Connect ${projectId}`, exact: true })
    .click();
  await settle('mcp.connect');
  // This controlled HTTP peer uses the baked trusted-loopback test candidate; productionDefaultNetwork is false.
  await refresh();
  await panel()
    .getByRole('button', { name: `Remove exact workspace source ${projectId}`, exact: true })
    .click();
  await panel()
    .getByRole('region', { name: 'Exact source removal preview', exact: true })
    .waitFor();
  await confirm();
  await settle('mcp.source.remove');
  await refresh();
  await panel()
    .getByRole('button', { name: `Remove exact user source ${stdioId}`, exact: true })
    .click();
  await panel()
    .getByRole('region', { name: 'Exact source removal preview', exact: true })
    .waitFor();
  await confirm();
  await settle('mcp.source.remove');
  const physical = await app!.evaluate(() => (globalThis as FixtureGlobals).mcpPhysical);
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
  await page.context().tracing.stop({ path: join(home!, 'window-trace.zip') });
  await close();
  page = await launch();
  await select();
  await openSettings(page);
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await panel().getByRole('heading', { name: 'Original submissions', exact: true }).waitFor();
  const before = await app!.evaluate(() => (globalThis as FixtureGlobals).mcpPhysical);
  assert.equal(before.filter((value: Physical) => value.method === 'POST').length, 0);
  const commandId = submissions[0]!.commandId;
  await panel()
    .getByRole('button', { name: `Check original ${commandId}`, exact: true })
    .click();
  const after = await app!.evaluate(() => (globalThis as FixtureGlobals).mcpPhysical);
  assert.equal(after.filter((value: Physical) => value.method === 'POST').length, 0);
  assert.equal(
    after.filter((value: Physical) => value.path === `/v1/commands/${commandId}`).length,
    1,
  );
  await page.context().tracing.stop({ path: join(home!, 'cold-trace.zip') });
  await close();
  writeFileSync(
    join(home!, 'mcp-report.json'),
    JSON.stringify({ pids, submissions, physical, persisted, before, after }),
  );
  stage('complete', { originals: submissions.length, coldGets: 1 });
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
  writeFileSync(join(home!, 'mcp-owned-pids.json'), JSON.stringify(pids));
  if (childPid)
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  if (app) {
    const owned = app;
    const timer = setTimeout(() => owned.process().kill('SIGKILL'), 2000);
    try {
      await owned.close();
    } finally {
      clearTimeout(timer);
    }
  }
}
