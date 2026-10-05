import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NativeCallerMetadata, NativeDraft, NativeState } from '../src/native-bridge';
import { readNativeCallerRequest } from './native-caller-body.fixture';

const [outdir, root, electronExecutable, requestJson, corePath, , packagePath] = process.argv.slice(
  2,
) as string[];
const { _electron } = createRequire(packagePath!)('playwright') as typeof import('playwright');
const input = JSON.parse(readFileSync(requestJson!, 'utf8')),
  base = `${root}-native-caller-window-${input.kind}`;
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
async function launch() {
  const app = await _electron.launch({
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'caller-electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  application = app;
  writeFileSync(`${base}.pid.json`, JSON.stringify({ pid: app.process().pid }));
  console.error('caller checkpoint launch', app.process().pid);
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'Original recovery', exact: true }).click();
  await page.getByRole('heading', { name: '持久原申请', exact: true }).waitFor();
  const ready = (await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  assert.equal(ready.selection?.session.id, 's');
  assert.equal(ready.selection?.viewLoading, false);
  return { app, page };
}
const rows = () => {
  const db = new DatabaseSync(corePath!, { readOnly: true });
  try {
    return {
      commands: db
        .prepare(
          'SELECT id,kind,status,subject_id,request_digest,receipt_json FROM command WHERE id=?',
        )
        .all(input.commandId),
      runs: db.prepare('SELECT id,origin_command_id,status FROM run').all(),
      executions: db.prepare('SELECT id,kind,state,cancel_requested_at FROM execution').all(),
    };
  } finally {
    db.close();
  }
};
try {
  let { app, page } = await launch();
  let siblingId: string | undefined;
  if (input.kind === 'execution.cancel') {
    await page.evaluate(async (expectedStoreId) => {
      const request = {
        kind: 'run.start' as const,
        expectedStoreId,
        commandId: 'native-jobs-parent',
        content: 'two explicitly configured independent jobs',
      };
      await window.kiteNative!.request({
        method: 'caller.prepare',
        generation: 1,
        sessionId: 's',
        intent: request,
      });
      await window.kiteNative!.request({
        method: 'caller.submit',
        generation: 1,
        commandId: request.commandId,
      });
    }, input.expectedStoreId);
    const state = await page.evaluate(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = (await window.kiteNative!.request({
          method: 'state',
          generation: 1,
        })) as NativeState;
        if (
          state.selection?.runs.some(
            (r) => r.originCommandId === 'native-jobs-parent' && r.status === 'completed',
          ) &&
          state.selection.executions.filter((e) => e.kind === 'job' && e.status === 'running')
            .length === 2
        )
          return state;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error('owned_jobs_fresh_scope_unavailable');
    });
    const jobs = state.selection!.executions.filter(
      (e) => e.kind === 'job' && e.status === 'running',
    );
    assert.equal(jobs.length, 2);
    input.executionId = jobs[0]!.id;
    siblingId = jobs[1]!.id;
  }
  await app.evaluate(
    `(()=>{const original=globalThis.fetch,http=process.getBuiltinModule('node:http');globalThis.__callerPosts=0;globalThis.__callerGets=[];globalThis.fetch=async(url,init)=>{const path=new URL(String(url)).pathname;if(init?.method!=='POST'||path!=='/v1/sessions/s/commands'||JSON.parse(init.body).commandId!==${JSON.stringify(input.commandId)})return original(url,init);globalThis.__callerPosts++;return new Promise((resolve,reject)=>{const request=http.request(String(url),{method:'POST',headers:init.headers},response=>{const socket=response.socket;const body=new ReadableStream({start(controller){response.on('data',()=>{socket.destroy();controller.error(Error('owned_physical_response_loss'));});response.on('error',error=>controller.error(error));}});resolve(new Response(body,{status:response.statusCode,headers:{'content-type':'application/json'}}));});request.on('error',reject);request.end(init.body);});};})()`,
  );
  let draft: { id: string; revision: string; textDigest: string } | undefined;
  if (input.kind === 'input.steer') {
    const saved = (await page.evaluate(async (input) => {
      const current = (await window.kiteNative!.request({
        method: 'draft.read',
        generation: 1,
        sessionId: 's',
      })) as NativeDraft;
      return await window.kiteNative!.request({
        method: 'draft.write',
        generation: 1,
        sessionId: 's',
        revision: current.revision,
        content: input.content,
      });
    }, input)) as NativeDraft;
    draft = {
      id: saved.id,
      revision: String(saved.revision),
      textDigest: createHash('sha256').update(saved.content).digest('hex'),
    };
  }
  console.error('caller checkpoint submit');
  const metadata = (await page.evaluate(
    async ({ input, draft }) => {
      await window.kiteNative!.request({
        method: 'caller.prepare',
        generation: 1,
        sessionId: 's',
        intent: input,
        ...(draft ? { draft } : {}),
      });
      if (draft)
        await window.kiteNative!.request({
          method: 'draft.write',
          generation: 1,
          sessionId: 's',
          revision: Number(draft.revision),
          content: 'later edited 草稿🙂\r\n',
        });
      return await window.kiteNative!.request({
        method: 'caller.submit',
        generation: 1,
        commandId: input.commandId,
      });
    },
    { input, draft },
  )) as NativeCallerMetadata;
  assert.equal(metadata.phase, 'unknown');
  assert.equal(metadata.request.commandId, input.commandId);
  assert.equal(await app.evaluate('globalThis.__callerPosts'), 1);
  assert.deepEqual(await readNativeCallerRequest(page, 1, input.commandId), input);
  assert.equal(rows().commands.length, 1);
  if (siblingId) {
    const facts = rows();
    const a = facts.executions.find((e) => e.id === input.executionId),
      b = facts.executions.find((e) => e.id === siblingId);
    assert.ok(a);
    assert.notEqual(a.cancel_requested_at, null);
    assert.equal(b?.cancel_requested_at, null);
    assert.equal(b?.state, 'running');
    assert.equal(
      facts.runs.filter(
        (r) => r.origin_command_id === 'native-jobs-parent' && r.status === 'completed',
      ).length,
      1,
    );
  }
  console.error('caller checkpoint original body verified');
  const before = (await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  assert.equal(JSON.stringify(before).includes(input.content ?? '__absent__'), false);
  const beforeFacts = rows();
  writeFileSync(`${base}.before.json`, JSON.stringify({ metadata, facts: beforeFacts }));
  const children = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(
      (f) => Number(f[1]) === app.process().pid && /\/bun(?:\.exe)?$/.test(f.slice(2).join(' ')),
    );
  assert.equal(children.length, 1);
  const servicePid = Number(children[0]![0]);
  process.kill(servicePid, 'SIGKILL');
  app.process().kill('SIGKILL');
  await new Promise<void>((r) => app.process().once('exit', () => r()));
  application = undefined;
  console.error('caller checkpoint cold launch');
  ({ app, page } = await launch());
  await app.evaluate(
    `(()=>{const original=globalThis.fetch,http=process.getBuiltinModule('node:http');let drop=true;globalThis.__callerPosts=0;globalThis.__callerGets=[];globalThis.fetch=async(url,init)=>{const method=init?.method??'GET',path=new URL(String(url)).pathname;if(method==='POST')globalThis.__callerPosts++;if(method!=='GET'||path!==${JSON.stringify(`/v1/commands/${input.commandId}`)})return original(url,init);globalThis.__callerGets.push(path);if(!drop)return original(url,init);drop=false;return new Promise((resolve,reject)=>{const request=http.request(String(url),{method:'GET',headers:init?.headers},response=>{const socket=response.socket;const body=new ReadableStream({start(controller){response.on('data',()=>{socket.destroy();controller.error(Error('owned_first_get_loss'));});response.on('error',error=>controller.error(error));}});resolve(new Response(body,{status:response.statusCode,headers:{'content-type':'application/json'}}));});request.on('error',reject);request.end();});};})()`,
  );
  console.error('caller checkpoint cold state');
  const cold = (await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  assert.equal(cold.inputSubmissions.length, 0);
  assert.equal(
    cold.callerSubmissions?.find((r) => r.request.commandId === input.commandId)?.phase,
    'unknown',
  );
  console.error('caller checkpoint original GET click');
  await page.getByRole('button', { name: `只查原申请 · ${input.commandId}`, exact: true }).click();
  await page.getByText(new RegExp(`原申请 ${input.commandId}.*unknown`)).waitFor();
  assert.equal(await app.evaluate('globalThis.__callerPosts'), 0);
  console.error('caller checkpoint original GET click');
  await page.getByRole('button', { name: `只查原申请 · ${input.commandId}`, exact: true }).click();
  await page
    .getByText(new RegExp(`原申请 ${input.commandId}.*(applied|accepted|rejected)`))
    .waitFor();
  assert.equal(await app.evaluate('globalThis.__callerPosts'), 0);
  const gets = (await app.evaluate('globalThis.__callerGets')) as string[];
  assert.deepEqual(gets, [`/v1/commands/${input.commandId}`, `/v1/commands/${input.commandId}`]);
  const afterFacts = rows();
  assert.equal(afterFacts.commands.length, 1);
  assert.deepEqual(
    afterFacts.runs.map((row) => row.id).sort(),
    beforeFacts.runs.map((row) => row.id).sort(),
  );
  assert.deepEqual(
    afterFacts.executions.map((row) => row.id).sort(),
    beforeFacts.executions.map((row) => row.id).sort(),
  );
  await page.getByRole('button', { name: `原完整请求 · ${input.commandId}`, exact: true }).click();
  await page.getByLabel('原申请全文', { exact: true }).waitFor();
  const body = await page.getByLabel('原申请全文', { exact: true }).textContent();
  assert.deepEqual(JSON.parse(body!), input);
  assert.equal(createHash('sha256').update(body!).digest('hex'), metadata.bodyDigest);
  if (draft) {
    const retained = (await page.evaluate(
      async (draft) =>
        await window.kiteNative!.request({
          method: 'draft.original',
          generation: 1,
          draftId: draft.id,
        }),
      draft,
    )) as NativeDraft;
    assert.equal(retained.content, 'later edited 草稿🙂\r\n');
    assert.equal(retained.revision, Number(draft.revision) + 1);
  }
  const privateDb = join(root!, 'data', 'owned', 'desktop-private', 'data.sqlite');
  writeFileSync(`${base}.sqlite`, readFileSync(privateDb));
  writeFileSync(
    `${base}.after.json`,
    JSON.stringify({
      facts: rows(),
      siblingId,
      originalRequest: input,
      gets,
      posts: await app.evaluate('globalThis.__callerPosts'),
    }),
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await app.close();
  application = undefined;
  console.log('native-caller-window-qualified', input.kind, base);
} catch (error) {
  console.error('caller primary error', error);
  if (application) {
    const page = await application.firstWindow();
    console.error((await page.locator('body').innerText()).slice(-15000));
  }
  throw error;
} finally {
  if (application) {
    await application
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
    await application.close();
  }
}
