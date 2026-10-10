import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

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
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill('first harmless ledger');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  await page.getByText('NATIVE FIRST COMPLETED', { exact: true }).first().waitFor();
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  await fetch(`${control}/release-job`);
  await page.waitForFunction(async () => {
    const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
    return (
      state &&
      'generation' in state &&
      state.selection?.executions.some(
        (execution) =>
          execution.definitionId === 'fixture.ledger' &&
          execution.status === 'succeeded' &&
          execution.delivery === 'pending',
      )
    );
  });
  const context = page.getByRole('region', { name: '当前所选上下文' });
  await context.getByRole('button', { name: '读取当前所选上下文' }).press('Enter');
  const selected = page.getByRole('region', { name: 'Selected context' });
  await selected.getByText(/Context selection/).waitFor();
  assert.equal(await selected.getByText(/^Source /).count(), 0);
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__contextOriginal=original;globalThis.__contextPosts=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.method!=='POST'||!new URL(request.url).pathname.endsWith('/sessions/s/context/select'))return original(input,init);globalThis.__contextPosts++;const body=Buffer.from(await request.arrayBuffer());const http=process.getBuiltinModule('node:http');return await new Promise((resolve,reject)=>{const outgoing=http.request(request.url,{method:'POST',headers:Object.fromEntries(request.headers)},response=>{response.destroy();outgoing.destroy();reject(new TypeError('owned_context_response_lost'));});outgoing.on('error',reject);outgoing.end(body);});};})()`,
  );
  await selected
    .getByRole('button', { name: 'Rewind to empty selected history' })
    .click({ trial: true });
  await selected.getByRole('button', { name: 'Rewind to empty selected history' }).press('Enter');
  await context.getByText(/Context rewind unknown/).waitFor();
  assert.equal(await app.evaluate('globalThis.__contextPosts'), 1);
  await context.getByRole('button', { name: '查询原上下文命令' }).press('Enter');
  await context.getByText(/Context rewind applied/).waitFor();
  assert.equal(await app.evaluate('globalThis.__contextPosts'), 1);
  await app.evaluate('globalThis.fetch=globalThis.__contextOriginal');
  await context.getByRole('button', { name: '读取当前所选上下文' }).press('Enter');
  await selected
    .getByText('Excluded by Rewind; it remains history until explicitly included.', { exact: true })
    .waitFor();
  assert.equal(await selected.getByText(/^Source /).count(), 0);
  assert.equal(Number(await (await fetch(`${control}/count`)).text()), 2);
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill('second active checkpoint');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  await fetch(`${control}/third-entered`);
  await context.getByRole('button', { name: '读取当前所选上下文' }).press('Enter');
  await selected.getByText(/Include target Run:/).waitFor();
  const original = await page.evaluate(async () => {
    const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
    return state && 'generation' in state
      ? state.selection?.runs.find((run) => run.isActive)?.id
      : undefined;
  });
  assert.ok(original);
  await selected
    .getByRole('button', { name: 'Include this exact historical result' })
    .press('Enter');
  await context.getByText(/Context include queued/).waitFor();
  assert.equal(Number(await (await fetch(`${control}/count`)).text()), 3);
  await fetch(`${control}/release-third`);
  await page.getByText('NATIVE INCLUDED COMPLETED', { exact: true }).first().waitFor();
  await context.getByRole('button', { name: '查询原上下文命令' }).press('Enter');
  await context.getByText(/Context include applied/).waitFor();
  await context.getByRole('button', { name: '读取当前所选上下文' }).press('Enter');
  await selected.getByText(/Source .*explicit/).waitFor();
  const messages = (await (await fetch(`${control}/requests`)).json()) as {
    messages: { content: string; sourceIds?: string[] }[];
  }[];
  assert.equal(messages.length, 4);
  assert.equal(
    messages[2]!.messages.some((message) => message.content.includes('NATIVE_JOB_COMPLETE_BODY')),
    false,
  );
  const result = messages[3]!.messages.find((message) =>
    message.content.includes('NATIVE_JOB_COMPLETE_BODY'),
  );
  assert.ok(result?.sourceIds?.length === 1);
  assert.ok((await selected.innerText()).includes(result!.sourceIds![0]!));
  assert.equal(Number(await (await fetch(`${control}/effects`)).text()), 1);
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  assert.equal(Number(await (await fetch(`${control}/count`)).text()), 4);
  const electronPid = await app.evaluate(() => process.pid),
    ps = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']));
  const line = ps.split('\n').find((line) => {
    const parts = line.trim().split(/\s+/);
    return Number(parts[1]) === electronPid && parts.slice(2).join(' ') === bunExecutable;
  });
  servicePid = line ? Number(line.trim().split(/\s+/)[0]) : 0;
  assert.ok(servicePid > 0);
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
  console.log(
    'Native Context Node assertions: 15',
    JSON.stringify({ servicePid, stopped, storeId }),
  );
} catch (error) {
  console.error(error);
  console.error(
    'native_context_direct',
    await (await app.firstWindow()).evaluate(async () => {
      try {
        return await window.kiteNative!.request({
          method: 'context.read',
          generation: 1,
          sessionId: 's',
          readId: crypto.randomUUID(),
        });
      } catch (cause) {
        return { code: (cause as { code?: string }).code, message: (cause as Error).message };
      }
    }),
  );
  console.error(
    'native_context_page',
    (
      await (
        await app.firstWindow()
      )
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 7500),
  );
  console.error('native_context_requests', await (await fetch(`${control}/requests`)).text());
  app.process().kill('SIGKILL');
  throw error;
} finally {
  await fetch(`${control}/release-third`);
  await app.close().catch(() => {});
}
