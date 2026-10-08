import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [launcher, home, control, originalStoreId] = process.argv.slice(2) as [
    string,
    string,
    string,
    string,
  ],
  content = await (await fetch(`${control}/content`)).text(),
  contentHash = createHash('sha256').update(content).digest('hex');
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined,
  servicePid: number | undefined,
  forkId = '',
  bodyHash = '';
const count = async () => Number(await (await fetch(`${control}/count`)).text());
process.on('SIGTERM', () => {
  if (servicePid) {
    try {
      process.kill(servicePid, 'SIGKILL');
    } catch {}
  }
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
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
          getLastWebPreferences(): {
            sandbox?: boolean;
            contextIsolation?: boolean;
            nodeIntegration?: boolean;
          };
        },
        preferences = contents.getLastWebPreferences();
      return {
        disabled: app.commandLine.hasSwitch('no-sandbox'),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      };
    }),
    { disabled: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  // Observation only: the real SDK fetch, returned response, Main and renderer stay unchanged.
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__outputAudit={requests:[],outputs:[],models:[]};globalThis.fetch=async(input,init)=>{const request=new Request(input,init);const path=new URL(request.url).pathname;globalThis.__outputAudit.requests.push(request.method+' '+path);const response=await original(input,init);if(response.ok&&request.method==='GET'){if(path.includes('/model-output'))globalThis.__outputAudit.outputs.push(await response.clone().json());else if(path.startsWith('/v1/executions/'))globalThis.__outputAudit.models.push(await response.clone().json());}return response;};})()`,
  );
  await page
    .getByRole('button', { name: 'Source original', exact: true })
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
async function readFull(page: import('playwright').Page, storeId: string, sealed: boolean) {
  await page
    .getByRole('button', { name: 'Read complete recorded Model output', exact: true })
    .click();
  await page.getByText('Complete Model output', { exact: true }).waitFor();
  await page.getByText('RESTORED ORIGINAL COMPLETE TAIL', { exact: false }).waitFor();
  const audit = (await app!.evaluate('globalThis.__outputAudit')) as {
    requests: string[];
    outputs: ModelOutputSnapshot[];
    models: { id: string; kind: string; sessionId: string; runId: string; originStoreId: string }[];
  };
  const output = audit.outputs.at(-1)!;
  assert.ok(output);
  assert.equal(output.storeId, storeId);
  assert.equal(output.sessionId, 's');
  assert.equal(output.output.content, content);
  assert.equal(output.contentBytes, String(Buffer.byteLength(content)));
  assert.equal(createHash('sha256').update(output.output.content).digest('hex'), contentHash);
  assert.equal(output.output.complete, true);
  assert.equal(output.status, 'succeeded');
  if (!bodyHash) bodyHash = output.bodyHash;
  else assert.equal(output.bodyHash, bodyHash);
  if (sealed) {
    const model = audit.models.find((entry) => entry.id === output.executionId)!;
    assert.ok(model);
    assert.equal(model.kind, 'model');
    assert.equal(model.originStoreId, originalStoreId);
    assert.equal(model.sessionId, 's');
    assert.equal(model.runId, output.runId);
    assert.equal(await page.locator('.agent-turn-final').count(), 0);
    assert.equal(
      await page.getByRole('button', { name: '复制本轮Agent回复', exact: true }).count(),
      0,
    );
  }
  assert.equal(await count(), 1);
}
async function noWrites() {
  const requests = (await app!.evaluate('globalThis.__outputAudit.requests')) as string[];
  assert.deepEqual(
    requests.filter((entry) => !entry.startsWith('GET ')),
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
  await select(page, 'Source original');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('one explicit harmless original Model');
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  await page.locator('.agent-turn-final').waitFor();
  await readFull(page, originalStoreId, false);
  await page.getByRole('button', { name: 'Close full Model output', exact: true }).click();
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const panel = page.getByRole('region', { name: '会话管理', exact: true });
  await panel.getByRole('button', { name: '读取当前会话管理事实', exact: true }).click();
  await panel.getByRole('textbox', { name: '会话管理名称', exact: true }).fill('Sealed Fork');
  await panel.getByRole('button', { name: '从当前所选上下文分叉', exact: true }).click();
  await panel.getByRole('button', { name: '打开已确认分叉', exact: true }).click();
  await page.locator('.session-header').getByTitle('Sealed Fork', { exact: true }).waitFor();
  const fork = await state(page);
  forkId = fork.selection!.session.id;
  assert.notEqual(forkId, 's');
  const message = (await history(page, forkId)).find((message) => message.outputBody)!;
  assert.ok(message);
  assert.equal(message.runId, null);
  assert.equal(message.originMessage!.storeId, originalStoreId);
  assert.equal(message.originMessage!.sessionId, 's');
  await app!.evaluate('globalThis.__outputAudit.requests=[]');
  await readFull(page, originalStoreId, true);
  await noWrites();
  console.log('native_restored_output: original source and sealed Fork complete');
  await close();
  const restored = (await (await fetch(`${control}/restore`, { method: 'POST' })).json()) as {
    storeId: string;
    originalStoreId: string;
  };
  assert.notEqual(restored.storeId, originalStoreId);
  assert.equal(restored.originalStoreId, originalStoreId);
  for (const cold of [false, true]) {
    page = await launch();
    await select(page, 'Sealed Fork');
    assert.equal((await state(page)).selection!.storeId, restored.storeId);
    const copy = (await history(page, forkId)).find((entry) => entry.id === message.id)!;
    assert.equal(copy.originMessage!.storeId, originalStoreId);
    assert.equal(copy.originMessage!.runId, message.originMessage!.runId);
    assert.equal(copy.outputBody!.executionId, message.outputBody!.executionId);
    await readFull(page, restored.storeId, true);
    await page.getByRole('button', { name: 'Close full Model output', exact: true }).click();
    await page.getByText('Model output preview · full body not loaded', { exact: true }).waitFor();
    await select(page, 'Other original');
    await select(page, 'Sealed Fork');
    assert.equal(
      await page.getByRole('button', { name: 'Close full Model output', exact: true }).count(),
      0,
    );
    if (cold) {
      await select(page, 'Source original');
      await readFull(page, restored.storeId, false);
      const copy = page.getByRole('button', { name: '复制本轮Agent回复', exact: true });
      assert.equal(await copy.isDisabled(), false);
      await page.getByRole('button', { name: 'Close full Model output', exact: true }).click();
      assert.equal(await copy.count(), 0);
    }
    await noWrites();
    await close();
    console.log(`native_restored_output: restored ${cold ? 'cold' : 'first'} read and owned exit`);
  }
  console.log(
    JSON.stringify({
      sourceFreeInstalled: true,
      explicitFork: true,
      restoredOriginPreserved: true,
      fullContentBytes: Buffer.byteLength(content),
      contentHash,
      bodyHash,
      coldRead: true,
      provider: await count(),
      restoredBusinessPosts: 0,
      ordinaryOwnedExit: true,
    }),
  );
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      app.process().kill('SIGKILL');
    }
  }
  if (servicePid) {
    try {
      process.kill(servicePid, 'SIGKILL');
    } catch {}
  }
}
