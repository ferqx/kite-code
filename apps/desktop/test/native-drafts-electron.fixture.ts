import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';

const [
  outdir,
  root,
  _dataRoot,
  _storeId,
  _endpoint,
  electronExecutable,
  control,
  bunExecutable,
  resetStore,
] = process.argv.slice(2) as string[];
const text = '冷重启保留的原草稿\n🙂 exact original body';
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
async function launch() {
  const app = await _electron.launch({
    timeout: 10000,
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  application = app;
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  return { app, page };
}
function servicePid(app: Awaited<ReturnType<typeof _electron.launch>>) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n');
  const row = rows.find((line) => {
    const fields = line.trim().split(/\s+/);
    return Number(fields[1]) === app.process().pid && fields.slice(2).join(' ') === bunExecutable;
  });
  assert.ok(row);
  return Number(row!.trim().split(/\s+/)[0]);
}
async function quit(app: Awaited<ReturnType<typeof _electron.launch>>) {
  const pid = servicePid(app),
    exit = new Promise<void>((r) => app.process().once('exit', () => r()));
  await app.evaluate(({ app }) => app.quit());
  await exit;
  assert.throws(() => process.kill(pid, 0));
  application = undefined;
}
try {
  let { app, page } = await launch();
  assert.equal(
    await app.evaluate("typeof process.getBuiltinModule('node:sqlite').DatabaseSync"),
    'function',
  );
  const textarea = page.getByRole('textbox').first();
  await textarea.fill(text);
  await page.getByRole('button', { name: '保留草稿', exact: true }).click();
  await quit(app);
  ({ app, page } = await launch());
  assert.equal(await page.getByRole('textbox').first().inputValue(), text);
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox').first().inputValue(), text);
  assert.equal(await (await fetch(`${control}/count`)).text(), '0');
  const rejected = await page.evaluate(async (storeId) => {
    const bridge = window.kiteNative!;
    const state = (await bridge.request({ method: 'attach' })) as { generation: number };
    return await bridge.request({
      method: 'createSession',
      generation: state.generation,
      expectedStoreId: storeId!,
      workspaceId: 'w',
      commandId: 'create-s',
      sessionId: 'not-created',
      title: 'rejected',
    });
  }, _storeId);
  assert.equal((rejected as { phase: string }).phase, 'rejected');
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox').first().inputValue(), text);
  // Test-only Inspector instrumentation sends the real POST over Node's actual TCP socket.
  // After Service response headers (the transaction is committed), destroy that socket before
  // supplying JSON bytes. No fake Session/Command receipt or alternative authority is injected.
  await app.evaluate(`(() => {
    const original=globalThis.fetch, http=process.getBuiltinModule('node:http');globalThis.__creationPosts=0;
    globalThis.fetch=(input,init)=> {
      if(init?.method!=='POST'||new URL(String(input)).pathname!=='/v1/sessions') return original(input,init);
      globalThis.__creationPosts++;
      return new Promise((resolve,reject)=> {
        const request=http.request(String(input),{method:'POST',headers:init.headers},response=> {
          const socket=response.socket;
          const body=new ReadableStream({start(controller) {
            response.on('data',()=>{socket.destroy();controller.error(Error('owned_physical_response_loss'));});
            response.on('error',error=>controller.error(error));
          }});
          resolve(new Response(body,{status:response.statusCode,headers:{'content-type':'application/json'}}));
        });
        request.on('error',reject);request.end(init.body);
      });
    };
  })()`);
  const create = page.getByRole('button', { name: '新建会话', exact: true });
  await create.focus();
  await create.press('Enter');
  await page.getByRole('button', { name: '核实原创建命令', exact: true }).waitFor();
  assert.equal(await app.evaluate('globalThis.__creationPosts'), 1);
  await page.reload();
  await page.getByRole('button', { name: '核实原创建命令', exact: true }).waitFor();
  assert.equal(await app.evaluate('globalThis.__creationPosts'), 1);
  const originalIntent = await page
    .getByRole('region', { name: '会话创建意图' })
    .filter({ has: page.getByRole('button', { name: '核实原创建命令', exact: true }) })
    .innerText();
  await quit(app);
  ({ app, page } = await launch());
  assert.equal(await page.getByRole('textbox').first().inputValue(), text);
  assert.equal(
    await page.getByRole('region', { name: '会话创建意图' }).innerText(),
    originalIntent,
  );
  await app.evaluate(
    `(() => { const original=globalThis.fetch;globalThis.__creationPosts=0;globalThis.fetch=(input,init)=>{if(init?.method==='POST'&&new URL(String(input)).pathname==='/v1/sessions')globalThis.__creationPosts++;return original(input,init);}; })()`,
  );
  await page.getByRole('button', { name: '核实原创建命令', exact: true }).click();
  await page.getByText(/创建已确认/).waitFor();
  assert.equal(await app.evaluate('globalThis.__creationPosts'), 0);
  assert.equal(await (await fetch(`${control}/count`)).text(), '0');
  assert.equal(await page.getByRole('textbox').first().inputValue(), text);
  await quit(app);
  const newStore = execFileSync(bunExecutable!, [resetStore!], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  }).trim();
  assert.notEqual(newStore, _storeId);
  ({ app, page } = await launch());
  assert.equal(await page.getByRole('textbox').first().inputValue(), '');
  await page.getByRole('button', { name: '读取已保存草稿', exact: true }).click();
  await page.getByRole('button', { name: '草稿 s · 修订 1', exact: true }).click();
  await page.getByText('原关联不可用，文本已保留，没有绑定当前会话。', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '保留的原关联草稿', exact: true }).inputValue(),
    text,
  );
  assert.equal(
    await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).inputValue(),
    '',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), '0');
  await quit(app);
  console.log('cold-drafts-and-physical-create-qualified');
} catch (error) {
  console.error(error);
  if (application) {
    console.error(
      (await (await application.firstWindow()).locator('body').innerText()).slice(0, 3000),
    );
    application.process().kill('SIGKILL');
  }
  process.exitCode = 1;
}
