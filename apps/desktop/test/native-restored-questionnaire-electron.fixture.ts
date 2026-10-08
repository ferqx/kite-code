import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Execution, Message } from '@kite-ai/client';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [launcher, home, control, originalStoreId] = process.argv.slice(2) as [
    string,
    string,
    string,
    string,
  ],
  facts = (await (await fetch(`${control}/facts`)).json()) as {
    content: string;
    questions: { question: string }[];
    answers: { q1: string; q2: string };
  };
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined,
  servicePid: number | undefined,
  forkId = '';
const count = async () => Number(await (await fetch(`${control}/count`)).text());
process.on('SIGTERM', () => {
  if (servicePid)
    try {
      process.kill(servicePid, 'SIGKILL');
    } catch {}
  app?.process().kill('SIGKILL');
  process.exitCode = 1;
});
async function launch() {
  app = await _electron.launch({
    executablePath: launcher,
    args: [`--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
    chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  assert.deepEqual(
    await app.evaluate(({ app, BrowserWindow }) => {
      const preferences = (
        BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
          getLastWebPreferences(): {
            sandbox?: boolean;
            contextIsolation?: boolean;
            nodeIntegration?: boolean;
          };
        }
      ).getLastWebPreferences();
      return {
        disabled: app.commandLine.hasSwitch('no-sandbox'),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      };
    }),
    { disabled: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  // Observe the actual SDK response; never substitute HTTP facts or Main/renderer consumers.
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__questionAudit={requests:[],executions:[]};globalThis.fetch=async(input,init)=>{const request=new Request(input,init);const path=new URL(request.url).pathname;globalThis.__questionAudit.requests.push(request.method+' '+path);const response=await original(input,init);if(response.ok&&request.method==='GET'&&path.startsWith('/v1/executions/'))globalThis.__questionAudit.executions.push(await response.clone().json());return response;};})()`,
  );
  await page
    .getByRole('button', { name: 'Source questions', exact: true })
    .and(page.locator('button.session-row'))
    .waitFor();
  const children = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (row) =>
        Number(row[1]) === app!.process().pid &&
        row.slice(2).join(' ').endsWith('/terminal/runtime/bun'),
    );
  assert.equal(children.length, 1);
  servicePid = Number(children[0]![0]);
  return page;
}
async function select(page: import('playwright').Page, title: string) {
  await page
    .getByRole('button', { name: title, exact: true })
    .and(page.locator('button.session-row'))
    .click();
  await page.locator('.session-header').getByTitle(title, { exact: true }).waitFor();
}
async function state(page: import('playwright').Page) {
  return page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
}
async function history(page: import('playwright').Page, sessionId: string) {
  return page.evaluate(async (sessionId) => {
    const result = await window.kiteNative!.request({
      method: 'messages',
      generation: 1,
      sessionId,
      limit: 32,
    });
    if (!result || !('messages' in result)) throw Error('original_history_missing');
    return result.messages;
  }, sessionId) as Promise<Message[]>;
}
async function openTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}
async function receipt(page: import('playwright').Page, original: Message) {
  const process = page.getByRole('button', { name: /展开本轮处理过程/ });
  if (await process.count()) await process.click();
  const row = page.getByRole('article', { name: /^询问用户 · 已回答 2 项/ });
  await row.waitFor();
  const summary = row.locator('.tool-activity-summary');
  if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
  await row.locator('.tool-ask-text').first().waitFor();
  assert.deepEqual(
    await row.locator('.tool-ask-text').allTextContents(),
    facts.questions.map(
      (question, index) => `${question.question}：${facts.answers[index === 0 ? 'q1' : 'q2']}`,
    ),
  );
  assert.equal(await page.getByRole('form', { name: 'Questionnaire' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '提交回答', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('button', { name: 'Cancel answering', exact: true }).count(),
    0,
  );
  const audit = (await app!.evaluate('globalThis.__questionAudit')) as {
      requests: string[];
      executions: Execution[];
    },
    execution = audit.executions.find((entry) => entry.id === original.sourceIds![0])!;
  assert.ok(execution);
  assert.equal(execution.originStoreId, originalStoreId);
  assert.equal(execution.sessionId, 's');
  assert.equal(execution.runId, original.runId);
  assert.equal(execution.definitionId, 'ask_user');
  assert.equal(execution.definitionVersion, '1');
  assert.equal(execution.status, 'succeeded');
  const result = execution.result;
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.content, original.content);
  assert.deepEqual(JSON.parse(original.content).answers, facts.answers);
  assert.equal(await count(), 2);
}
async function noWrites(sealed = false) {
  const requests = (await app!.evaluate('globalThis.__questionAudit.requests')) as string[];
  assert.deepEqual(
    requests.filter((entry) => !entry.startsWith('GET ')),
    [],
  );
  if (sealed)
    assert.deepEqual(
      requests.filter((entry) => entry.startsWith('GET /v1/runs/')),
      [],
    );
}
async function close() {
  const pid = servicePid!;
  await app!.evaluate(({ app }) => app.quit());
  await app!.close();
  app = undefined;
  assert.throws(() => process.kill(pid, 0));
  servicePid = undefined;
  assert.deepEqual(await (await fetch(`${control}/unlocked`)).json(), { unlocked: true });
}
try {
  let page = await launch();
  await select(page, 'Source questions');
  await openTools(page);
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
  await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await app!.evaluate('globalThis.__questionAudit.requests=[]');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('沿原 PC 问卷填写并保存回答');
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  await page.getByRole('form', { name: 'Questionnaire' }).waitFor();
  await page.getByRole('radio', { name: `${facts.answers.q1} (Recommended)`, exact: true }).check();
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await page.getByText('问题 2/2', { exact: true }).waitFor();
  await page.getByRole('radio', { name: '自由回答', exact: true }).check();
  await page.getByRole('textbox', { name: '自由回答', exact: true }).fill(facts.answers.q2);
  assert.equal(
    await page.getByRole('textbox', { name: '自由回答', exact: true }).inputValue(),
    facts.answers.q2,
  );
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await page.getByRole('form', { name: 'Questionnaire' }).waitFor({ state: 'detached' });
  await page.locator('.agent-turn-final').getByText(facts.content, { exact: true }).waitFor();
  const source = await history(page, 's'),
    original = source.find(
      (message) => message.role === 'tool' && message.toolCallId === 'original-ask-call',
    )!;
  assert.ok(original);
  await receipt(page, original);
  const requests = (await app!.evaluate('globalThis.__questionAudit.requests')) as string[];
  assert.equal(
    requests.filter((entry) => /^POST \/v1\/sessions\/s\/interactions\/[^/]+\/answer$/.test(entry))
      .length,
    1,
  );
  const panel = page.getByRole('region', { name: '会话管理', exact: true });
  await panel.getByRole('button', { name: '读取当前会话管理事实', exact: true }).click();
  await panel.getByRole('textbox', { name: '会话管理名称', exact: true }).fill('Sealed questions');
  await panel.getByRole('button', { name: '从当前所选上下文分叉', exact: true }).click();
  const openFork = panel.getByRole('button', { name: '打开已确认分叉', exact: true });
  await openFork.waitFor();
  const forkRequests = (await app!.evaluate('globalThis.__questionAudit.requests')) as string[];
  assert.equal(forkRequests.filter((entry) => entry === 'POST /v1/sessions/s/fork').length, 1);
  await app!.evaluate('globalThis.__questionAudit.requests=[]');
  await openFork.click();
  await page.locator('.session-header').getByTitle('Sealed questions', { exact: true }).waitFor();
  forkId = (await state(page)).selection!.session.id;
  assert.notEqual(forkId, 's');
  const copies = await history(page, forkId);
  assert.equal(copies.length, source.length);
  for (const copy of copies) {
    const message = source.find((entry) => entry.id === copy.originMessage!.messageId)!;
    assert.ok(message);
    assert.deepEqual(copy.originMessage, {
      storeId: originalStoreId,
      sessionId: 's',
      messageId: message.id,
      runId: message.runId,
    });
    assert.equal(copy.runId, null);
    assert.equal(copy.content, message.content);
    assert.deepEqual(copy.toolCalls, message.toolCalls);
  }
  await receipt(page, original);
  assert.equal(await page.locator('.agent-turn-final').count(), 0);
  await noWrites(true);
  await close();
  console.log('native_restored_questionnaire: original UI answer and sealed receipt complete');
  const restored = (await (await fetch(`${control}/restore`, { method: 'POST' })).json()) as {
    storeId: string;
    originalStoreId: string;
  };
  assert.notEqual(restored.storeId, originalStoreId);
  assert.equal(restored.originalStoreId, originalStoreId);
  for (const cold of [false, true]) {
    page = await launch();
    await select(page, 'Sealed questions');
    assert.equal((await state(page)).selection!.storeId, restored.storeId);
    assert.deepEqual(await history(page, forkId), copies);
    await receipt(page, original);
    assert.equal(await page.locator('.agent-turn-final').count(), 0);
    await noWrites(true);
    await select(page, 'Other questions');
    assert.equal(await page.locator('.tool-ask-answers').count(), 0);
    await app!.evaluate('globalThis.__questionAudit.requests=[]');
    await select(page, 'Source questions');
    assert.deepEqual(await history(page, 's'), source);
    await receipt(page, original);
    await noWrites();
    await close();
    console.log(
      `native_restored_questionnaire: restored ${cold ? 'cold' : 'first'} source/Fork read and owned exit`,
    );
  }
  console.log(
    JSON.stringify({
      sourceFreeInstalled: true,
      originalQuestionnaire: true,
      originalAnswersPreserved: true,
      sealedAndRestoredSource: true,
      explicitFork: true,
      coldRead: true,
      provider: await count(),
      originalAnswerPosts: 1,
      restoredBusinessPosts: 0,
      sealedSourceRunGets: 0,
      ordinaryOwnedExit: true,
    }),
  );
} catch (error) {
  if (app)
    try {
      console.error(
        'native_restored_questionnaire_failure',
        JSON.stringify({
          selection: (await state(app.windows()[0]!)).selection?.session.id,
          audit: await app.evaluate('globalThis.__questionAudit.requests'),
          visible: await app.windows()[0]!.locator('body').innerText(),
        }),
      );
    } catch {}
  throw error;
} finally {
  if (app)
    try {
      await app.close();
    } catch {
      app.process().kill('SIGKILL');
    }
  if (servicePid)
    try {
      process.kill(servicePid, 'SIGKILL');
    } catch {}
}
