import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeDraft, NativeState } from '../src/native-bridge';

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
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let childPid: number | undefined;
type TextInputEvent = {
  type: string;
  target: string;
  text?: string;
  value?: unknown;
  disabled?: unknown;
  trusted: boolean;
  focused: boolean;
  time: number;
};
try {
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => console.error('questionnaire_renderer_error', error.message));
  await page.evaluate(() => {
    const target = window as typeof window & { questionnaireEvents: TextInputEvent[] };
    target.questionnaireEvents = [];
    for (const type of ['input', 'change', 'click', 'submit'])
      document.addEventListener(
        type,
        (event) => {
          const element = event.target as HTMLElement;
          if (!element.closest('form')?.querySelector('textarea[aria-label="当前会话私有草稿"]'))
            return;
          target.questionnaireEvents.push({
            type,
            target: element.tagName,
            text: element.textContent?.slice(0, 160),
            value: 'value' in element ? element.value : undefined,
            disabled: 'disabled' in element ? element.disabled : undefined,
            trusted: event.isTrusted,
            focused: document.hasFocus(),
            time: performance.now(),
          });
          if (target.questionnaireEvents.length > 16) target.questionnaireEvents.shift();
        },
        true,
      );
  });
  await page.getByRole('button', { name: 'Question A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Question A', { exact: true }).waitFor();
  await openSessionTools(page);
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  assert.equal((await state()).selection?.storeId, storeId);
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
  await page.evaluate(async () => {
    let current = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.mode',
      generation: 1,
      observationId: current.selection!.permissions!.observationId,
      mode: 'ask',
      makeDefault: false,
    });
    current = (await window.kiteNative!.request({
      method: 'permission.refresh',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.trust',
      generation: 1,
      observationId: current.selection!.permissions!.observationId,
      trusted: true,
    });
  });
  // Main completion precedes the renderer's watch publication and history read.
  await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  // Observe actual HTTP submissions without changing their responses or authority.
  await app.evaluate(() => {
    const target = globalThis as typeof globalThis & { questionnairePosts: number };
    target.questionnairePosts = 0;
    const original = target.fetch;
    target.fetch = Object.assign(
      (...args: Parameters<typeof original>) => {
        const [input, init] = args;
        if (
          init?.method === 'POST' &&
          /\/interactions\/[^/]+\/answer$/.test(new URL(String(input)).pathname)
        )
          target.questionnairePosts++;
        return original(...args);
      },
      { preconnect: original.preconnect },
    );
  });
  const posts = () =>
    app!.evaluate(
      () => (globalThis as typeof globalThis & { questionnairePosts: number }).questionnairePosts,
    );
  async function select(name: string) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
  }
  async function completed(runId: string) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const current = await state();
      if (current.selection?.runs.some((run) => run.id === runId && run.status === 'completed'))
        return;
      assert.ok(Date.now() < deadline, 'original Run did not complete');
      await page.waitForTimeout(20);
    }
  }
  async function start(content: string, originalDraft: string, modelRequest: number) {
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    await page.evaluate(() => {
      (window as typeof window & { questionnaireEvents: TextInputEvent[] }).questionnaireEvents =
        [];
    });
    const input = page.getByRole('textbox', { name: '当前会话私有草稿' });
    await input.fill(content);
    assert.equal(await input.inputValue(), content);
    await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
    assert.equal(
      await page.evaluate(
        () =>
          (
            window as typeof window & { questionnaireEvents: TextInputEvent[] }
          ).questionnaireEvents.filter((event) => event.type === 'submit').length,
      ),
      1,
    );
    const deadline = Date.now() + 10000;
    while (Number(await (await fetch(`${control}/count`)).text()) !== modelRequest) {
      assert.ok(Date.now() < deadline, 'original Model request was not received');
      await page.waitForTimeout(20);
    }
    await input.fill(originalDraft);
    assert.equal(await input.inputValue(), originalDraft);
    // The existing explicit private draft save is the cross-session Main draft contract.
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: '保留草稿', exact: true }).click();
    const savedDeadline = Date.now() + 10000;
    for (;;) {
      const saved = await page.evaluate(
        async () =>
          (await window.kiteNative!.request({
            method: 'draft.read',
            generation: 1,
            sessionId: 'a',
          })) as NativeDraft | null,
      );
      if (saved?.content === originalDraft) break;
      assert.ok(Date.now() < savedDeadline, 'original Main draft was not saved');
      await page.waitForTimeout(20);
    }
    assert.equal((await fetch(`${control}/continue?request=${modelRequest}`)).status, 200);
    await page.getByRole('form', { name: 'Questionnaire' }).waitFor();
    const card = (await state()).selection!.interactions.find(
      (value) => value.kind === 'question' && value.state === 'pending',
    )!;
    assert.ok(card);
    assert.equal(card.definitionId, 'ask_user');
    assert.equal(await page.getByRole('button', { name: '停止原命令', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^取消原申请/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^停止原 Job/ }).count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '当前会话私有草稿' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '保留草稿', exact: true }).count(), 0);
    return card;
  }
  const mainDraft = '  原主草稿🙂\n保留空格  ';
  const first = await start('Complete original Native questionnaire', mainDraft, 1);
  assert.equal(await page.getByRole('radio', { checked: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '提交回答', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Alpha (Recommended)的说明', exact: true }).focus();
  assert.match(
    await page.getByRole('tooltip').innerText(),
    /Full original description\nUnicode 尾部/,
  );
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await page.getByText('问题 2/3', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await page.getByText('问题 3/3', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '提交回答', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('radio', { name: '自由回答', exact: true }).check();
  await page.getByRole('textbox', { name: '自由回答', exact: true }).fill(' \n ');
  assert.equal(
    await page.getByRole('button', { name: '提交回答', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await posts(), 0);
  const text = '  q3-o1🙂é\n保持 空格  ';
  await page.getByRole('textbox', { name: '自由回答', exact: true }).fill(text);
  await select('Question B');
  await page.getByRole('form', { name: 'Questionnaire' }).waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('form', { name: 'Questionnaire' }).count(), 0);
  await select('Question A');
  assert.equal(
    await page.getByRole('textbox', { name: '自由回答', exact: true }).inputValue(),
    text,
  );
  assert.equal(await page.getByRole('button', { name: '下一题', exact: true }).count(), 0);
  await page.getByRole('button', { name: '上一题', exact: true }).click();
  await page.getByRole('radio', { name: 'q1-o1 (Recommended)', exact: true }).check();
  await page.getByRole('button', { name: '上一题', exact: true }).click();
  await page.getByRole('radio', { name: 'Alpha (Recommended)', exact: true }).check();
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await page.getByText('问题 2/3', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await page.getByText('问题 3/3', { exact: true }).waitFor();
  assert.equal(await posts(), 0);
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await page.getByRole('form', { name: 'Questionnaire' }).waitFor({ state: 'detached' });
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  await completed(first.runId!);
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '当前会话私有草稿' }).inputValue(),
    mainDraft,
  );
  assert.equal(await posts(), 1);
  assert.equal(await (await fetch(`${control}/count`)).text(), '2');
  const cancelDraft = '  取消问卷前的主草稿\n雪🙂  ';
  const second = await start(
    'Cancel only this Native questionnaire and continue its task',
    cancelDraft,
    3,
  );
  assert.notEqual(second.runId, first.runId);
  await page.getByRole('button', { name: 'Cancel answering', exact: true }).click();
  await page.getByRole('form', { name: 'Questionnaire' }).waitFor({ state: 'detached' });
  await completed(second.runId!);
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '当前会话私有草稿' }).inputValue(),
    cancelDraft,
  );
  assert.equal(await posts(), 2);
  assert.equal(await (await fetch(`${control}/count`)).text(), '4');
  const current = await state();
  const cards = [first, second].map((card) => {
    const receipt = current.interactionSubmissions.find(
      (value) => value.interaction.id === card.id,
    )!;
    assert.equal(receipt.phase, 'accepted');
    return {
      id: card.id,
      runId: card.runId,
      executionId: card.executionId,
      commandId: receipt.intent.commandId,
    };
  });
  await select('Question B');
  await select('Question A');
  assert.equal(await posts(), 2);
  assert.equal(await (await fetch(`${control}/count`)).text(), '4');
  const owned = app;
  const exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  assert.throws(() => process.kill(childPid!, 0));
  writeFileSync(
    join(home, 'questionnaire-report.json'),
    JSON.stringify({ cards, posts: 2, childPid }),
  );
  childPid = undefined;
  console.log(
    JSON.stringify({
      sourceFree: true,
      defaultService: true,
      answered: 1,
      informationCancelled: 1,
      providerRequests: 4,
      originalRunsCompleted: 2,
    }),
  );
} catch (error) {
  if (app)
    try {
      const page = app.windows()[0]!;
      console.error(
        'questionnaire_actual_failure',
        JSON.stringify({
          state: await page.evaluate(async () => {
            const current = (await window.kiteNative!.request({
              method: 'state',
              generation: 1,
            })) as NativeState;
            return {
              session: current.selection?.session.id,
              runs: current.selection?.runs.map((run) => ({ id: run.id, status: run.status })),
              interactions: current.selection?.interactions.map((card) => ({
                id: card.id,
                revision: card.revision,
                state: card.state,
              })),
              answers: current.interactionSubmissions.map((row) => ({
                commandId: row.intent.commandId,
                phase: row.phase,
              })),
              inputSubmissions: current.inputSubmissions.map((row) => ({
                commandId: row.intent.commandId,
                phase: row.phase,
              })),
              events: (window as typeof window & { questionnaireEvents: TextInputEvent[] })
                .questionnaireEvents,
              draft: document.querySelector('textarea')?.value,
              focused: document.hasFocus(),
              active: document.activeElement?.outerHTML,
            };
          }),
          visible: await page.locator('body').innerText(),
        }),
      );
      await page.screenshot({
        path: '/private/tmp/kite-native-questionnaire-window-failure-20261006.png',
        fullPage: true,
      });
    } catch (diagnostic) {
      console.error('questionnaire_diagnostic_unavailable', diagnostic);
    }
  throw error;
} finally {
  if (childPid)
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
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
