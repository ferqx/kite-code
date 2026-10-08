import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeResult, NativeState } from '../src/native-bridge';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [outdir, root, electronExecutable, pointId, path, preimage, packagePath] =
  process.argv.slice(2);
const { _electron } = createRequire(packagePath!)('playwright') as typeof import('playwright');
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
async function launch() {
  const app = await _electron.launch({
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  application = app;
  app
    .process()
    .stderr?.on('data', (chunk) =>
      console.error('owned_main_stderr', String(chunk).slice(0, 1500)),
    );
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => console.error('renderer_error', error.message));
  await page.getByRole('button', { name: 'Actual checkpoint', exact: true }).click();
  await page.locator('.session-header').getByTitle('Actual checkpoint', { exact: true }).waitFor();
  await openSessionTools(page);
  return { app, page };
}
function ownedChild(app: Awaited<ReturnType<typeof _electron.launch>>) {
  const children = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app.process().pid && /\/bun(?:\.exe)?$/.test(parts.slice(2).join(' ')),
    );
  assert.equal(children.length, 1);
  return Number(children[0]![0]);
}
try {
  let { app, page } = await launch();
  const before = readFileSync(path!),
    inode = statSync(path!).ino;
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__filePosts=0;globalThis.__fileReadAborts=0;globalThis.__loseFiles=true;globalThis.fetch=async(input,init)=>{if(init?.method==='POST')globalThis.__filePosts++;let response;try{response=await original(input,init);}catch(error){if(error?.name==='AbortError'&&init?.signal?.aborted)globalThis.__fileReadAborts++;throw error;}if(globalThis.__loseFiles&&init?.method==='POST'&&(String(input).endsWith('/fork')||String(input).endsWith('/commands')&&JSON.parse(init.body).kind==='extension.invoke')){await response.text();throw Error('owned_response_loss');}return response;};})()`,
  );
  const panel = page.getByRole('region', { name: '文件检查点恢复' });
  await panel.getByRole('button', { name: '文件检查点', exact: true }).click();
  await panel.getByLabel('恢复范围', { exact: true }).selectOption('both');
  await panel.getByRole('button', { name: '读取检查点', exact: true }).click();
  await panel.getByRole('button', { name: `检查点 ${pointId}`, exact: true }).click();
  await panel.getByLabel('确认当前范围与检查点', { exact: true }).check();
  await panel.getByRole('button', { name: '执行恢复', exact: true }).click();
  await panel.getByText(/代码 unknown · 会话 not_started/).waitFor();
  assert.deepEqual(readFileSync(path!), before);
  assert.equal(statSync(path!).ino, inode);
  const approve = page.getByRole('button', { name: '仅批准这一次', exact: true });
  await approve.waitFor();
  const beforeInvalid = Number(await app.evaluate('globalThis.__filePosts'));
  const invalid = await page.evaluate(async () => {
    const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
    if (!state || !('selection' in state)) throw Error('actual_native_card_missing');
    const card = state.selection?.interactions.find(
      (value) => value.definitionId === 'builtin.files/files.checkpoint.restore',
    );
    if (!card) throw Error('actual_native_card_missing');
    const answer: { kind: 'approval'; decision: 'approve'; grant: 'approve_once' } = {
      kind: 'approval',
      decision: 'approve',
      grant: 'approve_once',
    };
    // A malformed renderer protocol probe: the actual card scope and IDs remain unchanged.
    Reflect.set(answer, 'grant', 'all');
    try {
      await window.kiteNative!.request({
        method: 'interaction.answer',
        generation: 1,
        interactionId: card.id,
        revision: card.revision,
        answer,
      });
      return 'accepted';
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.equal(invalid, 'invalid_native_request');
  assert.equal(Number(await app.evaluate('globalThis.__filePosts')), beforeInvalid);
  assert.deepEqual(readFileSync(path!), before);
  await approve.click();

  const terminalDeadline = Date.now() + 10000;
  for (;;) {
    const beforeAborts = Number(await app.evaluate('globalThis.__fileReadAborts'));
    let terminal: NativeResult;
    try {
      terminal = await page.evaluate(async () => {
        const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
        if (!state || !('fileRecoverySubmissions' in state)) return null;
        const saved = state.fileRecoverySubmissions?.[0],
          input = saved?.code?.request.input;
        const restoreId =
          input && typeof input === 'object' && !Array.isArray(input) ? input.restoreId : undefined;
        return saved && typeof restoreId === 'string'
          ? window.kiteNative!.request({
              method: 'fileRecovery.status',
              generation: 1,
              readId: 'terminal-observer',
              pointId: saved.checkpoint.id,
              restoreId,
            })
          : null;
      });
    } catch (error) {
      assert.match(String(error), /native_request_failed/);
      assert.ok(Number(await app.evaluate('globalThis.__fileReadAborts')) > beforeAborts);
      if (Date.now() > terminalDeadline) throw error;
      continue;
    }
    if (
      terminal &&
      'payload' in terminal &&
      'execution' in terminal.payload &&
      terminal.payload.execution?.status === 'succeeded'
    )
      break;
    if (Date.now() > terminalDeadline) throw Error('actual_native_restore_terminal_deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await panel.getByRole('button', { name: '查询原恢复', exact: true }).click();

  await panel.getByRole('button', { name: '明确继续原会话分支', exact: true }).waitFor();
  assert.deepEqual(readFileSync(path!), readFileSync(preimage!));
  assert.notEqual(statSync(path!).ino, inode);
  const beforeState = (await page.evaluate(async () =>
    window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  const original = beforeState.fileRecoverySubmissions![0]!;
  assert.equal(original.code!.phase, 'succeeded');
  assert.equal(original.fork!.phase, 'not_started');
  await panel.getByRole('button', { name: '明确继续原会话分支', exact: true }).click();
  await panel.getByText(/代码 succeeded · 会话 unknown/).waitFor();
  const child = ownedChild(app),
    exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  process.kill(child, 'SIGKILL');
  app.process().kill('SIGKILL');
  await exited;
  application = undefined;
  ({ app, page } = await launch());
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__coldPosts=0;globalThis.fetch=(input,init)=>{if(init?.method==='POST')globalThis.__coldPosts++;return original(input,init);};})()`,
  );
  const cold = page.getByRole('region', { name: '文件检查点恢复' });
  await cold.getByText(/代码 succeeded · 会话 unknown/).waitFor();
  const afterState = (await page.evaluate(async () =>
    window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  const saved = afterState.fileRecoverySubmissions![0]!;
  assert.equal(saved.code!.request.commandId, original.code!.request.commandId);
  assert.equal(saved.fork!.request.commandId, original.fork!.request.commandId);
  await cold.getByRole('button', { name: '查询原恢复', exact: true }).click();
  await cold.getByText(/代码 succeeded · 会话 succeeded/).waitFor();
  assert.equal(await app.evaluate('globalThis.__coldPosts'), 0);
  assert.deepEqual(readFileSync(path!), readFileSync(preimage!));
  const currentChild = ownedChild(app),
    exit = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ app }) => app.quit());
  await exit;
  application = undefined;
  assert.throws(() => process.kill(currentChild, 0), /ESRCH/);
  console.log(
    'Native Files Electron assertions: original code/Fork lost replies, independent Ask, full bytes/new inode, SIGKILL cold original IDs and zero POST',
  );
} finally {
  if (application) {
    const child = ownedChild(application);
    application.process().kill('SIGKILL');
    try {
      process.kill(child, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error('owned_child_cleanup_failed', error);
        process.exitCode = 1;
      }
    }
  }
}
