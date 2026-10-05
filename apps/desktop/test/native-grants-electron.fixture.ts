import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';

const [outdir, root, storeId, electronExecutable, control, bunExecutable] = process.argv.slice(
  2,
) as string[];
const app = await _electron.launch({
  executablePath: electronExecutable,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 10000,
});
let servicePid = 0;
const count = async () => Number(await (await fetch(`${control}/count`)).text());
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  const panel = page.getByRole('region', { name: '当前会话授权目录' });
  await panel.getByRole('button', { name: '读取当前会话授权' }).press('Enter');
  await panel.getByText(/实际会话：s；授权版本：/).waitFor();
  assert.ok((await panel.innerText()).includes('fixture.command@1'));
  assert.ok((await panel.innerText()).includes(storeId!));
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__grantOriginal=original;globalThis.__grantPosts=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.method!=='POST'||!new URL(request.url).pathname.endsWith('/sessions/s/permission-grants'))return original(input,init);globalThis.__grantPosts++;const body=Buffer.from(await request.arrayBuffer());const http=process.getBuiltinModule('node:http');return await new Promise((resolve,reject)=>{const outgoing=http.request(request.url,{method:'POST',headers:Object.fromEntries(request.headers)},response=>{response.destroy();outgoing.destroy();reject(new TypeError('owned_fixture_response_lost'));});outgoing.on('error',reject);outgoing.end(body);});};})()`,
  );
  await panel.getByRole('checkbox', { name: '我已核对实际会话与授权版本' }).check();
  await panel.getByRole('button', { name: '清除当前会话授权' }).press('Enter');
  await page.getByRole('button', { name: '查询原授权清除选择' }).waitFor();
  assert.equal(await app.evaluate('globalThis.__grantPosts'), 1);
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.getByRole('heading', { name: 'Native B', exact: true }).waitFor();
  await panel.getByRole('button', { name: '读取当前会话授权' }).press('Enter');
  await panel.getByText(/实际会话：other；授权版本：/).waitFor();
  assert.ok((await panel.innerText()).includes('fixture.command@1'));
  assert.equal(await panel.getByRole('button', { name: '清除当前会话授权' }).isEnabled(), false);
  await page.getByRole('button', { name: '查询原授权清除选择' }).press('Enter');
  await page.getByRole('button', { name: '查询原授权清除选择' }).waitFor({ state: 'hidden' });
  assert.equal(await app.evaluate('globalThis.__grantPosts'), 1);
  assert.ok((await panel.innerText()).includes('实际会话：other'));
  await app.evaluate('globalThis.fetch=globalThis.__grantOriginal');
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  await panel.getByRole('button', { name: '读取当前会话授权' }).press('Enter');
  await panel.getByText('此页没有授权记录。', { exact: true }).waitFor();
  assert.equal(await count(), 0);
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.getByRole('heading', { name: 'Native B', exact: true }).waitFor();
  await panel.getByRole('button', { name: '读取当前会话授权' }).press('Enter');
  await panel.getByText(/实际会话：other；授权版本：/).waitFor();
  // The exact observed epoch drifts in a different actual host command before this POST.
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__driftPosts=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.method!=='POST'||!new URL(request.url).pathname.endsWith('/sessions/other/permission-grants'))return original(input,init);globalThis.__driftPosts++;const body=await request.clone().json();await original(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...body,commandId:'competing-clear'})});return original(request);};})()`,
  );
  await panel.getByRole('checkbox', { name: '我已核对实际会话与授权版本' }).check();
  await panel.getByRole('button', { name: '清除当前会话授权' }).press('Enter');
  await page
    .getByText(/host_control_conflict/)
    .first()
    .waitFor();
  assert.equal(await app.evaluate('globalThis.__driftPosts'), 1);
  await app.evaluate('globalThis.fetch=globalThis.__grantOriginal');
  await panel.getByRole('button', { name: '读取当前会话授权' }).press('Enter');
  await panel.getByText('此页没有授权记录。', { exact: true }).waitFor();
  // Failed fresh read removes the previous writable projection, but not saved intent facts.
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const request=new Request(input,init);return request.method==='GET'&&new URL(request.url).pathname.endsWith('/permission-grants')?Promise.reject(new TypeError('owned_read_lost')):original(input,init);};})()`,
  );
  await panel.getByRole('button', { name: '读取当前会话授权' }).press('Enter');
  await panel.getByText('授权目录尚未核实；当前只读。', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '清除当前会话授权' }).count(), 0);
  assert.equal(await count(), 0);
  const electronPid = await app.evaluate(() => process.pid);
  const ps = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']));
  const line = ps.split('\n').find((line) => {
    const parts = line.trim().split(/\s+/);
    return Number(parts[1]) === electronPid && parts.slice(2).join(' ') === bunExecutable;
  });
  servicePid = line ? Number(line.trim().split(/\s+/)[0]) : 0;
  assert.ok(servicePid > 0);
  await app.evaluate('globalThis.fetch=globalThis.__grantOriginal');
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  let stopped = false;
  try {
    process.kill(servicePid, 0);
  } catch {
    stopped = true;
  }
  assert.equal(stopped, true);
  console.log('Native grants actual assertions: 13', JSON.stringify({ servicePid, stopped }));
} catch (error) {
  console.error(error);
  app.process().kill('SIGKILL');
  throw error;
} finally {
  await app.close().catch(() => {});
}
