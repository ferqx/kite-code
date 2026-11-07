import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { NativeCallerMetadata, NativeDraft, NativeState } from '../src/native-bridge';
import { readNativeCallerRequest } from './native-caller-body.fixture';

async function observedState(
  page: import('playwright').Page,
  accepts: (state: NativeState) => boolean,
): Promise<NativeState> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = (await page.evaluate(async () =>
      window.kiteNative!.request({ method: 'state', generation: 1 }),
    )) as NativeState;
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw Error('native_caller_observation_timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [outdir, root, electronExecutable, requestJson, corePath, workspace, packagePath] =
  process.argv.slice(2) as string[];
const { _electron } = createRequire(packagePath!)('playwright') as typeof import('playwright');
const input = JSON.parse(readFileSync(requestJson!, 'utf8')),
  base = `${root}-native-caller-window-${input.kind}`;
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let renderer: import('playwright').Page | undefined;
async function launch(cold = false) {
  const app = await _electron.launch({
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'caller-electron-data')}`],
    cwd: outdir,
    env: { ...process.env, HOME: process.env.HOME!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  application = app;
  writeFileSync(`${base}.pid.json`, JSON.stringify({ pid: app.process().pid }));
  console.error('caller checkpoint launch', app.process().pid);
  if (cold) {
    // Keep later original-ID reads pending until the first real loss is observed.
    // Automatic recovery may issue that first GET before a manual click.
    await app.evaluate(`(() => {
      const original = globalThis.fetch, http = process.getBuiltinModule('node:http');
      let first = true;
      const laterReads = new Promise(resolve => { globalThis.__releaseColdLookups = resolve; });
      globalThis.__callerPosts = 0;
      globalThis.__callerPostRequests = [];
      globalThis.__callerGets = [];
      globalThis.__callerFirstGetLost = false;
      globalThis.fetch = async (url, init) => {
        const method = init?.method ?? 'GET', path = new URL(String(url)).pathname;
        if (method === 'POST') {
          const body = JSON.parse(init.body);
          globalThis.__callerPostRequests.push({ path, body });
          if (body.commandId === ${JSON.stringify(input.commandId)}) globalThis.__callerPosts++;
        }
        if (method !== 'GET' || path !== ${JSON.stringify(`/v1/commands/${input.commandId}`)})
          return original(url, init);
        globalThis.__callerGets.push(path);
        if (!first) { await laterReads; return original(url, init); }
        first = false;
        return new Promise((resolve, reject) => {
          const request = http.request(String(url), { method: 'GET', headers: init?.headers }, response => {
            const socket = response.socket;
            const body = new ReadableStream({ start(controller) {
              response.on('data', () => {
                globalThis.__callerFirstGetLost = true;
                socket.destroy();
                controller.error(Error('owned_first_get_loss'));
              });
              response.on('error', error => controller.error(error));
            }});
            resolve(new Response(body, { status: response.statusCode, headers: { 'content-type': 'application/json' } }));
          });
          request.on('error', reject);
          request.end();
        });
      };
    })()`);
  }
  const rendererURL = pathToFileURL(join(outdir!, 'index.html')).href;
  const page =
    app.windows().find((page) => page.url() === rendererURL) ??
    (await app.waitForEvent('window', {
      predicate: (page) => page.url() === rendererURL,
      timeout: 15000,
    }));
  renderer = page;
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'Original recovery', exact: true }).click();
  await page.locator('.session-header').getByTitle('Original recovery', { exact: true }).waitFor();
  await observedState(
    page,
    (state) => state.selection?.session.id === 's' && !state.selection.viewLoading,
  );
  await page.locator('[role="textbox"][aria-label="当前会话私有草稿"]').waitFor();
  await openSessionTools(page);
  // Assert the same complete Main snapshot that satisfied the readiness check.
  const ready = await observedState(
    page,
    (state) => state.selection?.session.id === 's' && !state.selection.viewLoading,
  );
  assert.equal(ready.selection?.session.id, 's');
  assert.equal(ready.selection?.viewLoading, false);
  return { app, page };
}
const rows = (commandId: string = input.commandId) => {
  const db = new DatabaseSync(corePath!, { readOnly: true });
  try {
    return {
      commands: db
        .prepare(
          'SELECT id,kind,status,subject_id,request_digest,receipt_json FROM command WHERE id=?',
        )
        .all(commandId),
      runs: db
        .prepare(
          'SELECT id,origin_command_id,status,is_active,initialization_state,reason FROM run',
        )
        .all(),
      executions: db
        .prepare(
          'SELECT id,run_id,kind,adapter_id,state,dispatched,result_json,cancel_requested_at FROM execution',
        )
        .all(),
    };
  } finally {
    db.close();
  }
};
try {
  let { app, page } = await launch();
  let steerApproval: { id: string; revision: string } | undefined;
  if (input.kind === 'input.steer') {
    // Selection reconciles the seeded orphan. Steering needs a live owner, so
    // explicitly resume this same original Run before preparing its exact input.
    await page.getByLabel('Recovery operation', { exact: true }).selectOption('run');
    await page.getByLabel('Original recovery ID', { exact: true }).fill(input.targetRunId);
    await page.getByRole('button', { name: 'Prepare original recovery', exact: true }).click();
    await page.getByRole('button', { name: 'Submit original recovery once', exact: true }).click();
    await page.getByText(/Recovery run · resumed/).waitFor();
    const live = await observedState(page, (value) => {
      const selected = value.selection;
      return (
        selected?.session.id === 's' &&
        selected.runs.some((run) => run.id === input.targetRunId && run.isActive) &&
        selected.interactions.some(
          (card) => card.runId === input.targetRunId && card.state === 'pending',
        )
      );
    });
    assert.equal(live.selection!.runs.find((run) => run.id === input.targetRunId)!.isActive, true);
    assert.equal(typeof live.selection!.session.contextSelectionId, 'string');
    input.contextSelectionId = live.selection!.session.contextSelectionId;
    const card = live.selection!.interactions.find(
      (card) => card.runId === input.targetRunId && card.state === 'pending',
    )!;
    assert.equal(card.definitionId, 'files.write');
    steerApproval = { id: card.id, revision: card.revision };
  }
  let siblingId: string | undefined;
  let parentBusiness: { runId: string; businessCommandId: string } | undefined;
  if (input.kind === 'execution.cancel') {
    await page.evaluate(async (expectedStoreId) => {
      const request = {
        kind: 'run.start' as const,
        expectedStoreId,
        commandId: 'native-jobs-parent',
        content: 'New task: two explicitly configured independent jobs',
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
            (r) => r.rootWorkCommandId === 'native-jobs-parent' && r.status === 'completed',
          ) &&
          state.selection.executions.filter((e) => e.kind === 'job' && e.status === 'running')
            .length === 2
        )
          return state;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error('owned_jobs_fresh_scope_unavailable');
    });
    const applied = (await page.evaluate(
      async () =>
        await window.kiteNative!.request({
          method: 'caller.lookup',
          generation: 1,
          commandId: 'native-jobs-parent',
        }),
    )) as NativeCallerMetadata;
    assert.equal(applied.request.commandId, 'native-jobs-parent');
    assert.equal(applied.phase, 'applied');
    const commands = rows('native-jobs-parent').commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.status, 'applied');
    const receipt = JSON.parse(String(commands[0]!.receipt_json)) as {
      runId: string;
    };
    parentBusiness = { runId: receipt.runId, businessCommandId: applied.request.commandId };
    assert.ok(
      state.selection!.runs.some(
        (run) =>
          run.id === receipt.runId &&
          run.originCommandId === applied.request.commandId &&
          run.rootWorkCommandId === applied.request.commandId &&
          run.status === 'completed',
      ),
    );
    const jobs = state.selection!.executions.filter(
      (e) => e.kind === 'job' && e.status === 'running',
    );
    assert.equal(jobs.length, 2);
    input.executionId = jobs[0]!.id;
    siblingId = jobs[1]!.id;
  }
  // Hold warm automatic lookups for steer until this process is killed. The
  // original batch may finish, but this case must retain an unknown caller row
  // so the cold original-ID lookup, rather than a warm GET, resolves the loss.
  await app.evaluate(
    `(()=>{const original=globalThis.fetch,http=process.getBuiltinModule('node:http');globalThis.__callerPosts=0;globalThis.__callerGets=[];globalThis.fetch=async(url,init)=>{const path=new URL(String(url)).pathname;if(${JSON.stringify(input.kind === 'input.steer')}&&(init?.method??'GET')==='GET'&&path===${JSON.stringify(`/v1/commands/${input.commandId}`)})return new Promise(()=>{});if(init?.method!=='POST'||path!=='/v1/sessions/s/commands'||JSON.parse(init.body).commandId!==${JSON.stringify(input.commandId)})return original(url,init);globalThis.__callerPosts++;return new Promise((resolve,reject)=>{const request=http.request(String(url),{method:'POST',headers:init.headers},response=>{const socket=response.socket;const body=new ReadableStream({start(controller){response.on('data',()=>{socket.destroy();controller.error(Error('owned_physical_response_loss'));});response.on('error',error=>controller.error(error));}});resolve(new Response(body,{status:response.statusCode,headers:{'content-type':'application/json'}}));});request.on('error',reject);request.end(init.body);});};})()`,
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
  const executionIdsBeforeSubmit = new Set(rows().executions.map((row) => row.id));
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
  if (steerApproval) {
    // Steer waits behind the original ordinary Tool batch. Answer its original
    // Files approval; the new input must not retire, bypass or replay that Tool.
    await observedState(page, (state) =>
      state.selection!.interactions.some(
        (card) =>
          card.id === steerApproval!.id &&
          card.revision === steerApproval!.revision &&
          card.state === 'pending',
      ),
    );
    await page.evaluate(async ({ id, revision }) => {
      await window.kiteNative!.request({
        method: 'interaction.answer',
        generation: 1,
        interactionId: id,
        revision,
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
    }, steerApproval);
  }
  if (input.kind === 'input.follow_up' || input.kind === 'input.steer') {
    // Capture the original input's first legitimate dispatch before crashing:
    // the steer has completed its successor Model; follow-up holds its own Model.
    // The cold ID comparison then isolates replay from initial scheduling.
    const deadline = Date.now() + 15000;
    for (;;) {
      const facts = rows();
      const originalRun = facts.runs.find((run) =>
        input.kind === 'input.steer'
          ? run.id === input.targetRunId
          : run.origin_command_id === input.commandId,
      );
      if (
        originalRun &&
        facts.executions.some(
          (execution) =>
            execution.run_id === originalRun.id &&
            execution.kind === 'model' &&
            (input.kind === 'input.steer'
              ? originalRun.status === 'completed' && execution.state === 'succeeded'
              : execution.state === 'dispatching' && execution.dispatched === 1) &&
            !executionIdsBeforeSubmit.has(execution.id),
        )
      )
        break;
      if (Date.now() >= deadline) throw Error('original_input_model_not_started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (input.kind === 'input.steer') {
      assert.equal(readFileSync(join(workspace!, 'effect'), 'utf8'), 'ORIGINAL_EFFECT_ONCE');
      const writes = rows().executions.filter(
        (execution) =>
          execution.run_id === input.targetRunId && execution.adapter_id === 'files.write',
      );
      assert.equal(writes.length, 1);
      assert.equal(writes[0]!.state, 'succeeded');
    }
  }
  if (siblingId) {
    const originalParent = parentBusiness;
    assert.ok(originalParent);
    const facts = rows();
    const a = facts.executions.find((e) => e.id === input.executionId),
      b = facts.executions.find((e) => e.id === siblingId);
    assert.ok(a);
    assert.notEqual(a.cancel_requested_at, null);
    assert.equal(b?.cancel_requested_at, null);
    assert.equal(b?.state, 'running');
    assert.equal(
      facts.runs.filter(
        (r) =>
          r.id === originalParent.runId &&
          r.origin_command_id === originalParent.businessCommandId &&
          r.status === 'completed',
      ).length,
      1,
    );
  }
  console.error('caller checkpoint original body verified');
  const savedCaller = (await page.evaluate(async () =>
    window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  assert.equal(
    savedCaller.callerSubmissions?.find((row) => row.request.commandId === input.commandId)?.phase,
    'unknown',
  );
  const before = (await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  assert.equal(JSON.stringify(before).includes(input.content ?? '__absent__'), false);
  const beforeFacts = rows();
  console.error('caller original crash snapshot', JSON.stringify(beforeFacts));
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
  ({ app, page } = await launch(true));
  console.error('caller checkpoint cold state');
  const cold = (await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  assert.equal(cold.inputSubmissions.length, 0);
  assert.equal(
    cold.callerSubmissions?.find((r) => r.request.commandId === input.commandId)?.phase,
    'unknown',
  );
  if (!(await app.evaluate('globalThis.__callerFirstGetLost'))) {
    console.error('caller checkpoint first original GET click');
    await page
      .getByRole('button', { name: `只查原申请 · ${input.commandId}`, exact: true })
      .click();
  }
  await app.evaluate(async () => {
    const fault = globalThis as typeof globalThis & { __callerFirstGetLost: boolean };
    const deadline = Date.now() + 15000;
    while (!fault.__callerFirstGetLost) {
      if (Date.now() >= deadline) throw Error('original_first_get_loss_not_observed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await page.getByText(new RegExp(`原申请 ${input.commandId}.*unknown`)).waitFor();
  await observedState(
    page,
    (state) =>
      state.callerSubmissions?.find((row) => row.request.commandId === input.commandId)?.phase ===
      'unknown',
  );
  assert.equal(await app.evaluate('globalThis.__callerFirstGetLost'), true);
  assert.equal(await app.evaluate('globalThis.__callerPosts'), 0);
  await app.evaluate('globalThis.__releaseColdLookups()');
  console.error('caller checkpoint original GET click');
  await page.getByRole('button', { name: `只查原申请 · ${input.commandId}`, exact: true }).click();
  await page
    .getByText(new RegExp(`原申请 ${input.commandId}.*(applied|accepted|rejected)`))
    .waitFor();
  assert.equal(await app.evaluate('globalThis.__callerPosts'), 0);
  const gets = (await app.evaluate('globalThis.__callerGets')) as string[];
  const coldPosts = (await app.evaluate('globalThis.__callerPostRequests')) as {
    path: string;
    body: { commandId: string; expectedStoreId: string; expectedOwnerGeneration: string };
  }[];
  // Session selection performs its normal lifecycle reconciliation. This is
  // separate from the caller mutation, which must never be submitted again.
  assert.ok(coldPosts.length <= 1);
  for (const post of coldPosts) {
    assert.equal(post.path, '/v1/sessions/s/reconcile');
    assert.equal(post.body.expectedStoreId, input.expectedStoreId);
    assert.deepEqual(Object.keys(post.body).sort(), [
      'commandId',
      'expectedOwnerGeneration',
      'expectedStoreId',
    ]);
    assert.match(post.body.expectedOwnerGeneration, /^\d+$/);
    assert.equal(
      post.body.commandId,
      `session-reconcile-${createHash('sha256')
        .update(JSON.stringify([input.expectedStoreId, 's', post.body.expectedOwnerGeneration]))
        .digest('hex')}`,
    );
  }
  // The renderer may also reconcile the saved unknown row after its cold
  // selection completes. Every read must still query this one original ID.
  assert.ok(gets.length >= 2 && gets.length <= 3);
  assert.ok(gets.every((path) => path === `/v1/commands/${input.commandId}`));
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
      coldPosts,
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
  console.error('caller original persistent facts', JSON.stringify(rows()));
  if (renderer && !renderer.isClosed())
    console.error((await renderer.locator('body').innerText()).slice(-15000));
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
