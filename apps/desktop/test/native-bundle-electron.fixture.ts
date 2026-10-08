import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [candidate, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
let conversationId = 's',
  conversationTitle = 'Native bundled',
  conversationUpdatedAt: number | undefined;
const lockState = async () =>
  (await (await fetch(`${control}/locks`)).json()) as { outer: boolean; inner: boolean };
async function launch() {
  console.log('native_driver_stage: launch');
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.error('native_bundle_renderer_error', error.message));
  console.log('native_driver_stage: window');
  page.setDefaultTimeout(10000);
  await page
    .getByRole('button', { name: conversationTitle, exact: true })
    .and(page.locator('button.session-row'))
    .click();
  await page.locator('.session-header').getByTitle(conversationTitle, { exact: true }).waitFor();
  await openSessionTools(page);
  const layout = await page.evaluate(async () => {
    await document.fonts.ready;
    const shell = document.querySelector('.kite-client.shell')!;
    const composer = document.querySelector('.composer')!;
    const shellBounds = shell.getBoundingClientRect(),
      inputBounds = composer.getBoundingClientRect();
    return {
      height: shellBounds.height,
      inputVisible:
        inputBounds.width > 0 && inputBounds.height > 0 && inputBounds.bottom <= innerHeight,
      stylesheet: [...document.styleSheets].some((sheet) => sheet.href?.startsWith('file:')),
      nativeBridge: !!window.kiteNative,
      legacyBridge: 'kiteDesktop' in window,
    };
  });
  assert.ok(layout.height >= 700);
  assert.equal(layout.inputVisible, true);
  assert.equal(layout.stylesheet, true);
  assert.equal(layout.nativeBridge, true);
  assert.equal(layout.legacyBridge, false);
  console.log('native_driver_stage: retained desktop layout, compiled CSS/fonts, current bridge');
  console.log('native_driver_stage: selection');
  const state = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  assert.equal(state.selection?.storeId, storeId);
  if (conversationUpdatedAt !== undefined)
    assert.equal(
      state.directory?.sessions.find((session) => session.id === conversationId)?.activity
        ?.updatedAt,
      conversationUpdatedAt,
    );
  const ps = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        parts.slice(2).join(' ') === join(candidate, 'terminal/runtime/bun'),
    );
  assert.equal(ps.length, 1);
  childPid = Number(ps[0]![0]);
  assert.deepEqual(await lockState(), { outer: true, inner: true });
  console.log('native_driver_stage: locks held');
  return page;
}
try {
  let page = await launch();
  const retainedDraft = 'source-free retained draft\n雪🙂';
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(retainedDraft);
  await page.getByRole('button', { name: '安排任务', exact: true }).click();
  await page.getByRole('main', { name: '安排任务', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).count(),
    0,
  );
  assert.equal(await page.getByRole('button', { name: '工作台', exact: true }).count(), 0);
  await page.getByRole('button', { name: '创建第一个任务', exact: true }).click();
  const scheduledEditor = page.getByRole('complementary', { name: '新建安排任务', exact: true });
  await scheduledEditor.getByRole('textbox', { name: '名称', exact: true }).fill('原页面任务草稿');
  await scheduledEditor
    .getByRole('textbox', { name: '任务说明', exact: true })
    .fill('核对原项目\n🙂');
  const projectChoice = scheduledEditor.getByRole('combobox', { name: /^项目/ });
  await projectChoice.waitFor();
  assert.deepEqual(
    await projectChoice
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ['w'],
  );
  await scheduledEditor.getByRole('combobox', { name: /^运行环境/ }).selectOption('local');
  await scheduledEditor.getByRole('combobox', { name: /^重复/ }).selectOption('weekly-monday-0900');
  assert.equal(
    await scheduledEditor.getByRole('button', { name: '保存任务', exact: true }).isDisabled(),
    true,
  );
  await scheduledEditor
    .locator('form')
    .evaluate((form) => (form as HTMLFormElement).requestSubmit());
  assert.equal(await page.locator('.scheduled-card').count(), 0);
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).inputValue(),
    retainedDraft,
  );
  const afterSchedule = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  assert.equal(afterSchedule.selection?.session.id, 's');
  assert.equal(afterSchedule.inputSubmissions.length, 0);
  assert.equal(afterSchedule.creationSubmissions.length, 0);
  assert.equal(await (await fetch(`${control}/count`)).text(), '0');
  await openSessionTools(page);
  console.log(
    'native_driver_stage: original scheduled page, disabled persistence, exact draft and zero work',
  );
  await page.evaluate(async () => {
    let state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.mode',
      generation: 1,
      observationId: state.selection!.permissions!.observationId,
      mode: 'ask',
      makeDefault: false,
    });
    state = (await window.kiteNative!.request({
      method: 'permission.refresh',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.trust',
      generation: 1,
      observationId: state.selection!.permissions!.observationId,
      trusted: true,
    });
  });
  // Wait for the actual rendered original scope, not merely the Main reply.
  await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await page
    .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    const events: { type: string; focused: boolean }[] = [];
    Object.defineProperty(window, '__bundleInputEvents', { value: events });
    document.addEventListener(
      'submit',
      (event) => {
        if (
          (event.target as HTMLFormElement).querySelector(
            'textarea[aria-label="当前会话私有草稿"], textarea[aria-label="新对话草稿"]',
          )
        )
          events.push({ type: event.type, focused: document.hasFocus() });
      },
      { capture: true },
    );
  });
  const prepareButton = page.getByRole('button', {
    name: '在 Native bundled 中新建对话',
    exact: true,
  });
  await prepareButton.focus();
  await prepareButton.press('Enter');
  await page.getByRole('button', { name: '研究与理解资料', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: '新对话草稿' }).inputValue(),
    '研究与理解资料：',
  );
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: '新对话草稿' }).inputValue(),
    '研究与理解资料：',
  );
  const beforeFirst = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  assert.equal(beforeFirst.creationSubmissions.length, 0);
  assert.equal(beforeFirst.inputSubmissions.length, 0);
  await page.getByRole('textbox', { name: '新对话草稿' }).fill('write one real bundled file');
  assert.equal(
    await page.getByRole('textbox', { name: '新对话草稿' }).inputValue(),
    'write one real bundled file',
  );
  await page.getByRole('button', { name: '发送首条消息' }).click();
  assert.equal(
    await page.evaluate(() => (Reflect.get(window, '__bundleInputEvents') as unknown[]).length),
    1,
  );
  console.log('native_driver_stage: submitted');
  const approvals: string[] = [],
    deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await page.getByText('轮次：completed', { exact: true }).isVisible()) break;
    const approve = page.getByRole('button', { name: 'Approve once', exact: true });
    if (await approve.isVisible()) {
      const state = await page.evaluate(
          async () =>
            (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
        ),
        card = state.selection?.interactions.find((value) => value.state === 'pending');
      if (!card) {
        console.log(
          'native_driver_card_projection',
          JSON.stringify(
            state.selection?.interactions.map((value) => ({
              id: value.id,
              state: value.state,
              definitionId: value.definitionId,
            })),
          ),
        );
        await page.waitForTimeout(20);
        continue;
      }
      if (!approvals.includes(card.id)) {
        if (approvals.length === 0) {
          const pendingRow = page
            .getByRole('button', { name: '新对话', exact: true })
            .and(page.locator('button.session-row'));
          await pendingRow.getByText('待用户输入', { exact: true }).waitFor();
          const actualSession = state.selection!.session.id;
          await page
            .getByRole('button', { name: 'Native bundled', exact: true })
            .and(page.locator('button.session-row'))
            .click();
          await page
            .locator('.session-header')
            .getByTitle('Native bundled', { exact: true })
            .waitFor();
          assert.equal(await pendingRow.getByText('待用户输入', { exact: true }).isVisible(), true);
          const reading = await page.evaluate(
            async () =>
              (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
          );
          assert.equal(reading.selection?.session.id, 's');
          const activity = reading.directory!.sessions.find(
            (session) => session.id === actualSession,
          )!.activity!;
          assert.equal(activity.pendingInteractions, 1);
          assert.equal(activity.run!.id, state.selection!.runs.find((run) => run.isActive)!.id);
          assert.equal(activity.updatedAt! > 0, true);
          assert.equal(
            await page.locator('button.session-row[aria-label]').first().getAttribute('aria-label'),
            '新对话',
          );
          assert.equal(await (await fetch(`${control}/count`)).text(), '1');
          await pendingRow.click();
          await approve.waitFor();
          const original = await page.evaluate(
            async () =>
              (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
          );
          assert.equal(original.selection?.session.id, actualSession);
          assert.ok(
            original.selection?.interactions.some((interaction) => interaction.id === card.id),
          );
          console.log(
            'native_driver_stage: non-selected original pending activity, real time, retained sorting and GET-only navigation',
          );
        }
        approvals.push(card.id);
        await approve.click();
      }
    }
    await page.waitForTimeout(20);
  }
  console.log(
    'native_driver_actual_facts',
    JSON.stringify(
      await page.evaluate(async () => {
        const state = (await window.kiteNative!.request({
          method: 'state',
          generation: 1,
        })) as NativeState;
        return {
          interactions: state.selection?.interactions.map((value) => ({
            id: value.id,
            state: value.state,
            definitionId: value.definitionId,
          })),
          selection: state.selection?.session.id,
          runs: state.selection?.runs.map((run) => ({ id: run.id, status: run.status })),
          inputs: state.inputSubmissions.map((row) => ({
            commandId: row.intent.commandId,
            phase: row.phase,
            error: row.error,
          })),
          events: Reflect.get(window, '__bundleInputEvents'),
        };
      }),
    ),
  );
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  assert.ok(approvals.length > 0);
  console.log('native_driver_stage: completed');
  assert.equal(
    readFileSync(join(home, 'workspace/bundled.txt'), 'utf8'),
    'actual bundled bytes\r\n',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), '2');
  const afterFirst = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  assert.equal(afterFirst.creationSubmissions.length, 1);
  assert.equal(afterFirst.creationSubmissions[0]!.phase, 'created');
  conversationId = afterFirst.creationSubmissions[0]!.input.sessionId;
  conversationTitle = '新对话';
  await page.waitForFunction(async (sessionId) => {
    const state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    const activity = state.directory?.sessions.find(
      (session) => session.id === sessionId,
    )?.activity;
    return (
      !state.directory?.unavailable &&
      activity?.run?.status === 'completed' &&
      !activity.run.isActive &&
      activity.pendingInteractions === 0
    );
  }, conversationId);
  const settledDirectory = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  conversationUpdatedAt = settledDirectory.directory!.sessions.find(
    (session) => session.id === conversationId,
  )!.activity!.updatedAt!;
  assert.ok(conversationUpdatedAt > 0);
  assert.equal(afterFirst.selection?.session.id, conversationId);
  assert.equal(afterFirst.inputSubmissions.length, 1);
  assert.equal(afterFirst.callerSubmissions?.length, 1);
  assert.equal(await page.getByText('write one real bundled file', { exact: true }).count(), 1);
  assert.equal(await page.getByText('正在发送', { exact: true }).count(), 0);
  console.log('native_driver_stage: deferred original preparation and one exact first send');
  const old = childPid!;
  await app!.evaluate(({ app }) => app.quit());
  await app!.close();
  console.log('native_driver_stage: quit');
  app = undefined;
  assert.throws(() => process.kill(old, 0));
  childPid = undefined;
  assert.deepEqual(await lockState(), { outer: false, inner: false });
  page = await launch();
  assert.equal(await (await fetch(`${control}/count`)).text(), '2');
  await page.evaluate(
    async (sessionId) =>
      await window.kiteNative!.request({
        method: 'messages',
        generation: 1,
        sessionId,
        limit: 50,
      }),
    conversationId,
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), '2');
  process.kill(childPid!, 'SIGSTOP');
  app!.process().kill('SIGKILL');
  await new Promise<void>((resolve) => app!.process().once('exit', () => resolve()));
  app = undefined;
  assert.deepEqual(await lockState(), { outer: true, inner: true });
  process.kill(childPid!, 'SIGKILL');
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const locks = await lockState();
    if (!locks.outer && !locks.inner) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await lockState(), { outer: false, inner: false });
  childPid = undefined;
  console.log(
    JSON.stringify({
      approvals: approvals.length,
      provider: 2,
      sourceFree: true,
      normalQuit: true,
      mainKilledChildRetainsBoth: true,
    }),
  );
} finally {
  if (childPid) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  }
  if (app) {
    const owned = app;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owned.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            owned.process().kill('SIGKILL');
            resolve();
          }, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
