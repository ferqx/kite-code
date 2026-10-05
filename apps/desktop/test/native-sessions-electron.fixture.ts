import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [outdir, root, _dataRoot, storeId, _endpoint, electronExecutable, control, bunExecutable] =
  process.argv.slice(2) as string[];
const app = await _electron.launch({
  executablePath: electronExecutable,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 10000,
});
let pid = 0;
const count = async () => Number(await (await fetch(`${control}/count`)).text());
try {
  const page = await app.firstWindow();
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__nativeRequests={};globalThis.fetch=(input,init)=>{const request=new Request(input,init);const key=request.method+' '+new URL(request.url).pathname;globalThis.__nativeRequests[key]=(globalThis.__nativeRequests[key]??0)+1;return original(input,init);};})()`,
  );
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  await page.evaluate(async () => {
    const state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.mode',
      generation: 1,
      observationId: state.selection!.permissions!.observationId,
      mode: 'full',
      makeDefault: false,
    });
    const updated = (await window.kiteNative!.request({
      method: 'permission.refresh',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.trust',
      generation: 1,
      observationId: updated.selection!.permissions!.observationId,
      trusted: true,
    });
  });
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill('one harmless local Model');
  await page.getByRole('button', { name: '发送明确的新轮次' }).press('Enter');
  await fetch(`${control}/entered`);
  await fetch(`${control}/release`);
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  assert.equal(await count(), 1);
  const panel = page.getByRole('region', { name: '会话管理' });
  await panel.getByRole('button', { name: '读取当前会话管理事实' }).click();
  await panel.getByRole('textbox', { name: '会话管理名称' }).fill('Forked original');
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__sessionOriginal=original;globalThis.__forkPosts=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.method!=='POST'||!new URL(request.url).pathname.endsWith('/sessions/s/fork'))return original(input,init);globalThis.__forkPosts++;const body=Buffer.from(await request.arrayBuffer());const http=process.getBuiltinModule('node:http');return await new Promise((resolve,reject)=>{const outgoing=http.request(request.url,{method:'POST',headers:Object.fromEntries(request.headers)},response=>{response.destroy();outgoing.destroy();reject(new TypeError('owned_fork_response_lost'));});outgoing.on('error',reject);outgoing.end(body);});};})()`,
  );
  await panel.getByRole('button', { name: '从当前所选上下文分叉' }).press('Enter');
  await panel.getByText(/fork：unknown/).waitFor();
  assert.equal(await app.evaluate('globalThis.__forkPosts'), 1);
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await panel.getByRole('button', { name: '查询原会话操作' }).press('Enter');
  await panel.getByRole('button', { name: '打开已确认分叉' }).waitFor();
  const confirmed = await page.evaluate(async () => {
    const state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    return state.sessionSubmissions?.find((entry) => entry.kind === 'fork');
  });
  assert.ok(confirmed);
  assert.equal(confirmed.phase, 'applied');
  assert.equal(typeof confirmed.omittedExtensionState, 'boolean');
  assert.ok(confirmed.newSessionId);
  assert.equal(await app.evaluate('globalThis.__forkPosts'), 1);
  await app.evaluate('globalThis.fetch=globalThis.__sessionOriginal');
  await panel.getByRole('button', { name: '打开已确认分叉' }).press('Enter');
  await page.getByRole('heading', { name: 'Forked original', exact: true }).waitFor();
  const forked = await page.evaluate(async () => {
    const state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    return state.selection!.session.id;
  });
  assert.notEqual(forked, 's');
  const source = await page.evaluate(async (id) => {
    const value = await window.kiteNative!.request({
      method: 'messages',
      generation: 1,
      sessionId: id,
      limit: 50,
    });
    return value && 'messages' in value
      ? value.messages.find((message) => message.outputBody)
      : undefined;
  }, forked);
  assert.equal(source?.originMessage?.sessionId, 's');
  assert.equal(source?.originMessage?.storeId, storeId);
  assert.equal(source?.runId, null);
  await page.getByRole('button', { name: 'Read complete recorded Model output' }).press('Enter');
  await page.getByText('MODEL OUTPUT COMPLETE TAIL', { exact: true }).waitFor({ timeout: 30000 });
  assert.ok((await page.locator('main').innerText()).length > 17 * 1048576);
  assert.equal(await count(), 1);
  await panel.getByRole('button', { name: '读取当前会话管理事实' }).click();
  await panel.getByRole('textbox', { name: '会话管理名称' }).fill('CAS rejected name');
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__renameOriginal=original;globalThis.__renamePosts=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.method!=='POST'||!new URL(request.url).pathname.endsWith('/rename'))return original(input,init);globalThis.__renamePosts++;const body=await request.clone().json();await original(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...body,commandId:'trusted-drift',title:'Actual concurrent name'})});globalThis.fetch=original;return original(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)});};})()`,
  );
  await panel.getByRole('button', { name: '保存当前会话名称' }).press('Enter');
  await panel.getByText(/rename：failed/).waitFor();
  assert.equal(await app.evaluate('globalThis.__renamePosts'), 1);
  await panel.getByRole('button', { name: '读取当前会话管理事实' }).click();
  await panel.getByRole('textbox', { name: '会话管理名称' }).fill('Renamed fork');
  await panel.getByRole('button', { name: '保存当前会话名称' }).press('Enter');
  await page.getByRole('heading', { name: 'Renamed fork', exact: true }).waitFor();
  assert.equal(await count(), 1);
  assert.equal(
    await page.getByText('MODEL OUTPUT COMPLETE TAIL', { exact: true }).isVisible(),
    true,
  );
  await page.getByRole('button', { name: 'Close full Model output', exact: true }).click();
  await page.getByText('MODEL OUTPUT COMPLETE TAIL', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Close full Model output' }).waitFor({ state: 'hidden' });
  await panel.getByRole('button', { name: '读取当前会话管理事实' }).click();
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__deleteOriginal=original;globalThis.__deletePosts=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.method!=='POST'||!new URL(request.url).pathname.endsWith('/delete'))return original(input,init);globalThis.__deletePosts++;const body=Buffer.from(await request.arrayBuffer());const http=process.getBuiltinModule('node:http');return await new Promise((resolve,reject)=>{const outgoing=http.request(request.url,{method:'POST',headers:Object.fromEntries(request.headers)},response=>{response.destroy();outgoing.destroy();reject(new TypeError('owned_delete_response_lost'));});outgoing.on('error',reject);outgoing.end(body);});};})()`,
  );
  await panel
    .getByRole('checkbox', { name: '我确认删除此会话；服务请求取消并继续收尾，工作区文件不受影响' })
    .check();
  await panel.getByRole('button', { name: '删除当前会话' }).press('Enter');
  await panel.getByText(/delete：unknown/).waitFor();
  assert.equal(await app.evaluate('globalThis.__deletePosts'), 1);
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await panel.getByRole('button', { name: '查询原会话操作' }).press('Enter');
  await panel.getByText('已请求删除；尚未确认所有执行资源停止。', { exact: true }).waitFor();
  assert.equal(await app.evaluate('globalThis.__deletePosts'), 1);
  assert.equal(
    await page
      .getByRole('region', { name: '工作区与会话' })
      .getByRole('button', { name: 'Renamed fork', exact: true })
      .count(),
    0,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  assert.equal(await count(), 1);
  console.log(
    'Native Session finite HTTP reads',
    JSON.stringify(await app.evaluate('globalThis.__nativeRequests')),
  );
  const parent = await app.evaluate(() => process.pid),
    line = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .split('\n')
      .find((line) => {
        const parts = line.trim().split(/\s+/);
        return Number(parts[1]) === parent && parts.slice(2).join(' ') === bunExecutable;
      });
  pid = line ? Number(line.trim().split(/\s+/)[0]) : 0;
  assert.ok(pid > 0);
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  let stopped = false;
  try {
    process.kill(pid, 0);
  } catch {
    stopped = true;
  }
  assert.equal(stopped, true);
  console.log('Native Session Node assertions: 18', JSON.stringify({ pid, stopped, storeId }));
} catch (error) {
  console.error(error);
  console.error(
    'native_requests',
    await app.evaluate('globalThis.__nativeRequests').catch(() => null),
  );
  console.error(
    'native_session_panel',
    await (await app.firstWindow())
      .getByRole('region', { name: '会话管理' })
      .innerText()
      .catch(() => ''),
  );
  console.error(
    (
      await (
        await app.firstWindow()
      )
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 7000),
  );
  app.process().kill('SIGKILL');
  throw error;
} finally {
  await fetch(`${control}/release`);
  await app.close().catch(() => {});
}
