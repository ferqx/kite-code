import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const { _electron } = createRequire(process.argv[11]!)('playwright') as typeof import('playwright');

const [outdir, root, electronExecutable, runId, cardId, revision, kind, ledger, workspace] =
  process.argv.slice(2) as string[];
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
async function launch() {
  console.error('native checkpoint launch');
  const app = await _electron.launch({
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  application = app;
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page
    .getByRole('button', {
      name: kind === 'report' ? 'Original report' : 'Original recovery',
      exact: true,
    })
    .click();
  await page.locator('.session-header').getByTitle('Explicit recovery', { exact: true }).waitFor();
  await openSessionTools(page);
  return { app, page };
}
async function quit(app: Awaited<ReturnType<typeof _electron.launch>>) {
  const exit = new Promise<void>((r) => app.process().once('exit', () => r()));
  await app.evaluate(({ app }) => app.quit());
  await exit;
  application = undefined;
}
try {
  let { app, page } = await launch();
  await app.evaluate(
    `(()=>{const original=globalThis.fetch,http=process.getBuiltinModule('node:http');globalThis.__recoveryPosts=0;
    globalThis.fetch=async(input,init)=>{
      const path=new URL(String(input)).pathname;
      if(init?.method!=='POST'||!(path==='/v1/sessions/s/commands'&&['run.resume','session.recover'].includes(JSON.parse(init.body).kind)||path.endsWith('/resume')))return original(input,init);
      globalThis.__recoveryPosts++;
      if(JSON.parse(init.body).kind==='session.recover'){const actual=await original(input,init);await actual.text();return new Response('{}',{status:actual.status,headers:{'content-type':'application/json'}});}
      return new Promise((resolve,reject)=>{const request=http.request(String(input),{method:'POST',headers:init.headers},response=>{const socket=response.socket;const body=new ReadableStream({start(controller){response.on('data',()=>{socket.destroy();controller.error(Error('owned_physical_response_loss'));});response.on('error',error=>controller.error(error));}});resolve(new Response(body,{status:response.statusCode,headers:{'content-type':'application/json'}}));});request.on('error',reject);request.end(init.body);});
    };})()`,
  );
  await page.getByLabel('Recovery operation', { exact: true }).selectOption(kind!);
  if (kind !== 'interrupt')
    await page.getByLabel('Original recovery ID', { exact: true }).fill(runId!);
  console.error('native checkpoint prepare');
  await page.getByRole('button', { name: 'Prepare original recovery', exact: true }).click();
  const submit = page.getByRole('button', { name: 'Submit original recovery once', exact: true });
  if (kind === 'interrupt') {
    assert.equal(await submit.isDisabled(), true);
    await page.getByLabel('Confirm orphan interruption', { exact: true }).check();
  }
  console.error('native checkpoint submit');
  await submit.click();
  await page.getByText(/Recovery (run|report|interrupt) · outcome_unknown/).waitFor();
  assert.equal(await app.evaluate('globalThis.__recoveryPosts'), 1);
  const before = (await page.evaluate(async () =>
    window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as unknown as { recoverySubmissions: { commandId: string; phase: string }[] };
  const original = before.recoverySubmissions[0]!.commandId;
  await page.evaluate(async () => {
    const bridge = window.kiteNative!,
      state = (await bridge.request({ method: 'state', generation: 1 })) as unknown as {
        recoverySubmissions: { observationId: number }[];
      };
    await Promise.all(
      [false, true].map((confirm) =>
        bridge.request({
          method: 'recovery.submit',
          generation: 1,
          observationId: state.recoverySubmissions[0]!.observationId,
          confirm,
        }),
      ),
    );
  });
  assert.equal(await app.evaluate('globalThis.__recoveryPosts'), 1);
  const children = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (fields) =>
        Number(fields[1]) === app.process().pid &&
        /\/bun(?:\.exe)?$/.test(fields.slice(2).join(' ')),
    );
  assert.equal(children.length, 1);
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  process.kill(Number(children[0]![0]), 'SIGKILL');
  app.process().kill('SIGKILL');
  await exited;
  application = undefined;
  console.error('native checkpoint cold crash');
  ({ app, page } = await launch());
  await page.getByText(/Recovery (run|report|interrupt) · outcome_unknown/).waitFor();
  const cold = (await page.evaluate(async () =>
    window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as unknown as { recoverySubmissions: { commandId: string; phase: string }[] };
  assert.equal(cold.recoverySubmissions[0]!.commandId, original);
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__coldPosts=0;globalThis.__coldGets=[];globalThis.fetch=(input,init)=>{if(init?.method==='POST')globalThis.__coldPosts++;else globalThis.__coldGets.push(new URL(String(input)).pathname);return original(input,init);};})()`,
  );
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__held=false;globalThis.__hold=new Promise(resolve=>globalThis.__releaseHold=resolve);globalThis.__holdOnce=true;globalThis.fetch=async(input,init)=>{if(globalThis.__holdOnce&&new URL(String(input)).pathname.startsWith('/v1/commands/')){globalThis.__holdOnce=false;globalThis.__held=true;await globalThis.__hold;}return original(input,init);};})()`,
  );
  await page.getByRole('button', { name: 'Lookup original recovery', exact: true }).click();
  await page.getByRole('button', { name: 'Stop recovery read', exact: true }).click();
  await app.evaluate('globalThis.__releaseHold()');
  const stopped = (await page.evaluate(async () =>
    window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as unknown as { recoverySubmissions: { phase: string }[] };
  assert.equal(stopped.recoverySubmissions[0]!.phase, 'outcome_unknown');
  await page.getByRole('button', { name: 'Lookup original recovery', exact: true }).click();
  await page
    .getByText(
      kind === 'interrupt'
        ? /Recovery interrupt · interrupted/
        : new RegExp(`Recovery ${kind} · resumed`),
    )
    .waitFor();
  assert.equal(await app.evaluate('globalThis.__coldPosts'), 0);
  assert.ok(
    ((await app.evaluate('globalThis.__coldGets')) as string[]).includes(
      `/v1/commands/${original}`,
    ),
  );
  if (kind === 'run') {
    // The fixture's second SIGKILL creates a second cold binding boundary. The old
    // GET is observational; only another explicit prepared intent resumes it.
    await page.getByLabel('Original recovery ID', { exact: true }).fill(runId!);
    await page.getByRole('button', { name: 'Prepare original recovery', exact: true }).click();
    await page.getByRole('button', { name: 'Submit original recovery once', exact: true }).click();
    await page
      .getByText(/Recovery run · resumed/)
      .nth(1)
      .waitFor();
    const fresh = (await page.evaluate(async () =>
      window.kiteNative!.request({ method: 'state', generation: 1 }),
    )) as unknown as { recoverySubmissions: { commandId: string }[] };
    assert.equal(fresh.recoverySubmissions.length, 2);
    assert.notEqual(fresh.recoverySubmissions[1]!.commandId, original);
    await page.evaluate(
      async ({ cardId, revision }) => {
        const bridge = window.kiteNative!,
          state = (await bridge.request({ method: 'state', generation: 1 })) as unknown as {
            generation: number;
          };
        await bridge.request({
          method: 'interaction.answer',
          generation: state.generation,
          interactionId: cardId!,
          revision: revision!,
          answer: { kind: 'approval', decision: 'approve' },
        });
      },
      { cardId, revision },
    );
    await page.getByText('RECOVERED_ORIGINAL_DONE', { exact: true }).waitFor();
    assert.equal(readFileSync(join(workspace!, 'effect'), 'utf8'), 'ORIGINAL_EFFECT_ONCE');
    assert.equal(readFileSync(ledger!, 'utf8'), 'decision\ncompletion\n');
  } else if (kind === 'interrupt') {
    assert.equal(existsSync(join(workspace!, 'effect')), false);
    assert.equal(readFileSync(ledger!, 'utf8'), 'decision\n');
  } else {
    await page.getByText('REPORT_ORIGINAL_CHILD_DONE', { exact: true }).waitFor();
    assert.ok(readFileSync(ledger!, 'utf8').includes('report'));
  }
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await quit(app);
  console.log('native-recovery-real-qualified', kind, original);
} catch (error) {
  console.error(error);
  if (application) {
    console.error(
      (await (await application.firstWindow()).locator('body').innerText()).slice(0, 6000),
    );
    application.process().kill('SIGKILL');
    application = undefined;
  }
  throw error;
} finally {
  if (application) await application.close();
}
