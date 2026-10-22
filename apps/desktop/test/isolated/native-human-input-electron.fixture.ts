import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';

const [outdir, home, executablePath, control, evidence] = process.argv.slice(2) as string[];
const text = 'Please answer HUMAN INPUT ELECTRON.\n\n> Reference only, not a new instruction.';
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let stage = 'launch';
const facts = async () =>
  (await (await fetch(`${control}/facts`)).json()) as {
    userRows: number;
    rawIds: string[];
    publicIds: string[];
    sessionIds: string[];
    processing: number;
    business: number;
    active: number;
  };
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!(await read())) {
    assert.ok(Date.now() < deadline, `human_input_electron_deadline:${stage}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
async function close() {
  if (!app) return;
  const current = app;
  const process = current.process();
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  await current.evaluate(({ app }) => app.quit());
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('normal_quit_timeout')), 20000).unref(),
    ),
  ]);
  assert.equal(process.exitCode, 0);
  app = undefined;
}
async function launch() {
  app = await _electron.launch({
    executablePath,
    args: [outdir!, `--user-data-dir=${join(home!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: home!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  return page;
}
async function assertOrder(page: import('playwright').Page, inputs: number) {
  await until(
    async () =>
      (await page.getByText(`INTERPRETATION ${inputs} ACCEPTED`, { exact: true }).count()) === 1 &&
      (await page.getByText('HUMAN INPUT BUSINESS FINAL', { exact: true }).count()) === inputs &&
      (await page.locator('.response-status').count()) === 0,
  );
  const order = await page.locator('.message.user,.message.assistant').evaluateAll((messages) =>
    messages.map((message) => ({
      role: message.classList.contains('user') ? 'user' : 'assistant',
      text: message.textContent ?? '',
    })),
  );
  assert.equal(
    order.length,
    inputs * 3,
    'each real input retains its interpretation and business replies',
  );
  for (let index = 0; index < inputs; index++) {
    const offset = index * 3;
    assert.equal(order[offset]!.role, 'user', 'user message precedes its exact interpretation');
    assert.ok(order[offset]!.text.includes('HUMAN INPUT ELECTRON'));
    assert.equal(order[offset + 1]!.role, 'assistant');
    assert.ok(order[offset + 1]!.text.includes(`INTERPRETATION ${index + 1} ACCEPTED`));
    assert.equal(order[offset + 2]!.role, 'assistant');
    assert.ok(order[offset + 2]!.text.includes('HUMAN INPUT BUSINESS FINAL'));
  }
  return order;
}
mkdirSync(evidence!, { recursive: true });
try {
  let page = await launch();
  stage = 'trust';
  await page.getByRole('button', { name: 'Seed session', exact: true }).click();
  await page.getByRole('button', { name: '确认项目读取范围', exact: true }).click();
  await page.getByRole('checkbox', { name: '我已核对所显示的项目及读取范围', exact: true }).check();
  await page.getByRole('button', { name: '允许读取所显示的范围', exact: true }).click();
  await page
    .getByRole('button', { name: '确认项目读取范围', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  stage = 'first_send';
  await page.getByRole('textbox', { name: '新对话草稿', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送首条消息', exact: true }).click();
  await until(async () => {
    const value = await facts();
    return (
      value.processing >= 1 && value.business >= 1 && value.active === 0 && value.userRows === 2
    );
  });
  await until(async () => (await page.locator('.message.user').count()) === 1);
  await until(
    async () =>
      (await page.getByText('HUMAN INPUT BUSINESS FINAL', { exact: true }).count()) === 1 &&
      (await page.locator('.response-status').count()) === 0,
  );
  assert.ok((await page.locator('.message.user').innerText()).includes('HUMAN INPUT ELECTRON'));
  const firstOrder = await assertOrder(page, 1);
  assert.equal((await page.locator('body').innerText()).includes('input_command_id'), false);
  await page.screenshot({ path: join(evidence!, '01-first-input.png') });
  const first = await facts();
  const sessionId = first.sessionIds[0];
  // A true normal-process cold reopen must not need renderer-local suppression state.
  stage = 'cold_reopen';
  await close();
  page = await launch();
  await page.locator('button.session-row').filter({ hasNotText: 'Seed session' }).click();
  await until(async () => (await page.locator('.message.user').count()) === 1);
  const coldOrder = await assertOrder(page, 1);
  assert.deepEqual(coldOrder, firstOrder, 'cold history preserves the same causal message order');
  assert.equal((await page.locator('body').innerText()).includes('input_command_id'), false);
  assert.deepEqual(await facts(), first, 'cold reading does not create another input or Model');
  await page.screenshot({ path: join(evidence!, '02-cold-input.png') });
  stage = 'same_text_independent_input';
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  await until(async () => {
    const value = await facts();
    return (
      value.processing >= 2 && value.business >= 2 && value.active === 0 && value.userRows === 4
    );
  });
  await until(async () => (await page.locator('.message.user').count()) === 2);
  await until(
    async () =>
      (await page.getByText('HUMAN INPUT BUSINESS FINAL', { exact: true }).count()) === 2 &&
      (await page.locator('.response-status').count()) === 0,
  );
  for (const message of await page.locator('.message.user').all())
    assert.ok((await message.innerText()).includes('HUMAN INPUT ELECTRON'));
  const final = await facts();
  assert.equal(new Set(final.rawIds).size, 2);
  assert.equal(new Set(final.publicIds).size, 2);
  assert.equal((await page.locator('body').innerText()).includes('input_command_id'), false);
  const finalOrder = await assertOrder(page, 2);
  await page.screenshot({ path: join(evidence!, '03-distinct-identical-inputs.png') });
  const pid = app!.process().pid!;
  const descendants = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=']))
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([child]) => child!);
  await close();
  for (const child of descendants)
    assert.throws(() => process.kill(child, 0), 'owned child exited');
  writeFileSync(
    join(evidence!, 'facts.json'),
    JSON.stringify(
      {
        first,
        final,
        sessionId,
        firstOrder,
        coldOrder,
        finalOrder,
        normalExit: true,
        ownedChildrenExited: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ evidence, first, final }));
} catch (error) {
  console.error('actual SQL facts', await facts());
  if (app) {
    const page = await app.firstWindow().catch(() => undefined);
    console.error(
      stage,
      await page
        ?.locator('body')
        .innerText()
        .catch(() => ''),
    );
    await page?.screenshot({ path: join(evidence!, 'failure.png') }).catch(() => {});
    // Failure cleanup may stop only this isolated test application's work.
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await close();
}
